/**
 * R13 slim-runner (RULES.md). A job on a 2-core GitHub Linux runner whose steps are all light
 * (lint, format, type check, docs, bots) fits the 1-core `ubuntu-slim` runner at a third of the price.
 * Estimate per COST_MODEL.md: observed minutes at the linux_2 price minus 1.5 times those minutes at the
 * linux_1_slim price, because one vCPU is assumed 1.5 times slower. Changes behaviour (CLAUDE.md rule 14).
 */
import type { Document } from "yaml";
import { classify } from "../cost/classify";
import { githubRateForLabel } from "../cost/rates/github";
import type { History, JobRecord, NormalisedJob, NormalisedStep } from "../model/types";
import { ruleById } from "./registry";
import { setRunsOn } from "./routing";
import type { Detection, Rule, RuleContext } from "./types";

const SLIM_LABEL = "ubuntu-slim";
const SLIM_DURATION_FACTOR = 1.5;
const MAX_P95_SECONDS = 3 * 60;

/** Actions that never need a 2-core runner on their own. */
const SAFE_ACTIONS = ["actions/checkout", "actions/setup-node", "actions/setup-python", "pnpm/action-setup", "actions/cache", "actions/github-script"];

const LIGHT =
  /\blint\b|lint-staged|eslint|prettier|biome|\bruff\b|\bblack\b|\bmypy\b|flake8|isort|pylint|rubocop|stylelint|shellcheck|hadolint|yamllint|markdownlint|actionlint|commitlint|\btypos\b|spell|tsc\b[^\n]*--noemit|\bfmt\b|\bformat(ting)?\b|\bmarkdown\b|\bdocs?\b|\bdocumentation\b|mkdocs|mdbook|sphinx|docusaurus|vitepress|changelog|release-drafter|\blabel(s|er|ing)?\b|\bcomment(s|er)?\b|\bstale\b|first-interaction|semantic-pull-request|pr-title|github-script|\b(npm|pnpm|yarn|bun)\s+(ci|install|i)\b|\bpip\s+install\b|\bpoetry\s+install\b/i;
const DOCS_CONTEXT = /\bdocs?\b|\bdocumentation\b|\bmarkdown\b|mkdocs|mdbook|sphinx|docusaurus|vitepress|\bsite\b/i;
const HEAVY = /\bdocker\b|\btests?\b|\btesting\b|\bjest\b|\bvitest\b|\bpytest\b|\bcargo\s+build\b|\bgo\s+build\b|\bnext\s+build\b|\bwebpack\b|\bmemory\b|\bheap\b|max-old-space-size|\bcompile\b/i;
const BUILD = /\bbuild(s|ing)?\b/i;

type StepClass = "light" | "heavy" | "unknown";

function stepText(s: NormalisedStep): string {
  const withValues = Object.values(s.with).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n");
  return [s.name ?? "", s.uses ?? "", s.run ?? "", withValues].join("\n");
}

export function classifyStep(s: NormalisedStep): StepClass {
  const text = stepText(s);
  if (HEAVY.test(text)) return "heavy";
  // A docs or markdown build is light; any other build is not.
  if (BUILD.test(text) && !DOCS_CONTEXT.test(text)) return "heavy";
  if (s.uses && SAFE_ACTIONS.some((a) => s.uses === a || s.uses!.startsWith(a + "@"))) return "light";
  if (LIGHT.test(text)) return "light";
  return "unknown";
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

function historyJobs(history: History, job: NormalisedJob): JobRecord[] {
  const name = job.name ?? job.id;
  return history.jobs.filter((j) => (j.name === name || j.name.startsWith(name + " (")) && j.startedAt && j.completedAt);
}

const durationSeconds = (j: JobRecord): number => Math.max(0, Math.floor((j.completedAt!.getTime() - j.startedAt!.getTime()) / 1000));
const rawMinutes = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

function rawRunsOn(doc: Document, jobId: string): unknown {
  const js = doc.toJS({ mapAsMap: false }) as { jobs?: Record<string, { "runs-on"?: unknown }> };
  return js.jobs?.[jobId]?.["runs-on"];
}

export const R13: Rule = {
  meta: ruleById("R13")!,
  detect(ctx: RuleContext): Detection[] {
    // Public repositories pay nothing for GitHub-hosted minutes, so there is no dollar saving.
    if (!ctx.repository.private) return [];
    const slimPrice = githubRateForLabel(SLIM_LABEL)!.pricePerMinute;
    const out: Detection[] = [];
    for (const job of ctx.workflow.model.jobs) {
      if (job.usesContainer || job.usesServices || job.steps.length === 0) continue;
      if (job.runsOn.length !== 1) continue;
      const raw = rawRunsOn(ctx.workflow.doc, job.id);
      if (JSON.stringify(raw).includes("${{")) continue;
      const current = classify(job.runsOn);
      if (current.provider !== "github" || current.runnerClass !== "linux_2") continue;

      const classes = job.steps.map(classifyStep);
      if (classes.includes("heavy") || !classes.includes("light")) continue;

      const observed = ctx.history ? historyJobs(ctx.history, job) : [];
      let p50Minutes: number | null = null, p95Minutes: number | null = null, runsPerMonth: number, observedMinutes: number, confidence: number, basis: "history" | "static";
      if (ctx.history && observed.length) {
        const seconds = observed.map(durationSeconds).sort((a, b) => a - b);
        const p95Seconds = percentile(seconds, 0.95);
        if (p95Seconds >= MAX_P95_SECONDS) continue;
        const scale = 30 / Math.max(1, ctx.history.days);
        p50Minutes = rawMinutes(percentile(seconds, 0.5));
        p95Minutes = rawMinutes(p95Seconds);
        runsPerMonth = Math.round(observed.length * scale);
        observedMinutes = Math.round(seconds.reduce((a, s) => a + rawMinutes(s), 0) * scale);
        confidence = 0.7;
        basis = "history";
      } else {
        // No history: every step must be light, and the estimate comes from the static estimator.
        if (classes.includes("unknown")) continue;
        const est = ctx.estimator.estimateWorkflow(ctx.workflow.model, ctx.history, ctx.workflow.path).jobs.find((j) => j.jobId === job.id);
        runsPerMonth = est?.runsPerMonth ?? 0;
        observedMinutes = est?.minutesPerMonth ?? 0;
        confidence = 0.4;
        basis = "static";
      }
      if (observedMinutes <= 0) continue;
      const centsPerMonth = Math.round(observedMinutes * current.pricePerMinute * 100 - observedMinutes * SLIM_DURATION_FACTOR * slimPrice * 100);
      if (centsPerMonth <= 0) continue;
      const stepNames = job.steps.map((s) => s.name ?? s.uses ?? (s.run ?? "").split("\n")[0] ?? "");
      out.push({
        jobId: job.id,
        evidence: {
          label: job.runsOn[0],
          stepNames,
          p50Minutes,
          p95Minutes,
          runsPerMonth,
          observedMinutesPerMonth: observedMinutes,
          slimMinutesPerMonth: Math.round(observedMinutes * SLIM_DURATION_FACTOR),
          currentPricePerMinute: current.pricePerMinute,
          slimPricePerMinute: slimPrice,
          durationFactor: SLIM_DURATION_FACTOR,
          basis,
        },
        // This rule changes the unit price, not the run count: the minutes are the ones the fix touches.
        estimate: { minutesPerMonth: observedMinutes, centsPerMonth, confidence },
        summary: `Job "${job.id}" only runs light steps on ${job.runsOn[0]}; ${SLIM_LABEL} would save about $${(centsPerMonth / 100).toFixed(2)} a month`,
        confirmBeforeMerging: `Confirm before merging: job "${job.id}" needs no Docker and under 2 GB of memory. ${SLIM_LABEL} has one vCPU, 2 GB of memory and no Docker; the job may run up to 1.5 times longer.`,
        fix: (doc) => setRunsOn(doc, job.id, SLIM_LABEL),
      });
    }
    return out;
  },
};
