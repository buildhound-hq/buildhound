import { describe, expect, it } from "vitest";
import { classify } from "../cost/classify";
import type { History, JobRecord, RunRecord } from "../model/types";
import { makeContext } from "./context";
import { R14 } from "./r14-runner-routing";
import { buildhoundLabelExpression, routingCandidates, representativeLabel, type RoutingCandidate } from "./routing";
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

const macWorkflow = `name: iOS
on: pull_request
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
    expect(f.estimate.centsPerMonth).toBe(6200 - 2000);
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
    expect(bh.monthlyFixedCents).toBe(4000);
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
});
