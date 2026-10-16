import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { classify } from "../cost/classify";
import type { History, JobRecord, RunRecord } from "../model/types";
import { routingExpression } from "../rules/routing";
import { countComments } from "../yaml";
import { applyRouting, formatDuration, measureSpeed, planRoutingPullRequest, routableRunsOn, routingSaving } from "./route";
import { secretBearingJobs } from "../security/classify-job";
import type { RoutingMove } from "./route";

const corpus = join(__dirname, "..", "..", "fixtures", "corpus");
const read = (name: string) => readFileSync(join(corpus, name), "utf8");

/** Every job of a file a connected machine could take: one plain macOS or Linux label. */
function routable(content: string): Array<{ jobId: string; label: string; os: "macos" | "linux" }> {
  const jobs = (parseDocument(content).toJS() as { jobs: Record<string, unknown> }).jobs;
  const out: Array<{ jobId: string; label: string; os: "macos" | "linux" }> = [];
  for (const jobId of Object.keys(jobs)) {
    const r = routableRunsOn(content, jobId);
    if (!("label" in r)) continue;
    const os = classify([r.label]).os;
    if (os === "macos" || os === "linux") out.push({ jobId, label: r.label, os });
  }
  return out;
}

/** The parsed workflow with every job's runs-on removed, to show nothing else changed. */
function withoutRunsOn(content: string): unknown {
  const js = parseDocument(content).toJS() as { jobs: Record<string, Record<string, unknown>> };
  for (const job of Object.values(js.jobs)) delete job["runs-on"];
  return js;
}

const CORPUS = ["sveltejs__svelte__ci.yml", "signalapp__Signal-iOS__main.yml", "fastlane__fastlane__ci.yml", "pydantic__pydantic__ci.yml"];

describe("applyRouting on real workflows (CLAUDE.md rule 1)", () => {
  for (const name of CORPUS) {
    for (const publicRepo of [false, true]) {
      it(`${name}, ${publicRepo ? "public" : "private"}: only runs-on changes, every comment survives`, () => {
        const content = read(name);
        const jobs = routable(content);
        expect(jobs.length).toBeGreaterThan(0);
        const moves = jobs.map((j) => ({ jobId: j.jobId, to: routingExpression(j.os === "macos" ? "BUILDHOUND_MACOS" : "BUILDHOUND_LINUX", j.label, publicRepo) }));
        const { change, upgrades } = applyRouting(`.github/workflows/${name}`, content, moves, publicRepo);
        expect(upgrades).toEqual([]);
        expect(change).not.toBeNull();
        expect(countComments(change!.after)).toBe(countComments(content));
        expect(withoutRunsOn(change!.after)).toEqual(withoutRunsOn(content));
        const changed = change!.diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l));
        expect(changed.every((l) => l.includes("runs-on:"))).toBe(true);
        expect(change!.added).toBe(jobs.length);
        expect(change!.removed).toBe(jobs.length);
        const after = parseDocument(change!.after).toJS() as { jobs: Record<string, { "runs-on": unknown }> };
        for (const m of moves) expect(after.jobs[m.jobId]!["runs-on"]).toBe(m.to);
        expect(change!.diff).toMatchSnapshot();
      });
    }
  }

  it("keeps a trailing comment on the runs-on line and the blank lines around it", () => {
    const content = "on: push\n\njobs:\n  test:\n    runs-on: ubuntu-latest # the cheap one\n    steps:\n      - run: make\n\n\n  other:\n    runs-on: windows-latest\n    steps:\n      - run: make\n";
    const { change } = applyRouting(".github/workflows/ci.yml", content, [{ jobId: "test", to: routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", false) }], false);
    expect(change!.after).toBe(content.replace("runs-on: ubuntu-latest # the cheap one", "runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }} # the cheap one"));
  });

  it("upgrades an older expression on a public repository in the same edit", () => {
    const content = "on: push\njobs:\n  build:\n    runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }} # office Mac\n    steps:\n      - run: make\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make lint\n";
    const { change, upgrades } = applyRouting(".github/workflows/ci.yml", content, [{ jobId: "lint", to: routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true) }], true);
    expect(upgrades).toEqual([{ jobId: "build", from: "${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}", to: routingExpression("BUILDHOUND_MACOS", "macos-latest", true) }]);
    expect(change!.after).toContain(`runs-on: ${routingExpression("BUILDHOUND_MACOS", "macos-latest", true)} # office Mac`);
    expect(change!.after).toContain(`runs-on: ${routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true)}\n`);
  });
});

describe("routableRunsOn", () => {
  const wf = (runsOn: string) => `on: push\njobs:\n  a:\n    runs-on: ${runsOn}\n    steps:\n      - run: x\n`;
  it("takes one plain label, as a scalar or a list of one", () => {
    expect(routableRunsOn(wf("ubuntu-latest"), "a")).toEqual({ label: "ubuntu-latest" });
    expect(routableRunsOn(wf("[macos-15]"), "a")).toEqual({ label: "macos-15" });
  });
  it("leaves expressions, several labels, runner groups and reusable workflow calls to a person", () => {
    expect(routableRunsOn(wf("${{ matrix.os }}"), "a")).toHaveProperty("reason", expect.stringContaining("expression"));
    expect(routableRunsOn(wf("[self-hosted, macOS]"), "a")).toHaveProperty("reason", expect.stringContaining("several labels"));
    expect(routableRunsOn(wf("{ group: big }"), "a")).toHaveProperty("reason", expect.stringContaining("runner group"));
    expect(routableRunsOn("on: push\njobs:\n  a:\n    uses: ./.github/workflows/x.yml\n", "a")).toHaveProperty("reason", expect.stringContaining("reusable workflow"));
  });
});

describe("secretBearingJobs (CLAUDE.md rule 19)", () => {
  it("names jobs with secrets, an environment, OIDC, inherited secrets or a write token, and not GITHUB_TOKEN alone", () => {
    const content = `on: push
permissions:
  contents: read
jobs:
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr list
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
  key:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
  env:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: deploy
  oidc:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: deploy
  inherit:
    uses: ./.github/workflows/release.yml
    secrets: inherit
`;
    const found = secretBearingJobs(content, "read");
    expect([...found.keys()].sort()).toEqual(["env", "inherit", "key", "oidc"]);
    expect(found.get("env")).toEqual(["jobs.env.environment: production"]);
  });
  it("counts a job without a permissions block as able to write when the repository default is unknown", () => {
    const content = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
    expect(secretBearingJobs(content).has("a")).toBe(true);
    expect(secretBearingJobs(content, "read").has("a")).toBe(false);
  });
});

const t0 = Date.UTC(2026, 9, 1);
function history(jobs: Array<{ labels: string[]; seconds: number; wait?: number; name?: string; conclusion?: string }>): History {
  const runs: RunRecord[] = jobs.map((_, i) => ({ id: i + 1, workflowPath: ".github/workflows/ci.yml", event: "push", headBranch: "main", headSha: null, actorLogin: "dev", actorKind: "human", agentName: null, createdAt: new Date(t0 + i * 3_600_000), runStartedAt: null, conclusion: "success", isFork: false, isDraft: false }));
  const records: JobRecord[] = jobs.map((j, i) => {
    const queued = t0 + i * 3_600_000;
    const started = queued + (j.wait ?? 5) * 1000;
    return { id: 100 + i, runId: i + 1, name: j.name ?? "test", labels: j.labels, queuedAt: new Date(queued), startedAt: new Date(started), completedAt: new Date(started + j.seconds * 1000), conclusion: j.conclusion ?? "success", steps: [] };
  });
  return { days: 30, runs, jobs: records };
}

describe("measureSpeed", () => {
  it("compares the medians on the account's machines and on GitHub-hosted once each side has three runs", () => {
    const h = history([
      ...[300, 320, 280, 310].map((s) => ({ labels: ["ubuntu-latest"], seconds: s })),
      ...[150, 140, 160].map((s) => ({ labels: ["buildhound-linux"], seconds: s, wait: 2 })),
      { labels: ["buildhound-linux"], seconds: 10, conclusion: "failure" },
      { labels: ["ubuntu-latest"], seconds: 999, name: "other" },
    ]);
    const m = measureSpeed(h, ".github/workflows/ci.yml", "test")!;
    expect(m.hosted).toEqual({ runs: 4, medianSeconds: 305, medianWaitSeconds: 5 });
    expect(m.machine).toEqual({ runs: 3, medianSeconds: 150, medianWaitSeconds: 2 });
    expect(m.speedUp).toBe(2.03);
  });
  it("claims nothing until each side has three runs, and nothing without history", () => {
    const h = history([{ labels: ["ubuntu-latest"], seconds: 300 }, { labels: ["ubuntu-latest"], seconds: 300 }, { labels: ["ubuntu-latest"], seconds: 300 }, { labels: ["buildhound-linux"], seconds: 100 }]);
    expect(measureSpeed(h, ".github/workflows/ci.yml", "test")!.speedUp).toBeNull();
    expect(measureSpeed(h, ".github/workflows/other.yml", "test")).toEqual({ hosted: null, machine: null, speedUp: null });
    expect(measureSpeed(null, ".github/workflows/ci.yml", "test")).toBeNull();
  });
  it("formats durations the way the body shows them", () => {
    expect(formatDuration(44)).toBe("44 s");
    expect(formatDuration(154)).toBe("2 min 34 s");
    expect(formatDuration(120)).toBe("2 min");
  });
});

const move = (over: Partial<RoutingMove> = {}): RoutingMove => ({
  workflow: ".github/workflows/ci.yml",
  jobId: "test",
  name: "test",
  from: "ubuntu-latest",
  os: "linux",
  variable: "BUILDHOUND_LINUX",
  minutesPerMonth: 1680,
  centsPerMonth: 1008,
  basis: "history",
  speed: null,
  ranking: null,
  ...over,
});

describe("routingSaving (CLAUDE.md rule 9)", () => {
  it("is the GitHub-hosted spend less Team at 2400 cents a machine, and claims nothing below zero", () => {
    expect(routingSaving([move()], 1, false)).toMatchObject({ hostedCentsPerMonth: 1008, machineFeeCents: 2400, machinesNeeded: 1, monthlySavingCents: -1392, claimedCentsPerMonth: 0 });
    expect(routingSaving([move({ centsPerMonth: 9000, os: "macos" })], 3, false)).toMatchObject({ machinesNeeded: 2, monthlySavingCents: 4200, claimedCentsPerMonth: 4200 });
  });
  it("claims no saving on a public repository", () => {
    expect(routingSaving([move({ centsPerMonth: 9000 })], 1, true)).toMatchObject({ publicRepository: true, hostedCentsPerMonth: 0, claimedCentsPerMonth: 0 });
  });
  it("does not count again a job moved from the plain variable to the trusted one", () => {
    const repointed = move({ jobId: "deploy", variable: "BUILDHOUND_LINUX_TRUSTED", secrets: ["jobs.deploy.environment: production"], today: "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}", centsPerMonth: 9000 });
    expect(routingSaving([move(), repointed], 1, false)).toMatchObject({ hostedCentsPerMonth: 1008, minutesPerMonth: 1680 });
  });
});

describe("planRoutingPullRequest", () => {
  const ci = `name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  # Lint and unit tests
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  ios:
    runs-on: macos-15 # Xcode 16
    steps:
      - run: xcodebuild test
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy
`;
  const speed = { hosted: { runs: 40, medianSeconds: 300, medianWaitSeconds: 4 }, machine: { runs: 5, medianSeconds: 150, medianWaitSeconds: 1 }, speedUp: 2 };
  const input = (isPrivate: boolean) => ({
    repository: { fullName: "acme/app", private: isPrivate, defaultBranch: "main" },
    workflows: [{ path: ".github/workflows/ci.yml", content: ci }],
    moves: [
      move({ speed, ranking: { stayCents: 1008, cheapest: { provider: "jog", label: "jog", cents: 202 } } }),
      move({ jobId: "ios", name: "ios", from: "macos-15", os: "macos", variable: "BUILDHOUND_MACOS", minutesPerMonth: 900, centsPerMonth: isPrivate ? 5580 : 0, ranking: { stayCents: 5580, cheapest: { provider: "buildhound", label: "buildhound-macos", cents: 2400 } } }),
    ],
    kept: [{ workflow: ".github/workflows/ci.yml", jobId: "deploy", label: "ubuntu-latest", reason: "it can reach secrets or write to the repository, so only a machine a person marked Trusted may run it, and Buildhound does not route it (jobs.deploy.environment: production)" }],
    macosPeakConcurrency: 1,
    historyDays: 30,
  });

  it("writes the routing pull request for a private repository: speed-up, saving with the calculation, stay, assumption", () => {
    const plan = planRoutingPullRequest(input(true));
    expect(plan.branch).toBe("buildhound/route");
    expect(plan.title).toBe("Route 2 jobs to your machines, with GitHub-hosted as the fallback");
    expect(plan.commitMessage).toMatch(/\n\nBuildhound-Route: test,ios$/);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.after).toContain("runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-15' }} # Xcode 16");
    expect(plan.files[0]!.after).toContain("  deploy:\n    runs-on: ubuntu-latest\n");
    expect(plan.saving).toMatchObject({ hostedCentsPerMonth: 6588, machinesNeeded: 1, monthlySavingCents: 4188, claimedCentsPerMonth: 4188 });
    const body = plan.body;
    expect(body).toContain("| `test` | 5 min, median of 40 runs | 2 min 30 s, median of 5 runs | 2.00x faster |");
    expect(body).toContain("| `ios` | no successful runs | not run there yet | not measured yet |");
    expect(body).toContain("About $41.88 a month saved on machines you already have, after Team at $24.00 a machine a month");
    expect(body).toContain("Close this pull request. Nothing changes");
    expect(body).toContain("Buildhound has no referral agreement with any runner vendor.");
    expect(body).toContain("and the account has Personal or Team");
    expect(body).toContain("### Assumption");
    expect(body).not.toMatch(/payback|pays for itself/i);
    expect(body).not.toContain("\u2014");
    expect(body).toMatchSnapshot();
  });

  it("claims no saving on a public repository and says fork pull requests stay on GitHub-hosted", () => {
    const plan = planRoutingPullRequest(input(false));
    expect(plan.files[0]!.after).toContain(`runs-on: ${routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true)}`);
    expect(plan.saving.claimedCentsPerMonth).toBe(0);
    expect(plan.body).toContain("no saving is claimed");
    expect(plan.body).toContain("Fork pull requests and events anyone on GitHub can cause stay on GitHub-hosted.");
    expect(plan.body).not.toContain("Personal or Team");
    expect(plan.body).not.toContain("\u2014");
    expect(plan.body).toMatchSnapshot();
  });

  it("routes a secret-bearing job to the trusted variable and says which jobs go to Trusted machines and why (CLAUDE.md rule 19)", () => {
    const deploy = move({ jobId: "deploy", name: "deploy", variable: "BUILDHOUND_LINUX_TRUSTED", secrets: ["jobs.deploy.environment: production"], minutesPerMonth: 120, centsPerMonth: 72 });
    for (const isPrivate of [true, false]) {
      const plan = planRoutingPullRequest({ ...input(isPrivate), moves: [...input(isPrivate).moves, deploy], kept: [] });
      expect(plan.title).toBe("Route 3 jobs to your machines, with GitHub-hosted as the fallback");
      expect(plan.files[0]!.after).toContain(`  deploy:\n    runs-on: ${routingExpression("BUILDHOUND_LINUX_TRUSTED", "ubuntu-latest", !isPrivate)}\n`);
      expect(countComments(plan.files[0]!.after)).toBe(countComments(ci));
      const body = plan.body;
      expect(body).toContain("### Jobs that use secrets");
      expect(body).toContain("This job reads `BUILDHOUND_LINUX_TRUSTED`, which names only machines a person marked Trusted, because it can reach secrets or write to the repository:");
      expect(body).toContain("- `ci.yml`, job `deploy`: jobs.deploy.environment: production.");
      expect(body).toContain("Until a Trusted machine is connected and serves this repository, `BUILDHOUND_LINUX_TRUSTED` stays unset and this job runs on GitHub-hosted, as today.");
      expect(body).toContain("The jobs that use secrets read `BUILDHOUND_LINUX_TRUSTED` and run on their GitHub-hosted label while it is empty.");
      expect(body).toContain("Each routed job reads the repository variable `BUILDHOUND_LINUX` and `BUILDHOUND_MACOS`");
      expect(body).not.toContain("\u2014");
      if (isPrivate) expect(body).toContain("- the saving counts the jobs that use secrets, which run on your machines only once a person marks one Trusted.");
      else expect(body).toContain("Fork pull requests and events anyone on GitHub can cause stay on GitHub-hosted.");
      expect(body).toMatchSnapshot();
    }
  });

  it("moves a job routed earlier on the plain variable to the trusted one, showing the expression it had", () => {
    const routed = ci.replace("  deploy:\n    runs-on: ubuntu-latest", "  deploy:\n    runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }} # deploy box");
    const today = "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}";
    const deploy = move({ jobId: "deploy", name: "deploy", variable: "BUILDHOUND_LINUX_TRUSTED", secrets: ["jobs.deploy.environment: production"], today });
    const plan = planRoutingPullRequest({ ...input(true), workflows: [{ path: ".github/workflows/ci.yml", content: routed }], moves: [deploy], kept: [] });
    expect(plan.files[0]!.after).toContain("runs-on: ${{ vars.BUILDHOUND_LINUX_TRUSTED || 'ubuntu-latest' }} # deploy box");
    expect(plan.files[0]!.added).toBe(1);
    expect(plan.body).toContain("| `ci.yml` | `deploy` | `${{ vars.BUILDHOUND_LINUX \\|\\| 'ubuntu-latest' }}` | `${{ vars.BUILDHOUND_LINUX_TRUSTED \\|\\| 'ubuntu-latest' }}` |");
    expect(plan.body).toContain("Merging changes nothing by itself. The jobs that use secrets read `BUILDHOUND_LINUX_TRUSTED`");
    expect(plan.body).not.toContain("the saving counts the jobs that use secrets");
    expect(plan.saving.hostedCentsPerMonth).toBe(0);
  });

  it("changes nothing when every job is already routed", () => {
    const routed = ci.replace("runs-on: ubuntu-latest\n    steps:\n      - run: npm test", "runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}\n    steps:\n      - run: npm test");
    const plan = planRoutingPullRequest({ ...input(true), workflows: [{ path: ".github/workflows/ci.yml", content: routed }], moves: [] });
    expect(plan.files).toEqual([]);
    expect(plan.routed).toEqual([]);
  });

  it("opens an upgrade-only pull request on a public repository with an older expression", () => {
    const routed = ci.replace("runs-on: ubuntu-latest\n    steps:\n      - run: npm test", "runs-on: ${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}\n    steps:\n      - run: npm test");
    const plan = planRoutingPullRequest({ ...input(false), workflows: [{ path: ".github/workflows/ci.yml", content: routed }], moves: [] });
    expect(plan.title).toBe("Keep jobs anyone on GitHub can start off your machines");
    expect(plan.upgrades).toEqual([{ workflow: ".github/workflows/ci.yml", jobs: [{ job: "test", from: "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}", to: routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true) }] }]);
    expect(plan.commitMessage).toMatch(/Buildhound-Route: upgrades$/);
    expect(plan.body).toContain("### Routing expressions upgraded");
  });
});
