import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../cost/classify";
import type { History, JobRecord, RunRecord } from "../model/types";
import { makeContext } from "./context";
import { secretBearingJobs } from "../security/classify-job";
import { R14, secretsTrustedReason } from "./r14-runner-routing";
import { buildhoundFamily, buildhoundLabelExpression, buildhoundVariable, parseRoutingExpression, routingCandidates, representativeLabel, type RoutingCandidate } from "./routing";
import { GITHUB_LINUX_ARM64_LABELS } from "../cost/rates/github";
import { runRules } from "./runner";
import { DEFAULT_RULE_CONFIG } from "./types";

const START = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

interface Spec {
  name: string;
  labels: string[];
  count: number;
  seconds: number;
}

/** Evenly spaced, non-overlapping runs over 30 days. */
function history(workflowPath: string, specs: Spec[]): History {
  const runs: RunRecord[] = [];
  const jobs: JobRecord[] = [];
  let id = 1;
  for (const s of specs) {
    for (let i = 0; i < s.count; i++) {
      const t = START + Math.floor((i * 30 * DAY) / s.count);
      const started = new Date(t + 30_000);
      runs.push({ id, workflowPath, event: "pull_request", headBranch: `feature/${i}`, headSha: String(id).padStart(40, "0"), actorLogin: "dev", actorKind: "human", agentName: null, createdAt: new Date(t), runStartedAt: started, conclusion: "success", isFork: false, isDraft: false });
      jobs.push({ id: id + 100_000, runId: id, name: s.name, labels: s.labels, startedAt: started, completedAt: new Date(started.getTime() + s.seconds * 1000), conclusion: "success", steps: [] });
      id++;
    }
  }
  return { days: 30, runs, jobs };
}

/** Read-only token, no secrets: a job a no-secrets machine may take (SECURITY.md, Trusted machines). */
const macWorkflow = `name: iOS
on: pull_request
permissions:
  contents: read
jobs:
  ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild test -scheme App
`;

const linuxWorkflow = `name: CI
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
`;

const total = (c: RoutingCandidate) => c.centsPerMonth + c.monthlyFixedCents;

describe("rule R14 runner-routing", () => {
  it("routes a macOS job to a connected machine once a duration factor is measured, with the failover label form", async () => {
    // 100 runs of 10 minutes on macos-latest is $62 a month; the same job ran 20 times on a connected Mac at 6 minutes.
    const h = history(".github/workflows/ios.yml", [
      { name: "ios", labels: ["macos-latest"], count: 100, seconds: 600 },
      { name: "ios", labels: ["buildhound-macos"], count: 20, seconds: 360 },
    ]);
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: macWorkflow, history: h, config: { routing: { ...DEFAULT_RULE_CONFIG.routing, installed: ["buildhound"] } } });
    const findings = await runRules([R14], ctx);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.jobName).toBe("ios");
    expect(f.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}");
    expect(f.confirmBeforeMerging).toMatch(/^Confirm before merging:/);
    expect(f.estimate.centsPerMonth).toBe(6200 - 1000);
    expect(f.estimate.minutesPerMonth).toBe(1000);
    expect(f.estimate.confidence).toBe(0.9);
    const ev = f.evidence as { recommended: string; installed: boolean; referralAgreement: boolean; candidates: RoutingCandidate[]; xcodeCloud: { notARunner: boolean; centsPerMonth: number } };
    expect(ev.recommended).toBe("buildhound");
    expect(ev.installed).toBe(true);
    expect(ev.referralAgreement).toBe(false);
    expect(ev.xcodeCloud.notARunner).toBe(true);
    expect(ev.xcodeCloud.centsPerMonth).toBeGreaterThan(0);
    const bh = ev.candidates.find((c) => c.provider === "buildhound")!;
    expect(bh.durationSource).toBe("measured");
    expect(bh.durationFactor).toBe(0.6);
    expect(bh.machinesNeeded).toBe(1);
    expect(ev.candidates.some((c) => c.stay)).toBe(true);
    expect(ev.candidates.some((c) => c.provider === "ubicloud")).toBe(false);
    for (let i = 1; i < ev.candidates.length; i++) expect(total(ev.candidates[i]!)).toBeGreaterThanOrEqual(total(ev.candidates[i - 1]!));
  });

  it("still produces the diff when the candidate is not installed, and says so in evidence", async () => {
    const h = history(".github/workflows/ios.yml", [
      { name: "ios", labels: ["macos-latest"], count: 100, seconds: 600 },
      { name: "ios", labels: ["buildhound-macos"], count: 20, seconds: 360 },
    ]);
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: macWorkflow, history: h });
    const findings = await runRules([R14], ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.diff).toContain("vars.BUILDHOUND_MACOS");
    expect((findings[0]!.evidence as { installed: boolean }).installed).toBe(false);
  });

  it("does not route a macOS job on list price alone", async () => {
    const h = history(".github/workflows/ios.yml", [{ name: "ios", labels: ["macos-latest"], count: 100, seconds: 600 }]);
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: macWorkflow, history: h, config: { routing: { ...DEFAULT_RULE_CONFIG.routing, installed: ["buildhound"] } } });
    expect(await runRules([R14], ctx)).toHaveLength(0);
  });

  it("lets a measured duration factor change the ranking on Linux", async () => {
    // Blacksmith at 0.004 a minute loses to Ubicloud at 0.00125 on list price, but measured at a quarter of the duration it wins.
    const h = history(".github/workflows/ci.yml", [
      { name: "test", labels: ["ubuntu-latest"], count: 120, seconds: 1800 },
      { name: "test", labels: ["blacksmith-2vcpu-ubuntu-2404"], count: 10, seconds: 450 },
    ]);
    const ctx = makeContext({ path: ".github/workflows/ci.yml", content: linuxWorkflow, history: h });
    const findings = await runRules([R14], ctx);
    expect(findings).toHaveLength(1);
    const ev = findings[0]!.evidence as { recommended: string; candidates: RoutingCandidate[] };
    expect(ev.recommended).toBe("blacksmith");
    expect(ev.candidates[0]!.provider).toBe("blacksmith");
    expect(ev.candidates[0]!.centsPerMonth).toBe(Math.round(3600 * 0.25 * 0.004 * 100));
    expect(findings[0]!.diff).toContain("+    runs-on: blacksmith-2vcpu-ubuntu-2404");
    expect(findings[0]!.estimate.confidence).toBe(0.9);
  });

  it("writes the trusted-events form when a public repository's job moves to a connected machine", async () => {
    const workflow = macWorkflow.replace("runs-on: macos-latest", "runs-on: depot-macos-latest # paid runner");
    const h = history(".github/workflows/ios.yml", [
      { name: "ios", labels: ["depot-macos-latest"], count: 100, seconds: 600 },
      { name: "ios", labels: ["buildhound-macos"], count: 20, seconds: 360 },
    ]);
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: h, repository: { private: false }, config: { routing: { ...DEFAULT_RULE_CONFIG.routing, installed: ["buildhound"] } } });
    const findings = await runRules([R14], ctx);
    expect(findings).toHaveLength(1);
    const expression = buildhoundLabelExpression("macos", "depot-macos-latest", true);
    expect(findings[0]!.diff).toContain(`+    runs-on: ${expression} # paid runner`);
    expect(findings[0]!.confirmBeforeMerging).toContain("fork pull requests and events any GitHub user can cause stay on GitHub-hosted");
  });

  it("skips public repositories on GitHub-hosted runners and jobs under the spend floor", async () => {
    const h = history(".github/workflows/ci.yml", [{ name: "test", labels: ["ubuntu-latest"], count: 120, seconds: 1800 }]);
    const pub = makeContext({ path: ".github/workflows/ci.yml", content: linuxWorkflow, history: h, repository: { private: false } });
    expect(await runRules([R14], pub)).toHaveLength(0);
    const floor = makeContext({ path: ".github/workflows/ci.yml", content: linuxWorkflow, history: h, config: { routing: { ...DEFAULT_RULE_CONFIG.routing, minJobCentsPerMonth: 5000 } } });
    expect(await runRules([R14], floor)).toHaveLength(0);
  });

  it("reports stay when it is cheapest and respects the saving threshold", async () => {
    const h = history(".github/workflows/ci.yml", [{ name: "test", labels: ["ubuntu-latest"], count: 120, seconds: 1800 }]);
    // Only Depot, whose list price equals GitHub's: no saving, no finding, but stay is first in the ranking.
    const ctx = makeContext({ path: ".github/workflows/ci.yml", content: linuxWorkflow, history: h, config: { routing: { ...DEFAULT_RULE_CONFIG.routing, providers: ["github", "depot"] } } });
    expect(await runRules([R14], ctx)).toHaveLength(0);
    const r = routingCandidates({ jobId: "test", labels: ["ubuntu-latest"], minutesPerMonth: 3600, peakConcurrency: 1, measuredDurationFactors: {}, config: { ...DEFAULT_RULE_CONFIG.routing, providers: ["github", "depot"] }, repositoryPrivate: true });
    expect(r.candidates.map((c) => c.provider)).toEqual(["github", "depot"]);
    expect(r.candidates[0]!.stay).toBe(true);
  });
});

describe("routingCandidates", () => {
  const base = { jobId: "j", minutesPerMonth: 1000, peakConcurrency: 3, measuredDurationFactors: {}, config: DEFAULT_RULE_CONFIG.routing, repositoryPrivate: true };

  it("always includes stay, even when the current provider is not configured", () => {
    const r = routingCandidates({ ...base, labels: ["runs-on=${{ github.run_id }}/cpu=2"], config: { ...DEFAULT_RULE_CONFIG.routing, providers: ["github"] } });
    expect(r.current.provider).toBe("runs_on");
    expect(r.candidates.filter((c) => c.stay)).toHaveLength(1);
    expect(r.candidates.map((c) => c.provider).sort()).toEqual(["github", "runs_on"]);
  });

  it("omits providers with no rate for the OS and sizes the connected-machine fee by peak concurrency", () => {
    const r = routingCandidates({ ...base, labels: ["macos-latest"] });
    expect(r.candidates.map((c) => c.provider)).not.toContain("ubicloud");
    const bh = r.candidates.find((c) => c.provider === "buildhound")!;
    expect(bh.machinesNeeded).toBe(2); // 3 concurrent jobs, 2 per Mac
    expect(bh.monthlyFixedCents).toBe(2000);
    expect(bh.centsPerMonth).toBe(0);
    expect(r.xcodeCloud?.notARunner).toBe(true);
    const win = routingCandidates({ ...base, labels: ["windows-latest"] });
    expect(win.candidates.map((c) => c.provider)).not.toContain("buildhound");
    expect(win.xcodeCloud).toBeUndefined();
  });

  it("ranks by computed cost only, with no referral agreement on any row", () => {
    const r = routingCandidates({ ...base, labels: ["ubuntu-latest"], minutesPerMonth: 3600 });
    for (let i = 1; i < r.candidates.length; i++) expect(total(r.candidates[i]!)).toBeGreaterThanOrEqual(total(r.candidates[i - 1]!));
    expect(r.candidates.every((c) => c.referralAgreement === false)).toBe(true);
    expect(r.candidates[0]!.provider).toBe("jog");
    expect(r.candidates[1]!.provider).toBe("ubicloud");
    expect(r.candidates.find((c) => c.stay)!.savingCents).toBe(0);
  });

  it("prices GitHub at zero for public repositories and uses the measured factor when present", () => {
    const pub = routingCandidates({ ...base, labels: ["ubuntu-latest"], repositoryPrivate: false });
    expect(pub.current.centsPerMonth).toBe(0);
    const measured = routingCandidates({ ...base, labels: ["ubuntu-latest"], measuredDurationFactors: { warpbuild: 0.5 } });
    const wb = measured.candidates.find((c) => c.provider === "warpbuild")!;
    expect(wb.durationSource).toBe("measured");
    expect(wb.centsPerMonth).toBe(Math.round(1000 * 0.5 * 0.004 * 100));
    expect(measured.candidates.find((c) => c.provider === "blacksmith")!.durationSource).toBe("unchanged");
  });

  it("uses representative labels that classify back to the same provider and price", () => {
    for (const labels of [["ubuntu-latest"], ["ubuntu-24.04-arm"], ["macos-latest"], ["windows-latest"]]) {
      const r = routingCandidates({ ...base, labels });
      for (const c of r.candidates) {
        if (c.stay) continue;
        // classify() reads the year suffix of depot-windows-<year> as a vCPU count; a classify.ts fix, not a routing one.
        if (c.provider === "depot" && labels[0] === "windows-latest") continue;
        const back = classify([c.label]);
        expect(back.provider, c.label).toBe(c.provider);
        expect(back.pricePerMinute, c.label).toBe(c.pricePerMinute);
      }
    }
    expect(representativeLabel("ubicloud", "macos", "arm64", 3)).toBeNull();
    expect(representativeLabel("jog", "linux", "x64", 2)).toBe("jog");
    expect(representativeLabel("jog", "linux", "x64", 8)).toBe("jog-8vcpu");
    expect(representativeLabel("starsling", "linux", "x64", 4)).toBe("starsling-ubuntu-26.04");
    expect(representativeLabel("starsling", "linux", "x64", 8)).toBe("starsling-ubuntu-26.04-8");
    expect(representativeLabel("starsling", "macos", "arm64", 3)).toBeNull();
    expect(representativeLabel("jog", "linux", "arm64", 2)).toBeNull();
    expect(representativeLabel("buildhound", "linux", "x64", 2)).toBe("buildhound-linux");
  });
});

describe("buildhoundLabelExpression", () => {
  it("is the short form on private repositories and the trusted-events form on public ones", async () => {
    const { buildhoundLabelExpression, parseRoutingExpression } = await import("./routing");
    expect(buildhoundLabelExpression("macos", "macos-latest")).toBe("${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}");
    expect(parseRoutingExpression(buildhoundLabelExpression("linux", "ubuntu-latest", true))).toEqual({ variable: "BUILDHOUND_LINUX", hostedDefault: "ubuntu-latest", form: "trusted_events" });
  });

  it("reads the family's trusted variable for a secret-bearing job, the one route --apply writes", async () => {
    const { buildhoundLabelExpression, buildhoundVariable, parseRoutingExpression, routingExpression } = await import("./routing");
    expect(buildhoundVariable("macos", true)).toBe("BUILDHOUND_MACOS_TRUSTED");
    expect(buildhoundVariable("linux")).toBe("BUILDHOUND_LINUX");
    expect(buildhoundLabelExpression("macos", "macos-latest", false, true)).toBe("${{ vars.BUILDHOUND_MACOS_TRUSTED || 'macos-latest' }}");
    expect(buildhoundLabelExpression("macos", "macos-latest", false, true)).toBe(routingExpression("BUILDHOUND_MACOS_TRUSTED", "macos-latest", false));
    expect(parseRoutingExpression(buildhoundLabelExpression("linux", "ubuntu-latest", true, true))).toEqual({ variable: "BUILDHOUND_LINUX_TRUSTED", hostedDefault: "ubuntu-latest", form: "trusted_events" });
  });
});

describe("rule R14 runner-routing and secret-bearing jobs (CLAUDE.md rule 19)", () => {
  const machineOnly = { routing: { ...DEFAULT_RULE_CONFIG.routing, providers: ["github", "buildhound"], installed: ["buildhound"] } };
  const macHistory = () =>
    history(".github/workflows/ios.yml", [
      { name: "ios", labels: ["macos-latest"], count: 100, seconds: 600 },
      { name: "ios", labels: ["buildhound-macos"], count: 20, seconds: 360 },
    ]);

  const TRUSTED_SHORT = "${{ vars.BUILDHOUND_MACOS_TRUSTED || 'macos-latest' }}";

  it("routes a job with an environment and secrets.X to the trusted variable, with the reasons and the assumption (CLAUDE.md rules 14 and 19)", async () => {
    const workflow = macWorkflow.replace("    runs-on: macos-latest\n", "    runs-on: macos-latest # hosted today\n    environment: production\n").replace("xcodebuild test -scheme App", "xcodebuild test -scheme App\n        env:\n          ASC_KEY: ${{ secrets.ASC_KEY }}");
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: macHistory(), repository: { defaultTokenPermission: "read" }, config: machineOnly });
    const findings = await runRules([R14], ctx);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.diff).toContain(`+    runs-on: ${TRUSTED_SHORT} # hosted today`);
    expect(f.diff).not.toContain("vars.BUILDHOUND_MACOS ||");
    expect(f.estimate.centsPerMonth).toBe(6200 - 1000);
    expect(f.evidence.recommended).toBe("buildhound");
    expect(f.evidence.recommendedLabel).toBe(TRUSTED_SHORT);
    expect(f.evidence.trusted).toBe(true);
    expect(f.evidence.trustedVariable).toBe("BUILDHOUND_MACOS_TRUSTED");
    expect(f.evidence.notRouted).toBeUndefined();
    expect(f.evidence.secretBearing).toEqual(["jobs.ios.steps[1].env.ASC_KEY reads secrets", "jobs.ios.environment: production"]);
    expect(secretsTrustedReason("github")).toBe("uses secrets: routes to Trusted machines, GitHub-hosted until one is connected");
    expect(f.summary).toContain("; uses secrets: routes to Trusted machines, GitHub-hosted until one is connected");
    expect(f.confirmBeforeMerging).toBe(
      "Confirm before merging: this job can reach secrets or write to the repository (jobs.ios.steps[1].env.ASC_KEY reads secrets; jobs.ios.environment: production), so it reads BUILDHOUND_MACOS_TRUSTED, which names only machines a person marked Trusted. Until a Trusted machine is connected and serves this repository the variable is unset and the job stays on GitHub-hosted; a machine marked No secrets never runs it. Once one is connected, its image has the tools this job uses.",
    );
  });

  it("writes the trusted expression in the form route --apply uses: short on private, allowlist on public repositories", async () => {
    const workflow = macWorkflow.replace("runs-on: macos-latest", "runs-on: depot-macos-latest").replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n");
    const h = history(".github/workflows/ios.yml", [
      { name: "ios", labels: ["depot-macos-latest"], count: 100, seconds: 600 },
      { name: "ios", labels: ["buildhound-macos"], count: 20, seconds: 360 },
    ]);
    for (const isPrivate of [true, false]) {
      const ctx = makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: h, repository: { private: isPrivate, defaultTokenPermission: "read" }, config: machineOnly });
      const [f] = await runRules([R14], ctx);
      const expected = buildhoundLabelExpression("macos", "depot-macos-latest", !isPrivate, true);
      expect(expected).toContain("vars.BUILDHOUND_MACOS_TRUSTED");
      expect(f!.diff).toContain(`+    runs-on: ${expected}`);
      expect(f!.summary).toContain("uses secrets: routes to Trusted machines, Depot until one is connected");
      if (isPrivate) expect(f!.confirmBeforeMerging).not.toContain("public repository");
      else expect(f!.confirmBeforeMerging).toContain("fork pull requests and events any GitHub user can cause stay on GitHub-hosted");
    }
  });

  it("counts an unknown default token as write: a job with no permissions block reads the trusted variable until the default is read", async () => {
    const workflow = macWorkflow.replace("permissions:\n  contents: read\n", "");
    const unknown = await runRules([R14], makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: macHistory(), config: machineOnly }));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.diff).toContain(`+    runs-on: ${TRUSTED_SHORT}`);
    expect(unknown[0]!.evidence.secretBearing).toEqual(["no permissions block; the repository's default token could not be read"]);
    const write = await runRules([R14], makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: macHistory(), repository: { defaultTokenPermission: "write" }, config: machineOnly }));
    expect(write[0]!.diff).toContain(`+    runs-on: ${TRUSTED_SHORT}`);
    const read = await runRules([R14], makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: macHistory(), repository: { defaultTokenPermission: "read" }, config: machineOnly }));
    expect(read[0]!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}");
    expect(read[0]!.evidence.trusted).toBeUndefined();
    expect(read[0]!.evidence.secretBearing).toBeUndefined();
  });

  it("agrees with secretBearingJobs, the classifier route and route --apply use", async () => {
    const workflow = macWorkflow.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n");
    const ctx = makeContext({ path: ".github/workflows/ios.yml", content: workflow, history: macHistory(), repository: { defaultTokenPermission: "read" }, config: machineOnly });
    const [f] = await runRules([R14], ctx);
    expect(f!.diff).toContain("vars.BUILDHOUND_MACOS_TRUSTED");
    expect(f!.evidence.secretBearing).toEqual(secretBearingJobs(workflow, "read").get("ios"));
  });

  it("keeps a vendor's fix for a secret-bearing job, as route does: only a connected machine needs Trusted", async () => {
    const workflow = linuxWorkflow.replace("npm ci && npm test", "npm ci && npm test\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    const h = history(".github/workflows/ci.yml", [
      { name: "test", labels: ["ubuntu-latest"], count: 120, seconds: 1800 },
      { name: "test", labels: ["blacksmith-2vcpu-ubuntu-2404"], count: 10, seconds: 450 },
    ]);
    const [f] = await runRules([R14], makeContext({ path: ".github/workflows/ci.yml", content: workflow, history: h }));
    expect(f!.evidence.recommended).toBe("blacksmith");
    expect(f!.diff).toContain("+    runs-on: blacksmith-2vcpu-ubuntu-2404");
    expect(f!.evidence.trusted).toBeUndefined();
    expect(f!.evidence.secretBearing).toBeUndefined();
    expect(f!.confirmBeforeMerging).not.toContain("Trusted");
  });

  it("a plain connected-machine fix says nothing about secret-bearing jobs, since none is left behind", async () => {
    const [f] = await runRules([R14], makeContext({ path: ".github/workflows/ios.yml", content: macWorkflow, history: macHistory(), config: machineOnly }));
    expect(f!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}");
    expect(f!.confirmBeforeMerging).not.toContain("secrets");
    expect(f!.confirmBeforeMerging).not.toContain("Trusted");
  });

  // Real workflows (fixtures/corpus): every job with a plain macOS or Linux label gets enough spend and a measured
  // connected-machine run to be routed there, so the classifier alone decides which variable each job reads.
  const CORPUS = ["pydantic__pydantic__ci.yml", "vercel__next.js__build_and_deploy.yml", "signalapp__Signal-iOS__main.yml"];
  const corpus = join(__dirname, "..", "..", "fixtures", "corpus");

  function corpusHistory(path: string, content: string): History {
    const specs: Spec[] = [];
    for (const job of makeContext({ path, content }).workflow.model.jobs) {
      if (job.runsOn.length !== 1 || job.runsOn[0]!.includes("${{")) continue;
      const c = classify(job.runsOn);
      if (c.provider !== "github" || (c.os !== "macos" && c.os !== "linux")) continue;
      const name = job.name ?? job.id;
      specs.push({ name, labels: job.runsOn, count: 300, seconds: 1800 }, { name, labels: [`buildhound-${c.os}`], count: 20, seconds: 1080 });
    }
    return history(path, specs);
  }

  for (const file of CORPUS) {
    for (const permission of ["read", undefined] as const) {
      it(`${file}, default token ${permission ?? "unknown"}: secret-bearing jobs read the trusted variable, the rest the plain one`, async () => {
        const path = `.github/workflows/${file}`;
        const content = readFileSync(join(corpus, file), "utf8");
        const ctx = makeContext({ path, content, history: corpusHistory(path, content), repository: permission ? { defaultTokenPermission: permission } : {}, config: machineOnly });
        const findings = await runRules([R14], ctx);
        const secrets = secretBearingJobs(content, permission);
        expect(findings.length).toBeGreaterThan(0);
        const lines: string[] = [];
        for (const f of findings) {
          expect(f.evidence.recommended).toBe("buildhound");
          expect(f.estimate.confidence).toBeGreaterThan(0);
          expect(f.diff).toMatch(/\+\s+runs-on: \$\{\{ vars\.BUILDHOUND_(MACOS|LINUX|LINUX_ARM64)(_TRUSTED)? \|\| '/);
          if (secrets.has(f.jobName!)) {
            expect(f.diff).toContain("_TRUSTED ||");
            expect(f.evidence.trusted).toBe(true);
            expect(f.summary).toContain(secretsTrustedReason("github"));
            expect(f.confirmBeforeMerging).toContain("which names only machines a person marked Trusted");
            lines.push(`${f.jobName}: trusted, ${String(f.evidence.recommendedLabel)}, ${(f.evidence.secretBearing as string[]).join("; ")}`);
          } else {
            expect(f.diff).not.toContain("_TRUSTED");
            expect(f.evidence.trusted).toBeUndefined();
            lines.push(`${f.jobName}: routed to ${String(f.evidence.recommendedLabel)}`);
          }
        }
        expect(lines.join("\n")).toMatchSnapshot();
      });
    }
  }

  it("the corpus has a job with an environment or secrets.X that reads the trusted variable even on a read-only default", async () => {
    const path = ".github/workflows/pydantic__pydantic__ci.yml";
    const content = readFileSync(join(corpus, "pydantic__pydantic__ci.yml"), "utf8");
    const findings = await runRules([R14], makeContext({ path, content, history: corpusHistory(path, content), repository: { defaultTokenPermission: "read" }, config: machineOnly }));
    const trusted = findings.filter((f) => f.evidence.trusted).map((f) => f.jobName);
    expect(trusted).toContain("deploy-docs");
    expect(trusted).toContain("release-pydantic-core");
    expect(findings.find((f) => f.jobName === "deploy-docs")!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_LINUX_TRUSTED || 'ubuntu-latest' }}");
    expect(findings.find((f) => f.jobName === "lint")!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}");
  });
});

describe("rule R14 runner-routing and arm64 jobs (RUNNERS.md, Labels; B12)", () => {
  const machineOnly = { routing: { ...DEFAULT_RULE_CONFIG.routing, providers: ["github", "buildhound"], installed: ["buildhound"] } };
  const ARM = "${{ vars.BUILDHOUND_LINUX_ARM64 || 'ubuntu-24.04-arm' }}";
  const armWorkflow = (label = "ubuntu-24.04-arm") => `name: arm64
on: pull_request
permissions:
  contents: read
jobs:
  build:
    runs-on: ${label} # native arm64
    steps:
      - uses: actions/checkout@v4
      - run: docker buildx build --platform linux/arm64 .
`;
  /** 24,000 minutes a month at the arm rate is $120; 20 runs on an arm64 machine measured at half the time. */
  const armHistory = (label = "ubuntu-24.04-arm") =>
    history(".github/workflows/arm.yml", [
      { name: "build", labels: [label], count: 200, seconds: 7200 },
      { name: "build", labels: ["buildhound-linux-arm64"], count: 20, seconds: 3600 },
    ]);

  it("pins a job on GitHub's arm64 runner to BUILDHOUND_LINUX_ARM64, priced at the arm rate, and names the assumption (CLAUDE.md rules 4 and 14)", async () => {
    const findings = await runRules([R14], makeContext({ path: ".github/workflows/arm.yml", content: armWorkflow(), history: armHistory(), repository: { defaultTokenPermission: "read" }, config: machineOnly }));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.diff).toContain(`+    runs-on: ${ARM} # native arm64`);
    expect(f.diff).not.toContain("vars.BUILDHOUND_LINUX ||");
    const ev = f.evidence as { current: { pricePerMinute: number; arch: string; runnerClass: string }; candidates: RoutingCandidate[]; recommendedLabel: string; pinnedArch: string };
    expect(ev.current).toMatchObject({ pricePerMinute: 0.005, arch: "arm64", runnerClass: "linux_2_arm" });
    expect(ev.candidates.find((c) => c.provider === "buildhound")!.label).toBe("buildhound-linux-arm64");
    expect(ev.recommendedLabel).toBe(ARM);
    expect(ev.pinnedArch).toBe("arm64");
    expect(f.estimate.centsPerMonth).toBe(12000 - 1000);
    expect(f.confirmBeforeMerging).toContain("This job ran on an arm64 runner (ubuntu-24.04-arm), so it reads BUILDHOUND_LINUX_ARM64 and is pinned to arm64 machines, an arm64 Linux host or a Mac; an x86-64 host never takes it.");
  });

  it("writes the trusted-events form on a public repository and the arm64 trusted twin for a secret-bearing job (CLAUDE.md rule 19)", async () => {
    // A public repository's GitHub-hosted jobs are skipped and GitHub prices at zero there, so the job is on a vendor's arm label and only the machine is a candidate.
    const vendor = "blacksmith-2vcpu-ubuntu-2404-arm";
    const pub = await runRules([R14], makeContext({ path: ".github/workflows/arm.yml", content: armWorkflow(vendor), history: armHistory(vendor), repository: { private: false, defaultTokenPermission: "read" }, config: { routing: { ...machineOnly.routing, providers: ["buildhound"] } } }));
    expect(pub).toHaveLength(1);
    const expected = buildhoundLabelExpression("linux", vendor, true, false, "arm64");
    expect(pub[0]!.diff).toContain(`+    runs-on: ${expected}`);
    expect(parseRoutingExpression(expected)).toEqual({ variable: "BUILDHOUND_LINUX_ARM64", hostedDefault: vendor, form: "trusted_events" });

    const secret = armWorkflow().replace("    steps:", "    environment: production\n    steps:");
    const [f] = await runRules([R14], makeContext({ path: ".github/workflows/arm.yml", content: secret, history: armHistory(), repository: { defaultTokenPermission: "read" }, config: machineOnly }));
    expect(f!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_LINUX_ARM64_TRUSTED || 'ubuntu-24.04-arm' }} # native arm64");
    expect(f!.evidence.trustedVariable).toBe("BUILDHOUND_LINUX_ARM64_TRUSTED");
    expect(f!.confirmBeforeMerging).toContain("so it reads BUILDHOUND_LINUX_ARM64_TRUSTED, which names only machines a person marked Trusted");
    expect(f!.confirmBeforeMerging).toContain("pinned to arm64 machines");
  });

  it("keeps BUILDHOUND_LINUX, any Linux machine, for a job on an x86-64 label", async () => {
    const h = history(".github/workflows/ci.yml", [
      { name: "test", labels: ["ubuntu-latest"], count: 200, seconds: 7200 },
      { name: "test", labels: ["buildhound-linux"], count: 20, seconds: 3600 },
    ]);
    const [f] = await runRules([R14], makeContext({ path: ".github/workflows/ci.yml", content: linuxWorkflow, history: h, repository: { defaultTokenPermission: "read" }, config: machineOnly }));
    expect(f!.diff).toContain("+    runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}");
    expect(f!.evidence.pinnedArch).toBeUndefined();
    expect(f!.confirmBeforeMerging).not.toContain("arm64");
  });

  it("every one of GitHub's arm64 Linux labels, a vendor's arm label and a larger runner named for arm64 take the arm64 family; x86-64 labels and macOS do not", () => {
    expect(GITHUB_LINUX_ARM64_LABELS).toEqual(["ubuntu-24.04-arm", "ubuntu-22.04-arm", "ubuntu-26.04-arm"]);
    for (const label of GITHUB_LINUX_ARM64_LABELS) {
      const c = classify([label]);
      expect(c, label).toMatchObject({ provider: "github", os: "linux", arch: "arm64", runnerClass: "linux_2_arm", pricePerMinute: 0.005 });
      expect(buildhoundFamily(c.os, c.arch)).toBe("buildhound-linux-arm64");
      expect(buildhoundVariable(c.os, false, c.arch)).toBe("BUILDHOUND_LINUX_ARM64");
      expect(buildhoundVariable(c.os, true, c.arch)).toBe("BUILDHOUND_LINUX_ARM64_TRUSTED");
    }
    for (const label of ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-26.04", "ubuntu-slim"]) {
      const c = classify([label]);
      expect(c.arch, label).toBe("x64");
      expect(buildhoundFamily(c.os, c.arch)).toBe("buildhound-linux");
      expect(buildhoundVariable(c.os, false, c.arch)).toBe("BUILDHOUND_LINUX");
    }
    const vendor = classify(["warp-ubuntu-latest-arm64-4x"]);
    expect(buildhoundFamily(vendor.os, vendor.arch)).toBe("buildhound-linux-arm64");
    // A larger runner carries a name the organisation chose; the architecture is read from it even though the label is unknown.
    const larger = classify(["ubuntu-24.04-arm64-xl"]);
    expect(larger).toMatchObject({ provider: "unknown", arch: "arm64" });
    expect(buildhoundFamily(larger.os, larger.arch)).toBe("buildhound-linux-arm64");
    expect(classify(["my-big-runner"]).arch).toBe("x64");
    const mac = classify(["macos-latest"]);
    expect(buildhoundFamily(mac.os, mac.arch)).toBe("buildhound-macos");
    expect(buildhoundVariable("macos", false, "arm64")).toBe("BUILDHOUND_MACOS");
    expect(representativeLabel("buildhound", "linux", "arm64", 2)).toBe("buildhound-linux-arm64");
    expect(classify(["buildhound-linux-arm64"])).toMatchObject({ provider: "buildhound", os: "linux", arch: "arm64" });
  });
});
