import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_RULES } from "./index";
import { makeContext } from "./context";
import { runRules } from "./runner";
import type { History } from "../model/types";

/**
 * Snapshot cases: fixtures/workflows/<slug>/<case>.yml, <case>.expected.json, optional <case>.fixed.yml, <case>.history.json
 * and <case>.refs.json (action references to commit SHAs, `{ "owner/repo@ref": "<sha>" }`, standing in for GitHub in R17).
 * expected.json: { "findings": number, "jobs"?: string[], "minCentsPerMonth"?: number, "diffContains"?: string[], "risks"?: string[], "noDiff"?: true }
 * Every rule needs a positive, a negative and a comments case (RULES.md).
 */
const root = join(__dirname, "..", "..", "fixtures", "workflows");
const slugs = existsSync(root) ? readdirSync(root) : [];

function reviveHistory(raw: unknown): History | null {
  if (!raw) return null;
  const h = raw as History;
  return {
    days: h.days,
    runs: h.runs.map((r) => ({ ...r, createdAt: new Date(r.createdAt), runStartedAt: r.runStartedAt ? new Date(r.runStartedAt) : null })),
    jobs: h.jobs.map((j) => ({ ...j, startedAt: j.startedAt ? new Date(j.startedAt) : null, completedAt: j.completedAt ? new Date(j.completedAt) : null })),
  };
}

function refsResolver(refs: Record<string, string>): (owner: string, repo: string, ref: string) => string | null {
  return (owner, repo, ref) => refs[`${owner}/${repo}@${ref}`] ?? null;
}

describe("rule fixtures", () => {
  for (const slug of slugs) {
    const rule = ALL_RULES.find((r) => r.meta.slug === slug);
    const dir = join(root, slug);
    const cases = readdirSync(dir).filter((f) => f.endsWith(".yml") && !f.endsWith(".fixed.yml")).map((f) => f.replace(/\.yml$/, ""));
    describe(`rule ${slug}`, () => {
      it("is a registered rule with positive, negative and comments cases", () => {
        expect(rule, `no rule for fixture folder ${slug}`).toBeDefined();
        expect(cases.some((c) => c.startsWith("positive"))).toBe(true);
        expect(cases.some((c) => c.startsWith("negative"))).toBe(true);
        expect(cases.some((c) => c.startsWith("comments"))).toBe(true);
      });
      for (const c of cases) {
        it(`rule ${slug} case ${c}`, async () => {
          const content = readFileSync(join(dir, `${c}.yml`), "utf8");
          const expected = JSON.parse(readFileSync(join(dir, `${c}.expected.json`), "utf8")) as { findings: number; jobs?: string[]; minCentsPerMonth?: number; diffContains?: string[]; confirm?: boolean; risks?: string[]; noDiff?: boolean };
          const histPath = join(dir, `${c}.history.json`);
          const history = existsSync(histPath) ? reviveHistory(JSON.parse(readFileSync(histPath, "utf8"))) : null;
          const refsPath = join(dir, `${c}.refs.json`);
          const refs = existsSync(refsPath) ? (JSON.parse(readFileSync(refsPath, "utf8")) as Record<string, string>) : null;
          const ctx = makeContext({ path: `.github/workflows/${c}.yml`, content, history, ...(refs ? { resolveActionRef: refsResolver(refs) } : {}) });
          const findings = await runRules([rule!], ctx);
          expect(findings).toHaveLength(expected.findings);
          if (expected.jobs) expect(findings.map((f) => f.jobName)).toEqual(expected.jobs);
          if (expected.minCentsPerMonth !== undefined) expect(findings.reduce((a, f) => a + f.estimate.centsPerMonth, 0)).toBeGreaterThanOrEqual(expected.minCentsPerMonth);
          for (const f of findings) {
            expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
            expect(f.estimate.confidence).toBeGreaterThan(0);
            expect(f.estimate.confidence).toBeLessThanOrEqual(1);
            if (rule!.meta.changesBehaviour) expect(f.confirmBeforeMerging).toBeTruthy();
          }
          const fixedPath = join(dir, `${c}.fixed.yml`);
          if (existsSync(fixedPath)) {
            const fixed = readFileSync(fixedPath, "utf8");
            const withDiff = findings.find((f) => f.diff);
            expect(withDiff?.diff, "expected a diff").toBeTruthy();
            const { applyEdit } = await import("../yaml");
            // Re-apply the rule's fix to compare the full file, not just the diff.
            const d = rule!.detect(ctx).find((x) => x.fix)!;
            expect(applyEdit(ctx.workflow.path, content, d.fix!).after).toBe(fixed);
          }
          for (const s of expected.diffContains ?? []) expect(findings.map((f) => f.diff ?? "").join("\n")).toContain(s);
          if (expected.risks) expect(findings.map((f) => f.evidence.risk)).toEqual(expected.risks);
          if (expected.noDiff) for (const f of findings) expect(f.diff).toBeNull();
        });
      }
    });
  }
  it("every M1 rule has a fixture folder", () => {
    for (const r of ALL_RULES) expect(slugs, `missing fixtures/workflows/${r.meta.slug}`).toContain(r.meta.slug);
  });
});
