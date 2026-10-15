import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { ALL_RULES } from "../rules/index";
import { makeContext } from "../rules/context";
import { RULES } from "../rules/registry";
import { runRules } from "../rules/runner";
import type { Finding, Rule } from "../rules/types";
import type { History, RepositoryInfo } from "../model/types";
import { countComments } from "../yaml";
import { COMBINED_FIX_BRANCH, fixBranch, fixMarkerRules, fixPullRequestBody, planFixes, type FixSource } from "./index";

const repo: RepositoryInfo = { fullName: "acme/app", private: true, defaultBranch: "main" };

const CI = `# CI for the app.
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  # Lint first.
  lint:
    runs-on: ubuntu-latest   # Linux is enough
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test # the real work
`;

const NIGHTLY = `# Nightly link check.
name: Nightly
on:
  schedule:
    - cron: "*/5 * * * *"   # far too often

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/check-links.sh
`;

async function scan(workflows: Array<{ path: string; content: string }>, rules: readonly Rule[] = ALL_RULES, extra: Partial<FixSource> = {}): Promise<{ findings: Finding[]; src: FixSource }> {
  const src: FixSource = { workflows, repository: repo, history: null, rules, ...extra };
  const findings: Finding[] = [];
  for (const w of workflows) {
    const ctx = makeContext({ path: w.path, content: w.content, repository: repo, ...(extra.resolveActionRef ? { resolveActionRef: extra.resolveActionRef } : {}) });
    findings.push(...(await runRules(rules, ctx)));
  }
  return { findings, src };
}

const files = [
  { path: ".github/workflows/ci.yml", content: CI },
  { path: ".github/workflows/nightly.yml", content: NIGHTLY },
];

describe("fix pull requests: planning", () => {
  it("opens one pull request per rule, with every file that rule fixes, on a buildhound/fix- branch", async () => {
    const { findings, src } = await scan(files);
    const plan = planFixes(findings, src);
    const r06 = plan.groups.find((g) => g.key === "r06")!;
    expect(r06.branch).toBe("buildhound/fix-r06-no-timeout");
    expect(r06.title).toBe("Fix: Job without timeout-minutes");
    expect(r06.ruleIds).toEqual(["R06"]);
    expect(r06.files.map((f) => f.path)).toEqual([".github/workflows/ci.yml", ".github/workflows/nightly.yml"]);
    // Both jobs in ci.yml get their timeout in the one pull request.
    expect(r06.findings.filter((f) => f.workflowPath === ".github/workflows/ci.yml").map((f) => f.jobName)).toEqual(["lint", "test"]);
    const ci = r06.files.find((f) => f.path === ".github/workflows/ci.yml")!;
    expect(ci.after.match(/timeout-minutes/g)).toHaveLength(2);
    expect(ci.added).toBe(2);
    expect(ci.removed).toBe(0);
    // Every group's files differ from the original only by its own rule's fix.
    for (const g of plan.groups) {
      for (const f of g.files) {
        expect(countComments(f.after)).toBe(countComments(f.before));
        expect(parseDocument(f.after).errors).toEqual([]);
      }
    }
    expect(plan.groups.map((g) => g.branch)).toEqual([...new Set(plan.groups.map((g) => g.branch))]);
    expect(plan.groups.find((g) => g.key === "r01")?.files.map((f) => f.path)).toEqual([".github/workflows/nightly.yml"]);
  });

  it("--one-pr puts every fix in one pull request, composed on the same file", async () => {
    const { findings, src } = await scan(files);
    const perRule = planFixes(findings, src);
    const plan = planFixes(findings, src, { onePr: true });
    expect(plan.groups).toHaveLength(1);
    const g = plan.groups[0]!;
    expect(g.branch).toBe(COMBINED_FIX_BRANCH);
    expect(g.key).toBe("ci-report");
    expect(g.ruleIds.sort()).toEqual([...new Set(perRule.groups.flatMap((x) => x.ruleIds))].sort());
    expect(g.title).toBe(`Fix ${g.findings.length} findings from the Buildhound CI report`);
    const ci = g.files.find((f) => f.path === ".github/workflows/ci.yml")!;
    // R03's concurrency block and R06's timeouts both land in ci.yml, and nothing else changes.
    expect(ci.after).toContain("cancel-in-progress");
    expect(ci.after.match(/timeout-minutes/g)).toHaveLength(2);
    expect(ci.after).toContain("# Linux is enough");
    expect(ci.after).toContain("npm test # the real work");
    expect(countComments(ci.after)).toBe(countComments(CI));
  });

  it("--rule chooses which rules get a pull request", async () => {
    const { findings, src } = await scan(files);
    const plan = planFixes(findings, src, { only: ["R01"] });
    expect(plan.groups.map((g) => g.key)).toEqual(["r01"]);
    expect(plan.groups[0]!.files.map((f) => f.path)).toEqual([".github/workflows/nightly.yml"]);
  });

  it("is deterministic, so a rerun plans the same branches, files and bodies", async () => {
    const { findings, src } = await scan(files);
    const a = planFixes(findings, src);
    const b = planFixes(findings, src);
    expect(b.groups.map((g) => [g.branch, g.body, g.files.map((f) => f.after)])).toEqual(a.groups.map((g) => [g.branch, g.body, g.files.map((f) => f.after)]));
  });

  it("lists findings without a diff as no automatic fix, with the reason", async () => {
    const rules = ALL_RULES.filter((r) => r.meta.id === "R17");
    const { findings, src } = await scan(files, rules);
    expect(findings.length).toBeGreaterThan(0);
    const plan = planFixes(findings, src);
    expect(plan.groups).toEqual([]);
    expect(plan.withoutFix.map((w) => w.finding.ruleId)).toEqual(findings.map(() => "R17"));
    expect(plan.withoutFix[0]!.reason).toMatch(/commit SHA could not be resolved/);
  });

  it("pins R17 once the tags are resolved first", async () => {
    const rules = ALL_RULES.filter((r) => r.meta.id === "R17");
    const sha = "11bd71901bbe5b1630ceea73d27597364c9af683";
    const { findings, src } = await scan(files, rules, { resolveActionRef: (o, r, ref) => (o === "actions" && r === "checkout" && ref === "v4" ? sha : null) });
    const plan = planFixes(findings, src);
    expect(plan.groups.map((g) => g.branch)).toEqual(["buildhound/fix-r17-unpinned-actions"]);
    expect(plan.groups[0]!.files[0]!.after).toContain(`actions/checkout@${sha} # v4`);
  });

  it("names branches after the rule id and slug", () => {
    expect(fixBranch("R03")).toBe("buildhound/fix-r03-cancel-in-progress");
    expect(fixBranch("R17")).toBe("buildhound/fix-r17-unpinned-actions");
  });
});

describe("fix pull requests: body", () => {
  it("carries the marker, evidence, estimate, confidence, the change, and the footer", async () => {
    const { findings, src } = await scan(files);
    const g = planFixes(findings, src).groups.find((x) => x.key === "r06")!;
    expect(fixMarkerRules(g.body)).toEqual(["R06"]);
    expect(g.body).toContain("### R06: Job without timeout-minutes");
    expect(g.body).toContain("`.github/workflows/ci.yml`, job `lint`");
    expect(g.body).toContain("- Estimated saving: none measured, confidence low (0.3).");
    const r01 = planFixes(findings, src).groups.find((x) => x.key === "r01")!;
    expect(r01.body).toMatch(/- Estimated saving: about \$\d+\.\d\d a month \(\d+ minutes\), confidence (high|medium|low) \(0\.\d+\)\./);
    expect(r01.body).not.toContain("**Estimated saving:**");
    // The total leads only a pull request with more than one finding.
    expect(planFixes(findings, src, { onePr: true }).groups[0]!.body).toMatch(/\*\*Estimated saving:\*\* about \$\d+\.\d\d a month/);
    expect(g.body).not.toMatch(/^=+$/m);
    expect(g.body).toContain("<summary>Evidence</summary>");
    expect(g.body).toContain("- `.github/workflows/ci.yml`: 2 lines added, 0 removed.");
    expect(g.body).toContain("```diff");
    expect(g.body).toContain("Opened by [Buildhound](https://buildhound.sh) from its free CI report (`npx buildhound scan --fix`)");
    expect(g.body).not.toContain("### Assumption");
    expect(g.body).not.toMatch(/\u2014/);
  });

  it("has an Assumption section exactly for the rules whose fix can change behaviour (CLAUDE.md rule 14)", () => {
    expect(RULES.filter((r) => r.changesBehaviour).map((r) => r.id)).toEqual(["R02", "R04", "R10", "R13", "R14", "R15", "R16", "R18", "R19"]);
    for (const meta of RULES) {
      const f: Finding = {
        ruleId: meta.id, slug: meta.slug, title: meta.title, workflowPath: ".github/workflows/ci.yml", jobName: "build", severity: meta.severity,
        evidence: { risk: "high" }, estimate: { minutesPerMonth: 0, centsPerMonth: 0, confidence: 0.6 }, summary: "Something to fix",
        confirmBeforeMerging: meta.changesBehaviour ? `Confirm before merging: the ${meta.id} assumption holds` : null, diff: "--- a\n+++ b\n", fingerprint: "f",
      };
      const body = fixPullRequestBody({ ruleIds: [meta.id], findings: [f], files: [{ path: f.workflowPath, before: "", after: "", diff: "", added: 1, removed: 0 }], savingCentsPerMonth: 0, savingMinutesPerMonth: 0 }, repo);
      if (meta.changesBehaviour) {
        expect(body, meta.id).toContain("### Assumption");
        expect(body, meta.id).toContain(`Confirm before merging:\n- the ${meta.id} assumption holds`);
      } else {
        expect(body, meta.id).not.toContain("### Assumption");
      }
      expect(body).toContain("Risk: high. A security fix, so no dollar estimate; confidence medium (0.6).");
    }
  });

  it("drops the diff, then the evidence, before going over GitHub's body limit", () => {
    const big = "+x\n".repeat(30_000);
    const f: Finding = { ruleId: "R06", slug: "no-timeout", title: "t", workflowPath: "w.yml", jobName: null, severity: "low", evidence: {}, estimate: { minutesPerMonth: 1, centsPerMonth: 1, confidence: 0.5 }, summary: "s", confirmBeforeMerging: null, diff: big, fingerprint: "f" };
    const body = fixPullRequestBody({ ruleIds: ["R06"], findings: [f], files: [{ path: "w.yml", before: "", after: "", diff: big, added: 30_000, removed: 0 }], savingCentsPerMonth: 1, savingMinutesPerMonth: 1 }, repo);
    expect(body.length).toBeLessThan(65_536);
    expect(body).not.toContain("```diff");
  });
});

/**
 * Every rule with a fix: the pull request's file is byte-identical to the original except the fix, comments kept.
 * Reuses the rule fixtures' comments cases (fixtures/workflows/<slug>/comments.yml and .fixed.yml).
 */
describe("fix pull requests: rule fixes keep comments", () => {
  const root = join(__dirname, "..", "..", "fixtures", "workflows");
  const revive = (raw: unknown): History | null => {
    if (!raw) return null;
    const h = raw as History;
    return {
      days: h.days,
      runs: h.runs.map((r) => ({ ...r, createdAt: new Date(r.createdAt), runStartedAt: r.runStartedAt ? new Date(r.runStartedAt) : null })),
      jobs: h.jobs.map((j) => ({ ...j, startedAt: j.startedAt ? new Date(j.startedAt) : null, completedAt: j.completedAt ? new Date(j.completedAt) : null })),
    };
  };
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    for (const c of readdirSync(dir).filter((f) => f.endsWith(".fixed.yml")).map((f) => f.replace(/\.fixed\.yml$/, ""))) {
      it(`rule ${slug} case ${c} opens a pull request whose file is the fixed fixture`, async () => {
        const rule = ALL_RULES.find((r) => r.meta.slug === slug)!;
        const content = readFileSync(join(dir, `${c}.yml`), "utf8");
        const hist = join(dir, `${c}.history.json`);
        const history = existsSync(hist) ? revive(JSON.parse(readFileSync(hist, "utf8"))) : null;
        const refsPath = join(dir, `${c}.refs.json`);
        const refs = existsSync(refsPath) ? (JSON.parse(readFileSync(refsPath, "utf8")) as Record<string, string>) : null;
        const resolveActionRef = refs ? (o: string, r: string, ref: string) => refs[`${o}/${r}@${ref}`] ?? null : undefined;
        const path = `.github/workflows/${c}.yml`;
        const ctx = makeContext({ path, content, history, ...(resolveActionRef ? { resolveActionRef } : {}) });
        const findings = await runRules([rule], ctx);
        const plan = planFixes(findings, { workflows: [{ path, content }], repository: ctx.repository, history, rules: [rule], ...(resolveActionRef ? { resolveActionRef } : {}) });
        expect(plan.groups).toHaveLength(1);
        const file = plan.groups[0]!.files[0]!;
        expect(countComments(file.after)).toBeGreaterThanOrEqual(countComments(content));
        const withDiff = findings.filter((f) => f.diff);
        if (withDiff.length === 1) expect(file.after).toBe(readFileSync(join(dir, `${c}.fixed.yml`), "utf8"));
        else for (const f of withDiff) for (const line of f.diff!.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))) expect(file.after).toContain(line.slice(1));
      });
    }
  }
});
