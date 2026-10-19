import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALL_RULES, R06, routingExpression } from "@buildhound/core";
import { applyCommand, runRouteApply } from "./commands/route-apply";
import type { RouteApplyResult } from "./commands/route-apply";
import { EMPTY_CONFIG } from "./lib/config";
import { FakeGitHub } from "./lib/fake-github";
import { withDefaultTokenPermission } from "./lib/routing";
import { CliError, NeedsHumanError } from "./output";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A real-shaped CI file: a Linux job with a comment, a macOS job, a deploy job with secrets, Windows, and a matrix. */
const CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  # Lint and unit tests, on every push
  lint:
    runs-on: ubuntu-latest # cheapest runner
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test


  ios:
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild test -scheme App

  deploy:
    needs: [lint, ios]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy.sh
        env:
          DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}

  windows:
    runs-on: windows-latest
    steps:
      - run: npm test

  matrix:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`;
const FILES = { ".github/workflows/ci.yml": CI, "README.md": "# app\n" };
const LINT = "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}";
const IOS = "${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}";
const DEPLOY = "${{ vars.BUILDHOUND_LINUX_TRUSTED || 'ubuntu-latest' }}";

async function withFake<T>(init: Partial<ConstructorParameters<typeof FakeGitHub>[0]>, fn: (fake: FakeGitHub) => Promise<T>): Promise<T> {
  const fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES, ...init });
  const server = await fake.listen();
  const saved = process.env.GITHUB_API_URL;
  const savedApi = process.env.BUILDHOUND_API_URL;
  process.env.GITHUB_API_URL = server.url;
  // The control plane's plan check goes to the fake too, never to api.buildhound.sh.
  process.env.BUILDHOUND_API_URL = server.url;
  try {
    return await fn(fake);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    if (savedApi === undefined) delete process.env.BUILDHOUND_API_URL;
    else process.env.BUILDHOUND_API_URL = savedApi;
    await server.close();
  }
}

describe("route --apply: runRouteApply against a fake GitHub", () => {
  it("plans without --yes and writes nothing: the jobs it routes, what stays and why, and next to confirm", async () => {
    await withFake({}, async (fake) => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t" });
      expect(r.mode).toBe("plan");
      expect(r.base).toBeNull();
      expect(r.pull_request).toMatchObject({ branch: "buildhound/route", status: "planned", title: "Route 3 jobs to your machines, with GitHub-hosted as the fallback", files: [{ path: ".github/workflows/ci.yml", added: 3, removed: 3 }] });
      expect(r.routed.map((j) => [j.job, j.to])).toEqual([["lint", LINT], ["ios", IOS], ["deploy", DEPLOY]]);
      // The deploy job can reach secrets: it reads the trusted variable, which only Trusted machines serve (rule 19).
      expect(r.routed.find((j) => j.job === "deploy")).toMatchObject({ variable: "BUILDHOUND_LINUX_TRUSTED", secrets: expect.arrayContaining(["jobs.deploy.environment: production"]), today: null });
      expect(r.routed.find((j) => j.job === "lint")!.secrets).toEqual([]);
      const kept = Object.fromEntries(r.not_routed.map((k) => [k.job, k.reason]));
      expect(Object.keys(kept).sort()).toEqual(["matrix", "windows"]);
      expect(r.assumptions.some((a) => a.includes("only machines a person marked Trusted serve; until one is connected they run on GitHub-hosted"))).toBe(true);
      expect(kept.windows).toContain("Windows");
      expect(kept.matrix).toContain("expression");
      expect(r.saving).toMatchObject({ public_repository: false, machine_fee_cents: 1000, machines_needed: 1 });
      expect(r.next).toBe("buildhound route --apply --repo acme/app --yes");
      expect(fake.writes()).toEqual([]);
      // The body: speed, the calculation, the stay option, when it takes effect, what stays, the assumption.
      const body = r.pull_request!.body;
      for (const s of ["### Speed", "not measured yet", "### Monthly saving", "Pro, 1 machine at $10.00", "### To stay on GitHub-hosted", "### When it takes effect", "### Not routed", "### Assumption", "```diff"]) expect(body).toContain(s);
      expect(body).toContain("### Jobs that use secrets");
      expect(body).toContain("- `ci.yml`, job `deploy`: ");
      expect(body).toContain("Until a Trusted machine is connected and serves this repository, `BUILDHOUND_LINUX_TRUSTED` stays unset and this job runs on GitHub-hosted, as today.");
    });
  });

  it("leaves a job pinned to one machine's exclusive scale set as written, and never writes an exclusive variable (B09)", async () => {
    const perf = CI.replace("  ios:\n    runs-on: macos-latest", "  ios:\n    runs-on: buildhound-macos-exclusive-mini-01");
    await withFake({ files: { ".github/workflows/ci.yml": perf, "README.md": "# app\n" } }, async () => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t" });
      expect(r.routed.map((j) => j.job)).not.toContain("ios");
      const kept = Object.fromEntries(r.not_routed.map((k) => [k.job, k.reason]));
      expect(kept.ios).toContain("-exclusive");
      expect(r.pull_request!.body).not.toContain("EXCLUSIVE");
    });
  });

  it("with --yes opens one pull request from buildhound/route, then a rerun reports unchanged and writes nothing", async () => {
    await withFake({}, async (fake) => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.mode).toBe("applied");
      expect(r.base).toEqual({ branch: "main", sha: fake.refs.get("main") });
      expect(r.pull_request).toMatchObject({ status: "created", number: 1, url: "https://github.com/acme/app/pull/1" });
      expect(fake.writes()).toEqual(["POST /repos/acme/app/git/trees", "POST /repos/acme/app/git/commits", "POST /repos/acme/app/git/refs", "POST /repos/acme/app/pulls"]);
      const head = fake.commits.get(fake.refs.get("buildhound/route")!)!;
      expect(head.parents).toEqual([fake.refs.get("main")]);
      expect(head.message).toMatch(/^ci: route 3 jobs to your machines with Buildhound\n[\s\S]*Buildhound-Route: lint,ios,deploy$/);
      const after = fake.fileAt("buildhound/route", ".github/workflows/ci.yml")!;
      expect(after).toBe(
        CI.replace("runs-on: ubuntu-latest # cheapest runner", `runs-on: ${LINT} # cheapest runner`)
          .replace("  ios:\n    runs-on: macos-latest", `  ios:\n    runs-on: ${IOS}`)
          .replace("    needs: [lint, ios]\n    runs-on: ubuntu-latest", `    needs: [lint, ios]\n    runs-on: ${DEPLOY}`),
      );
      expect(fake.fileAt("main", ".github/workflows/ci.yml")).toBe(CI);
      expect(fake.pulls[0]).toMatchObject({ head: "buildhound/route", base: "main", state: "open", body: r.pull_request!.body });
      expect(r.next).toBe("buildhound runner status --org acme");

      const writes = fake.writes().length;
      const again = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(again.pull_request).toMatchObject({ status: "unchanged", number: 1, note: "already open with this routing change" });
      expect(fake.writes()).toHaveLength(writes);
      expect(fake.pulls).toHaveLength(1);
    });
  });

  it("updates its own branch and pull request when a job is added, never opening a second one", async () => {
    await withFake({}, async (fake) => {
      await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      fake.commitToDefault({ ".github/workflows/docs.yml": "on: push\npermissions:\n  contents: read\njobs:\n  docs:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: make docs\n" });
      const writes = fake.writes().length;
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request).toMatchObject({ status: "updated", number: 1 });
      expect(r.routed.map((j) => j.job)).toEqual(["lint", "ios", "deploy", "docs"]);
      expect(fake.writes().slice(writes)).toEqual(["POST /repos/acme/app/git/trees", "POST /repos/acme/app/git/commits", "PATCH /repos/acme/app/git/refs/heads/buildhound/route", "PATCH /repos/acme/app/pulls/1"]);
      expect(fake.fileAt("buildhound/route", ".github/workflows/docs.yml")).toContain("runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-24.04' }}");
      expect(fake.pulls).toHaveLength(1);
    });
  });

  it("leaves buildhound/route alone when someone else committed to it, and never reopens a closed one", async () => {
    await withFake({}, async (fake) => {
      fake.refs.set("buildhound/route", fake.refs.get("main")!);
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request).toMatchObject({ status: "skipped" });
      expect(r.pull_request!.note).toMatch(/commit Buildhound did not make/);
      expect(fake.writes()).toEqual([]);
    });
    await withFake({}, async (fake) => {
      fake.addPull({ title: "x", body: "", head: "buildhound/route", base: "main", state: "closed", merged_at: null });
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request).toMatchObject({ status: "skipped", number: 1 });
      expect(r.pull_request!.note).toMatch(/routing change was closed without merging/);
      expect(fake.writes()).toEqual([]);
    });
  });

  it("on a public repository writes the trusted-events form, upgrades older expressions and claims no saving", async () => {
    const routed = CI.replace("  ios:\n    runs-on: macos-latest", `  ios:\n    runs-on: ${IOS} # the office Mac`);
    await withFake({ private: false, files: { ".github/workflows/ci.yml": routed } }, async (fake) => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.routed.map((j) => [j.job, j.to])).toEqual([
        ["lint", routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true)],
        ["deploy", routingExpression("BUILDHOUND_LINUX_TRUSTED", "ubuntu-latest", true)],
      ]);
      expect(r.already_routed).toEqual([{ workflow: ".github/workflows/ci.yml", job: "ios", variable: "BUILDHOUND_MACOS" }]);
      expect(r.upgrades).toEqual([{ workflow: ".github/workflows/ci.yml", jobs: [{ job: "ios", from: IOS, to: routingExpression("BUILDHOUND_MACOS", "macos-latest", true) }] }]);
      expect(r.saving).toMatchObject({ public_repository: true, claimed_cents_per_month: 0 });
      const after = fake.fileAt("buildhound/route", ".github/workflows/ci.yml")!;
      expect(after).toContain(`runs-on: ${routingExpression("BUILDHOUND_MACOS", "macos-latest", true)} # the office Mac`);
      expect(r.pull_request!.body).toContain("Fork pull requests and events anyone on GitHub can cause stay on GitHub-hosted.");
      expect(r.pull_request!.body).toContain("no saving is claimed");
    });
  });

  it("sends a job without a permissions block to Trusted machines when the repository's default token could be able to write", async () => {
    const open = CI.replace("permissions:\n  contents: read\n\n", "");
    for (const [setting, variable] of [["write", "BUILDHOUND_LINUX_TRUSTED"], [null, "BUILDHOUND_LINUX_TRUSTED"], ["read", "BUILDHOUND_LINUX"]] as const) {
      await withFake({ files: { ".github/workflows/ci.yml": open } }, async (fake) => {
        fake.defaultWorkflowPermissions = setting;
        const r = await runRouteApply(".", { repo: "acme/app", token: "t" });
        const lint = r.routed.find((j) => j.job === "lint")!;
        expect(lint.variable).toBe(variable);
        if (variable.endsWith("_TRUSTED")) expect(lint.secrets.join(" ")).toMatch(/default|write/);
        if (setting === null) expect(r.assumptions.some((a) => a.includes("could not be read") && a.includes("Trusted machines only"))).toBe(true);
      });
    }
  });

  it("moves a job that can reach secrets from the plain variable to the trusted one, without counting it in the saving again", async () => {
    const routed = CI.replace("    needs: [lint, ios]\n    runs-on: ubuntu-latest", "    needs: [lint, ios]\n    runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }} # deploy box");
    await withFake({ files: { ".github/workflows/ci.yml": routed } }, async (fake) => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      const deploy = r.routed.find((j) => j.job === "deploy")!;
      expect(deploy).toMatchObject({ from: "ubuntu-latest", today: "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}", variable: "BUILDHOUND_LINUX_TRUSTED", to: DEPLOY });
      expect(r.already_routed).toEqual([]);
      const after = fake.fileAt("buildhound/route", ".github/workflows/ci.yml")!;
      expect(after).toContain(`runs-on: ${DEPLOY} # deploy box`);
      expect(r.saving.minutes_per_month).toBe(r.routed.filter((j) => j.job !== "deploy").reduce((a, j) => a + j.minutes_per_month, 0));
      expect(r.pull_request!.body).toContain("| `ci.yml` | `deploy` | `${{ vars.BUILDHOUND_LINUX \\|\\| 'ubuntu-latest' }}` | `${{ vars.BUILDHOUND_LINUX_TRUSTED \\|\\| 'ubuntu-latest' }}` |");
    });
  });

  it("a token without the workflow scope (GitHub's bare 404) gets the gh command that adds it", async () => {
    await withFake({}, async (fake) => {
      fake.refuseWorkflowWritesQuietly = true;
      const e = (await runRouteApply(".", { repo: "acme/app", token: "t", yes: true }).catch((x: unknown) => x)) as CliError;
      expect(e.code).toBe("WORKFLOW_SCOPE_REQUIRED");
      expect(e.next).toBe("gh auth refresh -s workflow, then buildhound route --apply --repo acme/app --yes");
    });
  });

  it("refuses without push access, with next naming a maintainer", async () => {
    await withFake({ push: false }, async (fake) => {
      const e = (await runRouteApply(".", { repo: "acme/app", token: "t", yes: true }).catch((x: unknown) => x)) as CliError;
      expect(e).toBeInstanceOf(CliError);
      expect(e.code).toBe("NO_PUSH_ACCESS");
      expect(e.next).toBe("ask a maintainer of acme/app to run npx buildhound route --apply --repo acme/app --yes");
      expect(fake.writes()).toEqual([]);
    });
  });

  it("on Free, makes the first private repository routed Free's one and opens the pull request (ADR-039)", async () => {
    await withFake({}, async (fake) => {
      fake.plan = { plan: "pro", effective: "none", free_repository: null, checkout_url: "https://app.buildhound.sh/acme/settings/billing" };
      const dry = await runRouteApply(".", { repo: "acme/app", token: "t" });
      expect(dry.assumptions).toContain("on Free, acme/app becomes acme's one free private repository when the pull request is opened");
      expect(fake.plan.free_repository).toBeNull();
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request!.status).toBe("created");
      expect(fake.plan.free_repository).toBe("acme/app");
      // Routing it again is fine: it is Free's one now.
      expect((await runRouteApply(".", { repo: "acme/app", token: "t", yes: true })).pull_request!.status).toBe("unchanged");
    });
  });

  it("stops with needs_plan before writing when another private repository is Free's one (CLAUDE.md rule 9)", async () => {
    await withFake({}, async (fake) => {
      fake.plan = { plan: "pro", effective: "none", free_repository: "acme/other", checkout_url: "https://app.buildhound.sh/acme/settings/billing" };
      for (const yes of [false, true]) {
        const e = await runRouteApply(".", { repo: "acme/app", token: "t", yes }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(NeedsHumanError);
        expect((e as NeedsHumanError).answer).toMatchObject({
          status: "needs_human",
          reason: "needs_plan",
          url: "https://app.buildhound.sh/acme/settings/billing",
          next: "a person chooses Pro for acme, then buildhound route --apply --repo acme/app --yes",
          error: { code: "NEEDS_PLAN" },
        });
      }
      expect(fake.writes()).toEqual([]);
    });
  });

  it("routes a private repository once the account has Pro, and a public one on Free", async () => {
    await withFake({}, async (fake) => {
      fake.plan = { plan: "pro", effective: "pro" };
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request!.status).toBe("created");
      expect(r.assumptions.join(" ")).not.toContain("could not be checked");
    });
    await withFake({ private: false }, async (fake) => {
      fake.plan = { plan: "pro", effective: "none" };
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.pull_request!.status).toBe("created");
      expect(fake.calls.some((c) => c.path.endsWith("/plan"))).toBe(false);
    });
  });

  it("goes ahead with an assumption line when the plan cannot be read", async () => {
    await withFake({}, async () => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t" });
      expect(r.mode).toBe("plan");
      expect(r.assumptions).toContain("acme's plan could not be checked; on Free one private repository routes, and every one on Pro");
    });
  });

  it("applyCommand repeats the flags the agent passed", () => {
    expect(applyCommand(".", { repo: "acme/app", days: "7" }, { yes: true })).toBe("buildhound route --apply --repo acme/app --days 7 --yes");
    expect(applyCommand("app", {})).toBe("buildhound route app --apply");
  });
});

// Agent-first harness (AGENT_FIRST.md, What is tested): the CLI as a child process with no TTY.
const run = promisify(execFile);
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

async function cli(args: string[], env: Record<string, string> = {}) {
  // The plan check goes wherever GitHub does in a test (the fake answers both), never to api.buildhound.sh.
  const full = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_API_URL: "", BUILDHOUND_API_URL: env.GITHUB_API_URL ?? "http://127.0.0.1:9", PATH: mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-")), INIT_CWD: "", ...env };
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

describe("agentfirst: route --apply", () => {
  let dir: string;
  let fake: FakeGitHub;
  let server: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "buildhound-route-"));
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), CI);
    fake = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    server = await fake.listen();
  });
  afterAll(async () => server.close());

  it("agentfirst: route --apply without --yes and without a TTY returns the plan as JSON with next to confirm", async () => {
    const r = await cli(["route", dir, "--apply"]);
    expect(r.code).toBe(0);
    const plan = one(r.stdout) as unknown as RouteApplyResult;
    expect(plan.mode).toBe("plan");
    expect(plan.pull_request!.status).toBe("planned");
    expect(plan.pull_request!.body).toContain("### To stay on GitHub-hosted");
    // No token, so the default permission is unknown, but ci.yml sets one; no origin remote, so next asks for the repository.
    expect(plan.routed.map((j) => [j.job, j.variable])).toEqual([["lint", "BUILDHOUND_LINUX"], ["ios", "BUILDHOUND_MACOS"], ["deploy", "BUILDHOUND_LINUX_TRUSTED"]]);
    expect(plan.next).toBe(`buildhound route ${dir} --apply --repo <owner/name> --yes`);
  });

  it("agentfirst: route --apply --dry-run --yes writes nothing", async () => {
    const r = await cli(["route", "--apply", "--repo", "acme/app", "--dry-run", "--yes"], { GITHUB_TOKEN: "t", GITHUB_API_URL: server.url });
    expect(r.code).toBe(0);
    const plan = one(r.stdout) as unknown as RouteApplyResult;
    expect(plan.mode).toBe("dry_run");
    expect(plan.pull_request!.status).toBe("planned");
    expect(fake.writes()).toEqual([]);
  });

  it("agentfirst: route --apply --yes opens the pull request on a fake GitHub, and a rerun reports unchanged", async () => {
    const env = { GITHUB_TOKEN: "t", GITHUB_API_URL: server.url };
    const done = one((await cli(["route", "--apply", "--repo", "acme/app", "--yes"], env)).stdout) as unknown as RouteApplyResult;
    expect(done.mode).toBe("applied");
    expect(done.pull_request).toMatchObject({ branch: "buildhound/route", status: "created" });
    expect(done.next).toBe("buildhound runner status --org acme");
    const again = one((await cli(["route", "--apply", "--repo", "acme/app", "--yes"], env)).stdout) as unknown as RouteApplyResult;
    expect(again.pull_request!.status).toBe("unchanged");
    expect(fake.pulls).toHaveLength(1);
  });

  it("agentfirst: route --apply --yes on a private repository past Free's one returns needs_human needs_plan, exit 0, nothing written", async () => {
    const quiet = new FakeGitHub({ owner: "acme", name: "app", files: FILES });
    quiet.plan = { plan: "pro", effective: "none", free_repository: "acme/other", checkout_url: "https://app.buildhound.sh/acme/settings/billing" };
    const s = await quiet.listen();
    try {
      const r = await cli(["route", "--apply", "--repo", "acme/app", "--yes"], { GITHUB_TOKEN: "t", GITHUB_API_URL: s.url });
      expect(r.code).toBe(0);
      expect(one(r.stdout)).toMatchObject({ status: "needs_human", reason: "needs_plan", url: "https://app.buildhound.sh/acme/settings/billing", next: "a person chooses Pro for acme, then buildhound route --apply --repo acme/app --yes" });
      expect(quiet.writes()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("agentfirst: route --apply --yes with no repository found errors with next naming --repo", async () => {
    const e = expectError(await cli(["route", dir, "--apply", "--yes"]), "REPO_UNKNOWN");
    expect(e.next).toBe(`buildhound route ${dir} --apply --repo <owner/name> --yes`);
  });

  it("agentfirst: route --apply --yes --repo without a token errors with the gh command", async () => {
    const e = expectError(await cli(["route", "--apply", "--repo", "acme/app", "--yes"]), "TOKEN_REQUIRED");
    expect(e.next).toContain("--token $(gh auth token)");
  });

  it("agentfirst: --yes without --apply is a usage error with next", async () => {
    const e = expectError(await cli(["route", dir, "--yes"]), "USAGE");
    expect(e.next).toBe(`buildhound route ${dir} --apply`);
  });
});

describe("scan reads the default token permission the way route does, for R14 (CLAUDE.md rule 19)", () => {
  const src = { repo: "acme/app", repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, workflows: [], history: { days: 30, runs: [], jobs: [] }, config: EMPTY_CONFIG };

  it("puts the repository's setting on the source, and leaves it unread (counted as write) when GitHub does not say", async () => {
    for (const setting of ["read", "write", null] as const) {
      await withFake({}, async (fake) => {
        fake.defaultWorkflowPermissions = setting;
        const out = await withDefaultTokenPermission(src, ALL_RULES, "t");
        expect(out.repository.defaultTokenPermission).toBe(setting ?? undefined);
      });
    }
  });

  it("does not ask GitHub when R14 is not run or there is no run history", async () => {
    await withFake({}, async (fake) => {
      fake.defaultWorkflowPermissions = "read";
      expect((await withDefaultTokenPermission(src, [R06], "t")).repository.defaultTokenPermission).toBeUndefined();
      expect((await withDefaultTokenPermission({ ...src, history: null }, ALL_RULES, "t")).repository.defaultTokenPermission).toBeUndefined();
      expect((await withDefaultTokenPermission({ ...src, config: { ...EMPTY_CONFIG, rules: { disabledRules: ["R14"] } } }, ALL_RULES, "t")).repository.defaultTokenPermission).toBeUndefined();
    });
  });
});

describe("route --apply and arm64 jobs (RUNNERS.md, Labels; B12)", () => {
  const ARM_CI = CI.replace("  windows:", "  arm:\n    runs-on: ubuntu-24.04-arm # native arm64\n    steps:\n      - run: docker buildx build --platform linux/arm64 .\n\n  arm-release:\n    runs-on: ubuntu-22.04-arm\n    environment: production\n    steps:\n      - run: ./release.sh\n\n  windows:");
  const ARM = "${{ vars.BUILDHOUND_LINUX_ARM64 || 'ubuntu-24.04-arm' }}";

  it("pins a job on GitHub's arm64 runner to BUILDHOUND_LINUX_ARM64, its trusted twin when it can reach secrets, and keeps BUILDHOUND_LINUX for x86-64 jobs", async () => {
    await withFake({ files: { ".github/workflows/ci.yml": ARM_CI, "README.md": "# app\n" } }, async (fake) => {
      const r = await runRouteApply(".", { repo: "acme/app", token: "t", yes: true });
      expect(r.routed.map((j) => [j.job, j.variable, j.to])).toEqual([
        ["lint", "BUILDHOUND_LINUX", LINT],
        ["ios", "BUILDHOUND_MACOS", IOS],
        ["deploy", "BUILDHOUND_LINUX_TRUSTED", DEPLOY],
        ["arm", "BUILDHOUND_LINUX_ARM64", ARM],
        ["arm-release", "BUILDHOUND_LINUX_ARM64_TRUSTED", "${{ vars.BUILDHOUND_LINUX_ARM64_TRUSTED || 'ubuntu-22.04-arm' }}"],
      ]);
      expect(r.routed.find((j) => j.job === "arm")!.os).toBe("linux");
      expect(r.assumptions.some((a) => a.startsWith("jobs on GitHub's arm64 runners read BUILDHOUND_LINUX_ARM64"))).toBe(true);
      const after = fake.fileAt("buildhound/route", ".github/workflows/ci.yml")!;
      expect(after).toContain(`runs-on: ${ARM} # native arm64`);
      expect(after).not.toContain("vars.BUILDHOUND_LINUX || 'ubuntu-24.04-arm'");
      const body = r.pull_request!.body;
      expect(body).toContain("ran on arm64 runners (`ubuntu-24.04-arm`, `ubuntu-22.04-arm`), so they are pinned to arm64 machines through `BUILDHOUND_LINUX_ARM64` and `BUILDHOUND_LINUX_ARM64_TRUSTED`: an arm64 Linux host or a Mac, never an x86-64 host.");
      expect(body).toContain("no Linux job needs an x86-64 kernel");
    });
  });
});
