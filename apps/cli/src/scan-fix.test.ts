import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGitHubClient } from "@buildhound/github";
import { ALL_RULES, makeContext, planFixes, runRules } from "@buildhound/core";
import type { FixGroup } from "@buildhound/core";
import { fixCommand, runScanFix } from "./commands/scan-fix";
import type { ScanFixResult } from "./commands/scan-fix";
import { FakeGitHub } from "./lib/fake-github";
import { openFixPullRequest, readBase } from "./lib/fix-pr";
import { CliError } from "./output";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
const ios = readFileSync(path.join(fixtures, ".github", "workflows", "ios.yml"), "utf8");
const nightly = readFileSync(path.join(fixtures, ".github", "workflows", "nightly.yml"), "utf8");
const FILES = { ".github/workflows/ios.yml": ios, ".github/workflows/nightly.yml": nightly, "README.md": "# app\n" };

const client = (fake: FakeGitHub) => createGitHubClient({ token: "t", baseUrl: "https://fake.github.test", fetch: fake.fetch, sleep: async () => {} });

async function groups(files: Record<string, string>, ruleIds?: string[], onePr = false): Promise<FixGroup[]> {
  const workflows = Object.entries(files).filter(([p]) => p.startsWith(".github/workflows/")).map(([p, content]) => ({ path: p, content }));
  const repository = { fullName: "acme/app", private: true, defaultBranch: "main" };
  const findings = [];
  for (const w of workflows) findings.push(...(await runRules(ALL_RULES, makeContext({ path: w.path, content: w.content, repository }))));
  return planFixes(findings, { workflows, repository, history: null, rules: ALL_RULES }, { only: ruleIds, onePr }).groups;
}

describe("scan --fix: the GitHub API sequence", () => {
  it("creates the branch from the default branch's head, one commit, then the pull request", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const gh = client(fake);
    const base = await readBase(gh, "acme", "app", "main");
    const [g] = await groups(FILES, ["R06"]);
    const out = await openFixPullRequest(gh, "acme", "app", base, g!);
    expect(out).toMatchObject({ branch: "buildhound/fix-r06-no-timeout", status: "created", number: 1, url: "https://github.com/acme/app/pull/1" });
    expect(fake.writes()).toEqual(["POST /repos/acme/app/git/trees", "POST /repos/acme/app/git/commits", "POST /repos/acme/app/git/refs", "POST /repos/acme/app/pulls"]);
    // The commit sits on the default branch's head, carries Buildhound's trailer, and changes only the fixed files.
    const head = fake.commits.get(fake.refs.get("buildhound/fix-r06-no-timeout")!)!;
    expect(head.parents).toEqual([base.sha]);
    expect(head.message).toMatch(/^ci: apply the Buildhound fix for R06 \(no-timeout\)\n[\s\S]*Buildhound-Fix: R06$/);
    expect(fake.fileAt("buildhound/fix-r06-no-timeout", ".github/workflows/ios.yml")).toBe(g!.files.find((f) => f.path.endsWith("ios.yml"))!.after);
    expect(fake.fileAt("buildhound/fix-r06-no-timeout", "README.md")).toBe("# app\n");
    expect(fake.fileAt("main", ".github/workflows/ios.yml")).toBe(ios);
    const pr = fake.pulls[0]!;
    expect(pr).toMatchObject({ head: "buildhound/fix-r06-no-timeout", base: "main", title: "Fix: Job without timeout-minutes", state: "open" });
    expect(pr.body).toBe(g!.body);
  });

  it("is idempotent: a rerun with the same fix writes nothing, even after the default branch moves on", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const gh = client(fake);
    const [g] = await groups(FILES, ["R06"]);
    await openFixPullRequest(gh, "acme", "app", await readBase(gh, "acme", "app", "main"), g!);
    const before = fake.writes().length;
    fake.commitToDefault({ "README.md": "# app, renamed\n" });
    const again = await openFixPullRequest(gh, "acme", "app", await readBase(gh, "acme", "app", "main"), g!);
    expect(again).toMatchObject({ status: "unchanged", number: 1, note: "already open with this fix" });
    expect(fake.writes()).toHaveLength(before);
    expect(fake.pulls).toHaveLength(1);
  });

  it("updates its own branch and the open pull request when the fix changed, never opening a second one", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const gh = client(fake);
    const [first] = await groups(FILES, ["R06"]);
    await openFixPullRequest(gh, "acme", "app", await readBase(gh, "acme", "app", "main"), first!);
    // Someone gives nightly.yml a timeout by hand, so the fix now only touches ios.yml.
    const moved = { ...FILES, ".github/workflows/nightly.yml": nightly.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    timeout-minutes: 10\n") };
    fake.commitToDefault(moved);
    const [second] = await groups(moved, ["R06"]);
    const base = await readBase(gh, "acme", "app", "main");
    const writes = fake.writes().length;
    const out = await openFixPullRequest(gh, "acme", "app", base, second!);
    expect(out).toMatchObject({ status: "updated", number: 1 });
    expect(fake.writes().slice(writes)).toEqual(["POST /repos/acme/app/git/trees", "POST /repos/acme/app/git/commits", "PATCH /repos/acme/app/git/refs/heads/buildhound/fix-r06-no-timeout", "PATCH /repos/acme/app/pulls/1"]);
    expect(fake.commits.get(fake.refs.get("buildhound/fix-r06-no-timeout")!)!.parents).toEqual([base.sha]);
    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0]!.body).toBe(second!.body);
  });

  it("leaves a branch alone when its head is a commit Buildhound did not make", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const gh = client(fake);
    const [g] = await groups(FILES, ["R06"]);
    fake.refs.set("buildhound/fix-r06-no-timeout", fake.refs.get("main")!);
    const out = await openFixPullRequest(gh, "acme", "app", await readBase(gh, "acme", "app", "main"), g!);
    expect(out.status).toBe("skipped");
    expect(out.note).toMatch(/commit Buildhound did not make/);
    expect(fake.writes()).toEqual([]);
  });

  it("does not reopen a fix a maintainer closed without merging", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const gh = client(fake);
    const [g] = await groups(FILES, ["R06"]);
    fake.addPull({ title: "x", body: "", head: "buildhound/fix-r06-no-timeout", base: "main", state: "closed", merged_at: null });
    const out = await openFixPullRequest(gh, "acme", "app", await readBase(gh, "acme", "app", "main"), g!);
    expect(out).toMatchObject({ status: "skipped", number: 1 });
    expect(out.note).toMatch(/closed without merging/);
    expect(fake.writes()).toEqual([]);
  });
});

describe("scan --fix: runScanFix against a fake GitHub", () => {
  let fake: FakeGitHub;
  let server: { url: string; close: () => Promise<void> };
  const saved = process.env.GITHUB_API_URL;
  beforeAll(async () => {
    fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    server = await fake.listen();
    process.env.GITHUB_API_URL = server.url;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    await server.close();
  });

  /** A checkout of acme/app whose ios.yml has an edit not yet pushed. */
  function checkout(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "buildhound-fix-"));
    cpSync(path.join(fixtures, ".github"), path.join(dir, ".github"), { recursive: true });
    writeFileSync(path.join(dir, ".github", "workflows", "ios.yml"), ios.replace("name: iOS", "name: iOS (local edit)"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    return dir;
  }

  it("plans without --yes and writes nothing, with next to confirm", async () => {
    const dir = checkout();
    const r = await runScanFix(dir, { token: "t", resolve: false });
    expect(r.mode).toBe("plan");
    expect(r.repo).toBe("acme/app");
    expect(r.pull_requests.length).toBeGreaterThan(1);
    for (const p of r.pull_requests) {
      expect(p.status).toBe("planned");
      expect(p.branch).toMatch(/^buildhound\/fix-r\d\d-[a-z-]+$/);
      expect(p.files.length).toBeGreaterThan(0);
      expect(p.body).toContain("Buildhound's CI report");
    }
    expect(r.next).toBe(`buildhound scan ${dir} --fix --yes`);
    expect(fake.writes()).toEqual([]);
    // R17 was not resolved (--no-resolve), so its findings have no automatic fix.
    expect(r.no_automatic_fix.some((x) => x.rule === "R17")).toBe(true);
  });

  it("with --yes opens one pull request per rule against GitHub's default branch, then a rerun opens nothing new", async () => {
    const dir = checkout();
    const r = await runScanFix(dir, { token: "t", resolve: false, yes: true });
    expect(r.mode).toBe("applied");
    expect(r.base).toEqual({ branch: "main", sha: fake.refs.get("main") });
    expect(r.pull_requests.every((p) => p.status === "created" && p.url?.startsWith("https://github.com/acme/app/pull/"))).toBe(true);
    expect(new Set(r.pull_requests.map((p) => p.branch)).size).toBe(r.pull_requests.length);
    expect(r.assumptions.some((a) => a.includes("ios.yml differs from main on GitHub"))).toBe(true);
    // Built from GitHub's ios.yml, not the unpushed local edit.
    for (const p of r.pull_requests) {
      if (p.files.some((f) => f.path.endsWith("ios.yml"))) expect(fake.fileAt(p.branch, ".github/workflows/ios.yml")).not.toContain("local edit");
    }
    const pulls = fake.pulls.length;
    const again = await runScanFix(dir, { token: "t", resolve: false, yes: true });
    expect(again.pull_requests.map((p) => p.status)).toEqual(r.pull_requests.map(() => "unchanged"));
    expect(fake.pulls).toHaveLength(pulls);
    expect(again.next).toBe("buildhound scan --repo acme/app");
  });

  it("--one-pr skips the rules that already have their own open pull request", async () => {
    const dir = checkout();
    const r = await runScanFix(dir, { token: "t", resolve: false, yes: true, onePr: true });
    expect(r.pull_requests.every((p) => p.status === "skipped" && p.note?.startsWith("already in open pull request #"))).toBe(true);
    expect(fake.refs.has("buildhound/fix-ci-report")).toBe(false);
  });

  it("refuses without push access, with next naming a maintainer or a fork", async () => {
    const saved = fake.repo.push;
    fake.repo.push = false;
    try {
      const e = await runScanFix(checkout(), { token: "t", resolve: false, yes: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("NO_PUSH_ACCESS");
      expect((e as CliError).next).toMatch(/ask a maintainer of acme\/app to run npx buildhound scan --fix --repo acme\/app --yes, or fork it/);
    } finally {
      fake.repo.push = saved;
    }
  });
});

describe("scan --fix: errors from GitHub writes", () => {
  it("a token without the workflow scope gets the gh command that adds it", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    fake.refuseWorkflowWrites = true;
    const server = await fake.listen();
    const saved = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = server.url;
    try {
      const e = (await runScanFix(fixtures, { repo: "acme/app", token: "t", resolve: false, yes: true, rule: ["R06"] }).catch((x: unknown) => x)) as CliError;
      expect(e.code).toBe("WORKFLOW_SCOPE_REQUIRED");
      expect(e.next).toBe(`gh auth refresh -s workflow, then buildhound scan ${fixtures} --fix --repo acme/app --rule R06 --yes`);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
      await server.close();
    }
  });

  it("fixCommand repeats the flags the agent passed", () => {
    expect(fixCommand(".", { rule: ["R03", "R06"], onePr: true }, { yes: true })).toBe("buildhound scan --fix --rule R03 --rule R06 --one-pr --yes");
    expect(fixCommand("app", { repo: "acme/app" })).toBe("buildhound scan app --fix --repo acme/app");
  });
});

// Agent-first harness (AGENT_FIRST.md, What is tested): the CLI as a child process with no TTY.
const run = promisify(execFile);
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

async function cli(args: string[], env: Record<string, string> = {}) {
  const full = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_API_URL: "", PATH: mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-")), INIT_CWD: "", ...env };
  try {
    const { stdout } = await run(process.execPath, [tsx, entry, ...args], { env: full, cwd: here });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, stdout: err.stdout };
  }
}

function one(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  expect(lines, "exactly one line of JSON on stdout").toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function expectError(r: { code: number; stdout: string }, code: string): { code: string; message: string; next: string } {
  const e = (one(r.stdout) as { error: { code: string; message: string; next: string } }).error;
  expect(e.code).toBe(code);
  expect(e.message).toBeTruthy();
  expect(e.next).toBeTruthy();
  expect(r.code).not.toBe(0);
  return e;
}

describe("agentfirst: scan --fix", () => {
  it("agentfirst: scan --fix without --yes and without a TTY returns the plan as JSON with next to confirm", async () => {
    const r = await cli(["scan", fixtures, "--fix", "--no-resolve"]);
    expect(r.code).toBe(0);
    const plan = one(r.stdout) as unknown as ScanFixResult;
    expect(plan.mode).toBe("plan");
    expect(plan.pull_requests.length).toBeGreaterThan(0);
    expect(plan.pull_requests.every((p) => p.status === "planned" && p.branch.startsWith("buildhound/fix-") && p.body && p.diff)).toBe(true);
    // No origin remote here, so the confirm command asks for the repository too.
    expect(plan.next).toBe(`buildhound scan ${fixtures} --fix --repo <owner/name> --yes`);
  });

  it("agentfirst: scan --fix --dry-run prints branches, files and bodies, and writes nothing", async () => {
    const r = await cli(["scan", fixtures, "--fix", "--dry-run", "--yes", "--one-pr", "--no-resolve"]);
    expect(r.code).toBe(0);
    const plan = one(r.stdout) as unknown as ScanFixResult;
    expect(plan.mode).toBe("dry_run");
    expect(plan.pull_requests.map((p) => p.branch)).toEqual(["buildhound/fix-ci-report"]);
    expect(plan.pull_requests[0]!.files.map((f) => f.path).sort()).toEqual([".github/workflows/ios.yml", ".github/workflows/nightly.yml"]);
  });

  it("agentfirst: scan --fix --yes opens pull requests on a fake GitHub, and a rerun updates instead of duplicating", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    const server = await fake.listen();
    try {
      const env = { GITHUB_TOKEN: "t", GITHUB_API_URL: server.url };
      const r = await cli(["scan", "--fix", "--repo", "acme/app", "--yes", "--no-resolve", "--rule", "R06", "--rule", "R01"], env);
      expect(r.code).toBe(0);
      const done = one(r.stdout) as unknown as ScanFixResult;
      expect(done.mode).toBe("applied");
      expect(done.pull_requests.map((p) => [p.branch, p.status])).toEqual([["buildhound/fix-r01-cron-frequency", "created"], ["buildhound/fix-r06-no-timeout", "created"]]);
      expect(fake.pulls.map((p) => p.head).sort()).toEqual(["buildhound/fix-r01-cron-frequency", "buildhound/fix-r06-no-timeout"]);
      const again = one((await cli(["scan", "--fix", "--repo", "acme/app", "--yes", "--no-resolve", "--rule", "R06", "--rule", "R01"], env)).stdout) as unknown as ScanFixResult;
      expect(again.pull_requests.map((p) => p.status)).toEqual(["unchanged", "unchanged"]);
      expect(fake.pulls).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("agentfirst: scan --fix --yes with no repository found errors with next naming --repo", async () => {
    const e = expectError(await cli(["scan", fixtures, "--fix", "--yes", "--no-resolve"]), "REPO_UNKNOWN");
    expect(e.next).toBe(`buildhound scan ${fixtures} --fix --repo <owner/name> --yes`);
  });

  it("agentfirst: scan --fix --yes --repo without a token errors with the gh command", async () => {
    const e = expectError(await cli(["scan", "--fix", "--repo", "acme/app", "--yes", "--no-resolve"]), "TOKEN_REQUIRED");
    expect(e.next).toContain("--token $(gh auth token)");
  });

  it("agentfirst: scan --fix --yes without push access errors with next", async () => {
    const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES, push: false });
    const server = await fake.listen();
    try {
      const e = expectError(await cli(["scan", "--fix", "--repo", "acme/app", "--yes", "--no-resolve"], { GITHUB_TOKEN: "t", GITHUB_API_URL: server.url }), "NO_PUSH_ACCESS");
      expect(e.next).toContain("ask a maintainer");
      expect(fake.writes()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("agentfirst: --one-pr without --fix is a usage error with next", async () => {
    const e = expectError(await cli(["scan", fixtures, "--one-pr", "--no-resolve"]), "USAGE");
    expect(e.next).toContain("--fix");
  });
});
