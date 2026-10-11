import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_RULE_CONFIG } from "@buildhound/core";
import type { History } from "@buildhound/core";
import { runScan } from "./commands/scan";
import { runRoute } from "./commands/route";
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

beforeEach(() => {
  gh.fetchHistory.mockReset();
  gh.createGitHubClient.mockClear();
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

describe("scan without --repo in a GitHub checkout", () => {
  /** A git checkout whose origin is github.com/acme/app, holding the fixture workflows. */
  function checkout(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "buildhound-checkout-"));
    cpSync(path.join(fixtures, ".github"), path.join(dir, ".github"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: dir });
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
    expect(machine.monthlyFixedCents).toBe(2000);
    expect(machine.savingCents).toBe(4200);
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
