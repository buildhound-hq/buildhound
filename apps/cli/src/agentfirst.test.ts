import { describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = inject("cliBin");
const fixtures = path.join(here, "..", "fixtures");
const emptyFixtures = path.join(fixtures, "empty");
const iosYml = path.join(fixtures, ".github", "workflows", "ios.yml");
const nightlyYml = path.join(fixtures, ".github", "workflows", "nightly.yml");

/**
 * Every command runs as a child process with stdout piped (no TTY), no GitHub token and an empty PATH,
 * so neither `gh` nor `git` can be found and nothing can reach the network. Scans pass --no-resolve so R17
 * does not look action tags up on GitHub.
 */
async function cli(args: string[], cwd = here) {
  const env = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", PATH: mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-")), INIT_CWD: "" };
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { env, cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

function singleJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  expect(lines, "exactly one line of JSON on stdout").toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function expectErrorEnvelope(r: { code: number; stdout: string }, code: string, exit: number) {
  expect(r.code).toBe(exit);
  const obj = singleJson(r.stdout) as { error: { code: string; message: string; next: string } };
  expect(obj.error.code).toBe(code);
  expect(obj.error.message).toBeTruthy();
  expect(obj.error.next).toBeTruthy();
  expect(r.stdout).not.toMatch(/\n\s+at /);
  expect(r.stdout).not.toMatch(/at .*\.[cm]?[jt]s:\d+/);
  return obj;
}

type Finding = { ruleId: string; severity: string; estimate: { centsPerMonth: number } };

describe("agentfirst: scan", () => {
  it("agentfirst: scan prints one JSON object with workflows, findings, totals, assumptions and next", async () => {
    const r = await cli(["scan", fixtures, "--no-resolve"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { repo: string; workflows: Array<{ path: string; jobs: unknown[]; estimate: { cents_per_month: number } }>; findings: Finding[]; totals: Record<string, number>; assumptions: string[]; rules: string[]; next: string };
    expect(obj.repo).toBe("local/repo");
    expect(obj.workflows.map((w) => w.path)).toEqual([".github/workflows/ios.yml", ".github/workflows/nightly.yml"]);
    expect(obj.workflows[0]!.jobs).toHaveLength(2);
    expect(obj.workflows[0]!.estimate.cents_per_month).toBeGreaterThan(0);
    expect(Array.isArray(obj.findings)).toBe(true);
    expect(obj.totals.minutes_per_month).toBeGreaterThan(0);
    expect(obj.totals.cents_per_month).toBeGreaterThan(0);
    expect(obj.assumptions.length).toBeGreaterThan(0);
    expect(obj.rules).toContain("R01");
    expect(obj.next).toContain("--repo");
    // Findings, once the rules land, are sorted by cents descending and each carries evidence, estimate and severity.
    for (let i = 1; i < obj.findings.length; i++) expect(obj.findings[i - 1]!.estimate.centsPerMonth).toBeGreaterThanOrEqual(obj.findings[i]!.estimate.centsPerMonth);
    for (const f of obj.findings) {
      expect(f.ruleId).toMatch(/^R\d\d$/);
      expect(["high", "medium", "low"]).toContain(f.severity);
    }
  });

  it("agentfirst: scan --fail-on exits 1 exactly when a finding at that severity exists", async () => {
    const r = await cli(["scan", fixtures, "--fail-on", "low", "--no-resolve"]);
    const obj = singleJson(r.stdout) as { findings: Finding[]; failed: boolean; fail_on: string };
    expect(obj.fail_on).toBe("low");
    expect(obj.failed).toBe(obj.findings.length > 0);
    expect(r.code).toBe(obj.findings.length > 0 ? 1 : 0);
    const high = await cli(["scan", fixtures, "--fail-on", "high", "--no-resolve"]);
    const h = singleJson(high.stdout) as { findings: Finding[] };
    expect(high.code).toBe(h.findings.some((f) => f.severity === "high") ? 1 : 0);
  });

  it("agentfirst: scan --fail-on exits 0 on a workflow with no jobs", async () => {
    const r = await cli(["scan", emptyFixtures, "--fail-on", "low", "--no-resolve"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { findings: unknown[]; workflows: unknown[]; failed: boolean };
    expect(obj.findings).toEqual([]);
    expect(obj.workflows).toHaveLength(1);
    expect(obj.failed).toBe(false);
  });

  it("agentfirst: scan --rules limits the rules that run", async () => {
    const r = await cli(["scan", fixtures, "--rules", "R01,R06", "--no-resolve"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { rules: string[]; findings: Finding[] };
    expect(obj.rules).toEqual(["R01", "R06"]);
    for (const f of obj.findings) expect(["R01", "R06"]).toContain(f.ruleId);
  });

  it("agentfirst: scan reads buildhound.toml for disabled rules and the routing threshold", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "buildhound-toml-"));
    cpSync(path.join(fixtures, ".github"), path.join(dir, ".github"), { recursive: true });
    writeFileSync(path.join(dir, "buildhound.toml"), '[rules]\ndisabled = ["R06"]\n\n[routing]\nmin_job_usd_per_month = 1000\n\n[runners.self_hosted]\nusd_per_minute = 0.002\n');
    const scan = singleJson((await cli(["scan", dir, "--no-resolve"])).stdout) as { rules: string[]; assumptions: string[] };
    expect(scan.rules).not.toContain("R06");
    expect(scan.rules).toContain("R01");
    expect(scan.assumptions.some((a) => a.includes("buildhound.toml"))).toBe(true);
    const route = singleJson((await cli(["route", dir])).stdout) as { threshold_cents_per_month: number; jobs: unknown[]; skipped: unknown[] };
    expect(route.threshold_cents_per_month).toBe(100000);
    expect(route.jobs).toEqual([]);
    expect(route.skipped.length).toBeGreaterThan(0);
    const rates = singleJson((await cli(["rates"], dir)).stdout) as { overrides: Record<string, number> };
    expect(rates.overrides).toEqual({ self_hosted: 0.002 });
  });

  it("agentfirst: scan --repo without a token asks for one with the gh command", async () => {
    const r = await cli(["scan", fixtures, "--repo", "acme/app"]);
    const obj = expectErrorEnvelope(r, "TOKEN_REQUIRED", 3);
    expect(obj.error.next).toContain("--token $(gh auth token)");
    expect(obj.error.next).toContain("--repo acme/app");
  });
});

describe("agentfirst: estimate", () => {
  it("agentfirst: estimate prints the monthly cost of one workflow with assumptions", async () => {
    const r = await cli(["estimate", iosYml]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { workflow: string; runs_per_month: number; runs_by_event: Record<string, number>; jobs: Array<{ id: string; os: string; minutes_per_month: number; cents_per_month: number }>; minutes_per_month: number; cents_per_month: number; assumptions: string[]; next: string };
    expect(obj.workflow).toBe(".github/workflows/ios.yml");
    expect(obj.runs_by_event).toEqual({ push: 60, pull_request: 40 });
    expect(obj.runs_per_month).toBe(100);
    expect(obj.jobs.map((j) => j.id)).toEqual(["lint", "build"]);
    expect(obj.jobs[0]!.os).toBe("macos");
    expect(obj.jobs[0]!.minutes_per_month).toBe(800);
    expect(obj.jobs[0]!.cents_per_month).toBe(4960);
    expect(obj.cents_per_month).toBe(9920);
    expect(obj.assumptions.some((a) => a.includes("no history"))).toBe(true);
    expect(obj.next).toContain("buildhound scan");
  });

  it("agentfirst: estimate --runs-per-month overrides every event", async () => {
    const r = await cli(["estimate", nightlyYml, "--runs-per-month", "10"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { runs_per_month: number; runs_by_event: Record<string, number>; jobs: Array<{ minutes_per_month: number; cents_per_month: number }>; assumptions: string[] };
    expect(obj.runs_by_event).toEqual({ schedule: 10, workflow_dispatch: 10 });
    expect(obj.runs_per_month).toBe(20);
    expect(obj.jobs[0]!.minutes_per_month).toBe(80);
    expect(obj.jobs[0]!.cents_per_month).toBe(48);
    expect(obj.assumptions.some((a) => a.includes("--runs-per-month"))).toBe(true);
  });

  it("agentfirst: estimate counts a five-minute cron as 8640 runs a month", async () => {
    const obj = singleJson((await cli(["estimate", nightlyYml])).stdout) as { runs_by_event: Record<string, number> };
    expect(obj.runs_by_event.schedule).toBe(8640);
  });
});

describe("agentfirst: route", () => {
  it("agentfirst: route lists ranked candidates including stay, payback and the Xcode Cloud comparison for macOS", async () => {
    const r = await cli(["route", fixtures]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as {
      jobs: Array<{ workflow: string; job: string; current: { label: string; cents_per_month: number; os: string }; candidates: Array<{ label: string; provider: string; cents_per_month: number; monthly_fixed_cents: number; saving_cents: number; installed: boolean; referral_agreement: boolean; duration_factor: number }>; recommended: string; runs_on: string; action: string; payback: { machines_needed: number; monthly_saving_cents: number; payback_months: number | null }; xcode_cloud: { cents_per_month: number } | null }>;
      threshold_cents_per_month: number;
      upgrades: unknown[];
      assumptions: string[];
      next: string;
    };
    expect(obj.threshold_cents_per_month).toBe(2000);
    expect(obj.jobs.length).toBeGreaterThanOrEqual(3);
    expect(obj.next).toContain("--repo");
    expect(obj.upgrades).toEqual([]);
    expect(obj.assumptions.some((a) => a.startsWith("repository visibility not read from GitHub"))).toBe(true);
    for (const j of obj.jobs) {
      expect(j.current.cents_per_month).toBeGreaterThanOrEqual(2000);
      expect(j.candidates.some((c) => c.label === j.current.label)).toBe(true);
      for (let i = 1; i < j.candidates.length; i++) {
        expect(j.candidates[i - 1]!.cents_per_month + j.candidates[i - 1]!.monthly_fixed_cents).toBeLessThanOrEqual(j.candidates[i]!.cents_per_month + j.candidates[i]!.monthly_fixed_cents);
      }
      for (const c of j.candidates) {
        expect(c.duration_factor).toBe(1);
        expect(typeof c.installed).toBe("boolean");
        expect(typeof c.referral_agreement).toBe("boolean");
      }
      expect(["stay", "move"]).toContain(j.action);
      expect(j.candidates.map((c) => c.label)).toContain(j.recommended);
      expect(j.runs_on).toBe(j.action === "move" && j.recommended.startsWith("buildhound-") ? `\${{ vars.BUILDHOUND_${j.current.os === "macos" ? "MACOS" : "LINUX_X64"} || '${j.current.label}' }}` : j.recommended);
      expect(j.payback.machines_needed).toBe(1);
      expect(j.payback.monthly_saving_cents).toBe(j.current.cents_per_month - 2400);
      if (j.current.os === "macos") {
        expect(j.xcode_cloud).not.toBeNull();
        expect(j.xcode_cloud!.cents_per_month).toBeGreaterThan(0);
        expect(j.candidates.some((c) => c.provider === "buildhound")).toBe(true);
      } else {
        expect(j.xcode_cloud).toBeNull();
      }
    }
  });

  it("agentfirst: route --providers limits the candidates", async () => {
    const obj = singleJson((await cli(["route", fixtures, "--providers", "ubicloud"])).stdout) as { providers: string[]; jobs: Array<{ current: { os: string; provider: string }; candidates: Array<{ provider: string }> }> };
    expect(obj.providers).toEqual(["ubicloud"]);
    for (const j of obj.jobs) {
      const others = j.candidates.filter((c) => c.provider !== j.current.provider).map((c) => c.provider);
      expect(others.every((p) => p === "ubicloud")).toBe(true);
      if (j.current.os === "macos") expect(others).toEqual([]);
    }
  });

  it("agentfirst: route --repo without a token asks for one", async () => {
    expectErrorEnvelope(await cli(["route", fixtures, "--repo", "acme/app"]), "TOKEN_REQUIRED", 3);
  });
});

describe("agentfirst: rates", () => {
  it("agentfirst: rates prints every table with source and verified date", async () => {
    const r = await cli(["rates", "--json"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { tables: Array<{ provider: string; source: string; verifiedAt: string; rates: Array<{ pricePerMinute: number }>; tiers: unknown[] | null }>; next: string };
    expect(obj.tables[0]!.provider).toBe("github");
    expect(obj.tables[0]!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const providers = obj.tables.map((t) => t.provider);
    for (const p of ["github", "blacksmith", "depot", "warpbuild", "ubicloud", "jog", "runs_on", "buildhound", "xcode_cloud"]) expect(providers).toContain(p);
    for (const t of obj.tables) {
      expect(t.source).toMatch(/^https:\/\//);
      expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.rates.length).toBeGreaterThan(0);
    }
    expect(obj.tables.find((t) => t.provider === "xcode_cloud")!.tiers).toHaveLength(5);
    expect(obj.next).toBeTruthy();
  });

  it("agentfirst: rates --provider filters to one table", async () => {
    const obj = singleJson((await cli(["rates", "--provider", "blacksmith"])).stdout) as { tables: Array<{ provider: string }> };
    expect(obj.tables.map((t) => t.provider)).toEqual(["blacksmith"]);
  });
});

describe("agentfirst: errors", () => {
  const cases: Array<{ name: string; args: string[]; code: string; exit: number }> = [
    { name: "unknown rule id", args: ["scan", fixtures, "--rules", "R99"], code: "UNKNOWN_RULE", exit: 2 },
    { name: "bad --fail-on value", args: ["scan", fixtures, "--fail-on", "bogus"], code: "USAGE", exit: 2 },
    { name: "bad --days value", args: ["scan", fixtures, "--repo", "acme/app", "--days", "0"], code: "USAGE", exit: 2 },
    { name: "unknown option", args: ["scan", fixtures, "--bogus"], code: "USAGE", exit: 2 },
    { name: "unknown command", args: ["bogus"], code: "USAGE", exit: 2 },
    { name: "no command", args: [], code: "USAGE", exit: 2 },
    { name: "path that does not exist", args: ["scan", "/nonexistent/path"], code: "PATH_NOT_FOUND", exit: 2 },
    { name: "repo that is not owner/name", args: ["scan", fixtures, "--repo", "acme"], code: "REPO_INVALID", exit: 2 },
    { name: "estimate missing argument", args: ["estimate"], code: "USAGE", exit: 2 },
    { name: "estimate file that does not exist", args: ["estimate", "/nonexistent.yml"], code: "FILE_NOT_FOUND", exit: 2 },
    { name: "estimate bad runs", args: ["estimate", iosYml, "--runs-per-month", "many"], code: "USAGE", exit: 2 },
    { name: "route unknown provider", args: ["route", fixtures, "--providers", "nope"], code: "UNKNOWN_PROVIDER", exit: 2 },
    { name: "rates unknown provider", args: ["rates", "--provider", "nope"], code: "UNKNOWN_PROVIDER", exit: 2 },
  ];
  for (const c of cases) {
    it(`agentfirst: ${c.name} prints one JSON error with code, message and next and no stack trace`, async () => {
      expectErrorEnvelope(await cli(c.args), c.code, c.exit);
    });
  }

  it("agentfirst: --help and --version exit 0 without a JSON error", async () => {
    expect((await cli(["--version"])).code).toBe(0);
    expect((await cli(["scan", "--help"])).code).toBe(0);
  });
});
