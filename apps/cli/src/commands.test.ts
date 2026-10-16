import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_RULE_CONFIG } from "@buildhound/core";
import type { History } from "@buildhound/core";
import { ownedSavingLine, prettyScan, runScan } from "./commands/scan";
import { ownedRouteLine, prettyRoute, runRoute } from "./commands/route";
import { parseConfig } from "./lib/config";
import { peakConcurrency, routingCandidates } from "./lib/routing";
import { repoFromRemote } from "./lib/workflows";
import { CliError } from "./output";

// The GitHub module is mocked so nothing here touches the network, whatever state packages/github is in.
vi.mock("@buildhound/github", () => ({
  createGitHubClient: vi.fn(() => ({ mocked: true })),
  fetchHistory: vi.fn(),
}));

const gh = (await import("@buildhound/github")) as unknown as { createGitHubClient: Mock; fetchHistory: Mock };
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
const iosContent = readFileSync(path.join(fixtures, ".github", "workflows", "ios.yml"), "utf8");

const t0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const minutes = (n: number) => n * 60_000;

/** 30 push runs; the lint job takes 10 minutes and two of its runs overlap. */
function history(): History {
  const runs = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    workflowPath: ".github/workflows/ios.yml",
    event: "push",
    headBranch: "main",
    headSha: null,
    actorLogin: "dev",
    actorKind: "human" as const,
    agentName: null,
    createdAt: new Date(t0 + i * minutes(60)),
    runStartedAt: new Date(t0 + i * minutes(60)),
    conclusion: "success",
    isFork: false,
    isDraft: false,
  }));
  const jobs = runs.map((r, i) => ({
    id: 100 + i,
    runId: r.id,
    name: "lint",
    labels: ["macos-latest"],
    startedAt: new Date(t0 + (i < 2 ? 0 : i * minutes(60))),
    completedAt: new Date(t0 + (i < 2 ? 0 : i * minutes(60)) + minutes(10)),
    conclusion: "success",
    steps: [],
  }));
  return { days: 30, runs, jobs };
}

// R17's tag lookups go through fetch; it is stubbed so a scan here never reaches api.github.com.
const SHA = "c".repeat(40);
const fetchStub = vi.fn(() => Promise.resolve(new Response("Not Found", { status: 404 })));

beforeEach(() => {
  gh.fetchHistory.mockReset();
  gh.createGitHubClient.mockClear();
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scan --repo", () => {
  it("fetches workflows and history through @buildhound/github and prices jobs from observed minutes", async () => {
    gh.fetchHistory.mockResolvedValue({
      repository: { fullName: "acme/app", private: true, defaultBranch: "main" },
      workflows: [{ path: ".github/workflows/ios.yml", content: iosContent }],
      history: history(),
    });
    const r = await runScan(fixtures, { repo: "acme/app", token: "t_test", days: "14" });
    expect(gh.createGitHubClient).toHaveBeenCalledWith(expect.objectContaining({ token: "t_test" }));
    expect(gh.fetchHistory).toHaveBeenCalledWith({ client: { mocked: true }, owner: "acme", repo: "app", days: 14 });
    expect(r.repo).toBe("acme/app");
    expect(r.history_days).toBe(30);
    expect(r.workflows).toHaveLength(1);
    const lint = r.workflows[0]!.jobs.find((j) => j.id === "lint")!;
    expect(lint.basis).toBe("history");
    expect(lint.minutes_per_run).toBe(10);
    expect(lint.runs_per_month).toBe(70); // 30 observed push runs plus the 40 default pull_request runs
    expect(r.workflows[0]!.estimate.runs_by_event).toEqual({ push: 30, pull_request: 40 });
    expect(r.next).toContain("buildhound route");
    expect(r.assumptions.some((a) => a.includes("no run history"))).toBe(false);
  });

  it("treats a public repository's GitHub-hosted minutes as free", async () => {
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/oss", private: false, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content: iosContent }], history: { days: 30, runs: [], jobs: [] } });
    const r = await runScan(fixtures, { repo: "acme/oss", token: "t_test" });
    expect(r.totals.cents_per_month).toBe(0);
  });

  it("maps GitHub failures to error codes with exit 3 for auth and 4 for the rest", async () => {
    for (const [status, code, exit] of [[401, "TOKEN_INVALID", 3], [403, "TOKEN_FORBIDDEN", 3], [404, "REPO_NOT_FOUND", 4], [500, "GITHUB_ERROR", 4]] as const) {
      gh.fetchHistory.mockRejectedValue(Object.assign(new Error(`HTTP ${status}`), { status }));
      const err = await runScan(fixtures, { repo: "acme/app", token: "t_test" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(code);
      expect((err as CliError).exitCode).toBe(exit);
      expect((err as CliError).next).toContain("acme/app");
    }
    gh.fetchHistory.mockRejectedValue(new Error("socket hang up"));
    const err = (await runScan(fixtures, { repo: "acme/app", token: "t_test" }).catch((e: unknown) => e)) as CliError;
    expect(err.code).toBe("GITHUB_ERROR");
    expect(err.exitCode).toBe(4);
  });
});

describe("scan pins action tags for R17", () => {
  type Pin = { ruleId: string; diff: string | null; evidence: { references: Array<{ uses: string; sha: string | null }> } };
  const r17 = (findings: Pin[]) => findings.filter((f) => f.ruleId === "R17");

  it("looks each tag up once on GitHub with the token and gives the finding a diff pinning to the SHA", async () => {
    fetchStub.mockImplementation(() => Promise.resolve(new Response(SHA)));
    const r = await runScan(fixtures, { token: "t_test", rules: "R17" });
    const urls = fetchStub.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls.sort()).toEqual(["https://api.github.com/repos/actions/checkout/commits/v4", "https://api.github.com/repos/actions/setup-node/commits/v4"]);
    const found = r17(r.findings as unknown as Pin[]);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.diff).toContain(`+      - uses: actions/checkout@${SHA} # v4`);
      expect(f.evidence.references.every((ref) => ref.sha === SHA)).toBe(true);
    }
  });

  it("keeps the finding without a diff when GitHub does not answer", async () => {
    const r = await runScan(fixtures, { token: "t_test", rules: "R17" });
    expect(fetchStub).toHaveBeenCalled();
    for (const f of r17(r.findings as unknown as Pin[])) expect(f.diff).toBeNull();
  });

  it("skips the lookups with --no-resolve and when R17 is not among the rules", async () => {
    await runScan(fixtures, { token: "t_test", resolve: false });
    await runScan(fixtures, { token: "t_test", rules: "R01,R06" });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("scan without --repo in a GitHub checkout", () => {
  /**
   * A git checkout whose origin is github.com/acme/app, holding the fixture workflows. Git runs hooks
   * with GIT_DIR and friends pointing at the real repository, and these tests run in the pre-push hook,
   * so every git call here drops them; otherwise `git init` re-initialises the real repository.
   */
  const cleanGitEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  function checkout(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "buildhound-checkout-"));
    cpSync(path.join(fixtures, ".github"), path.join(dir, ".github"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, env: cleanGitEnv() });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: dir, env: cleanGitEnv() });
    return dir;
  }

  it("finds the repository from git and reads its run history against the local workflow files", async () => {
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, workflows: [], history: history() });
    const dir = checkout();
    const r = await runScan(dir, { token: "t_test" });
    expect(gh.fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repo: "app" }));
    expect(r.repo).toBe("acme/app");
    expect(r.history_days).toBe(30);
    expect(r.workflows.map((w) => w.path)).toContain(".github/workflows/ios.yml"); // local files, not the empty remote list
    expect(r.assumptions[0]).toContain("found from the git remote");
    expect(r.next).toContain("buildhound route");
  });

  it("stays static with --offline and never calls GitHub", async () => {
    const r = await runScan(checkout(), { token: "t_test", offline: true });
    expect(gh.fetchHistory).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(r.history_days).toBeNull();
  });

  it("stays static, with a note, when GitHub cannot be read", async () => {
    gh.fetchHistory.mockRejectedValue(Object.assign(new Error("HTTP 404"), { status: 404 }));
    const r = await runScan(checkout(), { token: "t_test" });
    expect(r.history_days).toBeNull();
    expect(r.repo).toBe("acme/app");
    expect(r.assumptions[0]).toContain("could not be read");
    expect(r.next).toContain("--repo acme/app");
  });

  it("stays static, with a note, when there is no GitHub login", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "buildhound-gitonly-"));
    symlinkSync(execFileSync("/usr/bin/which", ["git"]).toString().trim(), path.join(bin, "git"));
    const saved = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    process.env.PATH = bin;
    process.env.GITHUB_TOKEN = "";
    try {
      const r = await runScan(checkout(), {});
      expect(gh.fetchHistory).not.toHaveBeenCalled();
      expect(r.history_days).toBeNull();
      expect(r.assumptions[0]).toContain("No GitHub login found");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    }
  });
});

describe("route --repo", () => {
  it("uses observed minutes and peak concurrency for the payback", async () => {
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content: iosContent }], history: history() });
    const r = await runRoute(fixtures, { repo: "acme/app", token: "t_test" });
    const lint = r.jobs.find((j) => j.job === "lint")!;
    expect(lint.current.basis).toBe("history");
    expect(lint.current.minutes_per_month).toBe(700); // 70 runs x 10 minutes
    expect(lint.payback.peak_concurrency).toBe(2);
    expect(lint.payback.machines_needed).toBe(1);
    expect(lint.candidates[0]!.cents_per_month + lint.candidates[0]!.monthly_fixed_cents).toBeLessThanOrEqual(lint.candidates[1]!.cents_per_month + lint.candidates[1]!.monthly_fixed_cents);
    expect(r.next).toContain("buildhound rates");
  });

  it("recognises routed jobs and upgrades a public repository's expressions to the trusted-events form", async () => {
    const legacy = "${{ github.event.pull_request.head.repo.fork && 'macos-latest' || vars.BUILDHOUND_MACOS || 'macos-latest' }}";
    const routed = iosContent.replace("    runs-on: macos-latest\n    timeout-minutes: 45", `    runs-on: ${legacy} # the office Mac\n    timeout-minutes: 45`);
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: false, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content: routed }], history: history() });
    const r = await runRoute(fixtures, { repo: "acme/app", token: "t_test" });
    const trusted = "${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'release') && vars.BUILDHOUND_MACOS || 'macos-latest' }}";
    expect(r.upgrades).toEqual([{ workflow: ".github/workflows/ios.yml", jobs: [{ job: "build", from: legacy, to: trusted }], diff: expect.any(String) }]);
    expect(r.upgrades[0]!.diff).toContain(`-    runs-on: ${legacy} # the office Mac`);
    expect(r.upgrades[0]!.diff).toContain(`+    runs-on: ${trusted} # the office Mac`);
    expect(r.jobs.some((j) => j.job === "build")).toBe(false);
    // ios.yml has no permissions block and the default token was not read, so build counts as able to write: route --apply moves it to the trusted variable.
    expect(r.skipped.find((j) => j.job === "build")!.reason).toMatch(/^routed by vars\.BUILDHOUND_MACOS, but .*moves it to vars\.BUILDHOUND_MACOS_TRUSTED$/);
    expect(r.assumptions.some((a) => a.startsWith("public repository: a connected machine takes only push"))).toBe(true);
  });

  it("leaves a job that runs alone on a machine (-exclusive) as written: it never falls back (B09)", async () => {
    const exclusive = iosContent.replace("    runs-on: macos-latest\n    timeout-minutes: 45", "    runs-on: buildhound-macos-exclusive\n    timeout-minutes: 45");
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content: exclusive }], history: history() });
    const r = await runRoute(fixtures, { repo: "acme/app", token: "t_test" });
    expect(r.jobs.some((j) => j.job === "build")).toBe(false);
    expect(r.skipped.find((j) => j.job === "build")!.reason).toContain("-exclusive");
    expect(r.upgrades).toEqual([]);
  });

  it("names the routing expression for the repository's visibility as the runs-on to write", async () => {
    // A public repository on GitHub-hosted is free and skipped, so the public case starts from a paid vendor label.
    const onDepot = iosContent.replace("    runs-on: macos-latest\n    steps", "    runs-on: depot-macos-latest\n    steps");
    for (const isPrivate of [true, false]) {
      // A read-only token, so no job is secret-bearing (a job without a permissions block on a repository whose default could not be read would be).
      const content = (isPrivate ? iosContent : onDepot).replace("\non:\n", "\npermissions:\n  contents: read\non:\n");
      gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: isPrivate, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content }], history: history() });
      const r = await runRoute(fixtures, { repo: "acme/app", token: "t_test", providers: "buildhound" });
      const lint = r.jobs.find((j) => j.job === "lint")!;
      expect(r.upgrades).toEqual([]);
      expect(lint.action).toBe("move");
      expect(lint.recommended).toBe("buildhound-macos");
      if (isPrivate) expect(lint.runs_on).toBe("${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}");
      else expect(lint.runs_on).toBe("${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'release') && vars.BUILDHOUND_MACOS || 'depot-macos-latest' }}");
    }
  });
});

describe("route sends secret-bearing jobs to Trusted machines only", () => {
  it("gives a job that reads secrets, has an environment or may write the trusted expression, never the plain one (CLAUDE.md rule 19)", async () => {
    const deploy = `name: Deploy\non: push\npermissions:\n  contents: read\njobs:\n  ship:\n    runs-on: macos-latest\n    environment: production\n    steps:\n      - run: ./deploy.sh\n        env:\n          KEY: \${{ secrets.DEPLOY_KEY }}\n  lint:\n    runs-on: macos-latest\n    steps:\n      - run: npm run lint\n  sign:\n    runs-on: \${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}\n    steps:\n      - run: ./sign.sh\n        env:\n          CERT: \${{ secrets.CERT }}\n`;
    // Thirty-minute runs, so both jobs are over the threshold and a connected machine ranks first.
    const h = history();
    h.jobs = h.jobs.map((j) => ({ ...j, completedAt: new Date(j.startedAt!.getTime() + minutes(30)) }));
    h.jobs.push(...h.jobs.map((j) => ({ ...j, id: j.id + 1000, name: "ship" })));
    gh.fetchHistory.mockResolvedValue({ repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, workflows: [{ path: ".github/workflows/ios.yml", content: deploy }], history: h });
    const r = await runRoute(fixtures, { repo: "acme/app", token: "t_test", providers: "buildhound" });
    const ship = r.jobs.find((j) => j.job === "ship")!;
    const lint = r.jobs.find((j) => j.job === "lint")!;
    expect(ship.secrets).toEqual(expect.arrayContaining(["jobs.ship.environment: production"]));
    expect(ship.candidates[0]!.provider).toBe("buildhound");
    expect(ship).toMatchObject({ action: "move", trusted: true, recommended: "buildhound-macos", runs_on: "${{ vars.BUILDHOUND_MACOS_TRUSTED || 'macos-latest' }}" });
    expect(lint.secrets).toEqual([]);
    expect(lint).toMatchObject({ action: "move", trusted: false, runs_on: "${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}" });
    expect(r.assumptions.some((a) => a.includes("only a machine a person marked Trusted may run it reads BUILDHOUND_MACOS_TRUSTED"))).toBe(true);
    // Already on the plain variable and able to reach secrets: route says route --apply moves it to the trusted one.
    expect(r.skipped.find((x) => x.job === "sign")!.reason).toMatch(/route --apply moves it to vars\.BUILDHOUND_MACOS_TRUSTED$/);
    expect(prettyRoute(r)).toContain("Only Trusted machines take it, since it can reach secrets");
  });
});

describe("routing fallback", () => {
  const base = { minutesPerMonth: 1000, peakConcurrency: 1, measuredDurationFactors: {}, config: DEFAULT_RULE_CONFIG, repositoryPrivate: true };

  it("ranks by computed cost, keeps stay, never uses vendor claims and compares macOS with Xcode Cloud", () => {
    const r = routingCandidates({ ...base, jobId: "build", labels: ["macos-latest"] });
    expect(r.current.centsPerMonth).toBe(6200);
    const stay = r.candidates.find((c) => c.label === "macos-latest")!;
    expect(stay.savingCents).toBe(0);
    expect(stay.installed).toBe(true);
    for (let i = 1; i < r.candidates.length; i++) expect(r.candidates[i - 1]!.centsPerMonth + r.candidates[i - 1]!.monthlyFixedCents).toBeLessThanOrEqual(r.candidates[i]!.centsPerMonth + r.candidates[i]!.monthlyFixedCents);
    for (const c of r.candidates) {
      expect(c.durationFactor).toBe(1);
      expect(c.referralAgreement).toBe(false);
    }
    const machine = r.candidates.find((c) => c.provider === "buildhound")!;
    expect(machine.pricePerMinute).toBe(0);
    expect(machine.monthlyFixedCents).toBe(2400);
    expect(machine.savingCents).toBe(3800);
    expect(r.candidates.some((c) => c.provider === "ubicloud")).toBe(false); // no macOS at Ubicloud
    expect(r.xcodeCloud?.tier).toEqual({ hours: 25, usd: 0 });
  });

  it("honours account overrides and provider lists for Linux jobs", () => {
    const r = routingCandidates({ ...base, jobId: "test", labels: ["ubuntu-latest"], config: { ...DEFAULT_RULE_CONFIG, routing: { ...DEFAULT_RULE_CONFIG.routing, providers: ["ubicloud", "blacksmith"], installed: ["blacksmith"] } }, overrides: { blacksmith: 0.001 } });
    expect(r.xcodeCloud).toBeUndefined();
    expect(r.candidates.map((c) => c.provider).sort()).toEqual(["blacksmith", "github", "ubicloud"]);
    const bs = r.candidates.find((c) => c.provider === "blacksmith")!;
    expect(bs.pricePerMinute).toBe(0.001);
    expect(bs.rateConfidence).toBe("high");
    expect(bs.installed).toBe(true);
    expect(r.candidates.find((c) => c.provider === "ubicloud")!.label).toBe("ubicloud-standard-2");
  });

  it("peak concurrency counts overlapping observed jobs by name", () => {
    expect(peakConcurrency(null, "lint")).toBe(1);
    expect(peakConcurrency(history(), "lint")).toBe(2);
    expect(peakConcurrency(history(), "build")).toBe(1);
  });
});

describe("buildhound.toml", () => {
  it("maps rules, routing and runner overrides", () => {
    const c = parseConfig(
      `[attribution]\nagent_prefixes = ["claude/"]\n[check]\nfail_on_severity = "medium"\n[rules]\ndisabled = ["R08"]\n[routing]\nproviders = ["blacksmith", "depot"]\ninstalled = ["blacksmith"]\nmin_saving_percent = 30\nmin_job_usd_per_month = 50\n[runners.self_hosted]\nusd_per_minute = 0.002\n[runners.runs_on]\nusd_per_minute = 0.0009\nlicense_usd_per_month = 27\n[runners.namespace.profiles."big-apple"]\nusd_per_minute = 0.05\n[runners.depot]\nplan_usd_per_month = 200\nincluded_minutes = 20000\n`,
      "/repo/buildhound.toml",
    );
    expect(c.rules).toEqual({ agentPrefixes: ["claude/"], disabledRules: ["R08"], routing: { providers: ["blacksmith", "depot"], installed: ["blacksmith"], minSavingPercent: 30, minJobCentsPerMonth: 5000 } });
    expect(c.overrides).toEqual({ self_hosted: 0.002, runs_on: 0.0009, "namespace:namespace-profile-big-apple": 0.05 });
    expect(c.fixedCosts).toEqual({ runs_on: { monthlyFixedCents: 2700, includedMinutes: 0 }, depot: { monthlyFixedCents: 20000, includedMinutes: 20000 } });
    expect(c.check.failOnSeverity).toBe("medium");
    expect(c.routingEnabled).toBe(true);
  });

  it("rejects invalid TOML with a CliError", () => {
    expect(() => parseConfig("[rules\n", "/repo/buildhound.toml")).toThrow(CliError);
  });

  it("an empty file is fine", () => {
    const c = parseConfig("", "/repo/buildhound.toml");
    expect(c.rules).toEqual({});
    expect(c.overrides).toEqual({});
  });
});

describe("repository name from git remote", () => {
  it("parses https, ssh and git urls", () => {
    expect(repoFromRemote("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repoFromRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoFromRemote("ssh://git@github.com/acme/app")).toBe("acme/app");
    expect(repoFromRemote("https://gitlab.com/acme/app.git")).toBeNull();
  });
});

describe("the saving on a machine you already have", () => {
  const p = { hosted_cents_per_month: 8900, macos_cents_per_month: 8900, machine_fee_cents: 2400, machines_needed: 1, monthly_saving_cents: 6500 };
  it("scan names the monthly saving after the plan, with no hardware and no payback period", () => {
    expect(ownedSavingLine(p)).toBe("A Mac you already have would save $65.00 a month on these jobs, after Team at $24 a month.");
    expect(ownedSavingLine({ ...p, macos_cents_per_month: 4000, machines_needed: 2, monthly_saving_cents: 4100 })).toBe("2 machines you already have would save $41.00 a month on these jobs, after Team at $24 a machine a month.");
    expect(ownedSavingLine({ ...p, hosted_cents_per_month: 600, macos_cents_per_month: 600, monthly_saving_cents: -1800 })).toBe("At $6.00 a month on GitHub-hosted, Team at $24 a month costs more than these jobs, so a Mac you already have would add speed, not savings.");
    expect(ownedSavingLine({ ...p, hosted_cents_per_month: 0, macos_cents_per_month: 0, monthly_saving_cents: -2400 })).toBe("No macOS or Linux jobs here run on GitHub-hosted, so a machine you already have would add speed, not savings.");
  });

  it("scan's human output and JSON keep the saving and never price a Mac mini", async () => {
    const r = await runScan(fixtures, { offline: true });
    expect(r.payback.monthly_saving_cents).toBe(r.payback.hosted_cents_per_month - r.payback.machine_fee_cents * r.payback.machines_needed);
    expect(r.payback).toHaveProperty("hardware_cents");
    expect(r.payback).toHaveProperty("payback_months");
    expect(prettyScan(r)).not.toMatch(/Mac mini|\$899|pays? for itself|pay back/);
    expect(prettyScan(r)).toContain("you already have");
  });

  it("route says the saving for one job, or that it adds speed, not savings", () => {
    const j = { machine_fee_cents: 2400, hardware_cents: 89900, peak_concurrency: 2, machines_needed: 1, monthly_saving_cents: 10000, payback_months: 9 };
    expect(ownedRouteLine(j)).toBe("On machines you already have: 1 machine for 2 jobs at once, saves $100.00 a month after Team at $24 a machine a month.");
    expect(ownedRouteLine({ ...j, monthly_saving_cents: -400, payback_months: null })).toBe("On machines you already have: 1 machine for 2 jobs at once; Team at $24 a machine a month costs more than this job, so it adds speed, not savings.");
  });
});
