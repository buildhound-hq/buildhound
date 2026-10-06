import { isMap, isScalar, isSeq, type Document } from "yaml";
import { classify } from "../cost/classify";
import { cronInfo } from "../estimate/cron";
import type { History, NormalisedWorkflow, RunRecord } from "../model/types";
import { ruleById } from "./registry";
import type { Detection, Rule, RuleContext } from "./types";

const SIX_HOURS = 6 * 60;
const SIX_HOURLY = "0 */6 * * *";
const DAILY = "0 0 * * *";
const WEEKLY = "0 0 * * 1";
/** Fewer scheduled runs than this say nothing about whether the schedule is useful. */
const MIN_SCHEDULED_RUNS = 5;

const SIDE_EFFECT_USES = /upload-artifact|deploy|publish|release|pages|build-push-action|docker\/login|aws-actions|azure\/|cloudflare\/|vercel|netlify|heroku/i;
const SIDE_EFFECT_RUN = /\b(deploy|publish|release|docker push|git push|rsync|scp|s3 (cp|sync)|twine upload|gh release|npm publish|cargo publish|pod trunk push|fastlane)\b/i;
const SIDE_EFFECT_NAME = /deploy|publish|release|upload/i;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Steps that deploy, publish or upload: a scheduled run of such a workflow has value even when every conclusion is identical. */
function sideEffectSteps(model: NormalisedWorkflow): string[] {
  const out: string[] = [];
  for (const job of model.jobs) {
    for (const step of job.steps) {
      const hit = (step.uses && SIDE_EFFECT_USES.test(step.uses)) || (step.run && SIDE_EFFECT_RUN.test(step.run)) || (step.name && SIDE_EFFECT_NAME.test(step.name));
      if (hit) out.push(`${job.id}: ${step.name ?? step.uses ?? (step.run ?? "").split("\n")[0]}`);
    }
  }
  return out;
}

interface ScheduledHistory {
  runs: RunRecord[];
  identicalConclusions: boolean;
  /** Median billable minutes across all jobs of a scheduled run, from observed timings. */
  medianMinutesPerRun: number | null;
  /** Cost of this workflow's scheduled runs over the cost of every job in the window. */
  shareOfRepoSpend: number | null;
}

function jobMinutes(startedAt: Date | null, completedAt: Date | null): number {
  if (!startedAt || !completedAt) return 0;
  return Math.max(1, Math.ceil((completedAt.getTime() - startedAt.getTime()) / 60_000));
}

function scheduledHistory(history: History, workflowPath: string): ScheduledHistory {
  const runs = history.runs.filter((r) => r.workflowPath === workflowPath && r.event === "schedule");
  const runIds = new Set(runs.map((r) => r.id));
  const minutesByRun = new Map<number, number>();
  let scheduledCents = 0;
  let totalCents = 0;
  for (const job of history.jobs) {
    const minutes = jobMinutes(job.startedAt, job.completedAt);
    if (!minutes) continue;
    const cents = minutes * classify(job.labels).pricePerMinute * 100;
    totalCents += cents;
    if (runIds.has(job.runId)) {
      scheduledCents += cents;
      minutesByRun.set(job.runId, (minutesByRun.get(job.runId) ?? 0) + minutes);
    }
  }
  const identicalConclusions = runs.length >= MIN_SCHEDULED_RUNS && runs.every((r) => r.conclusion !== null && r.conclusion === runs[0]!.conclusion);
  return {
    runs,
    identicalConclusions,
    medianMinutesPerRun: median([...minutesByRun.values()]),
    shareOfRepoSpend: totalCents > 0 ? Math.round((scheduledCents / totalCents) * 1000) / 1000 : null,
  };
}

/** Rewrite the matching cron scalar in place and leave a breadcrumb comment on the same line. */
function rewriteCron(doc: Document, oldCron: string, newCron: string): void {
  const seq = doc.getIn(["on", "schedule"], true);
  if (!isSeq(seq)) return;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const scalar = item.get("cron", true);
    if (!isScalar(scalar) || String(scalar.value) !== oldCron) continue;
    scalar.value = newCron;
    // A comment inside a flow map ({ cron: ... }) would force it onto several lines, so annotate the entry instead.
    const target = item.flow ? item : scalar;
    const note = `Buildhound: was "${oldCron}"`;
    const existing = typeof target.comment === "string" ? target.comment.trim() : "";
    target.comment = existing ? ` ${existing} (${note})` : ` ${note}`;
    return;
  }
}

export const R01: Rule = {
  meta: ruleById("R01")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, path } = ctx.workflow;
    if (!model.events.includes("schedule") || !model.schedules.length) return [];

    const estimate = ctx.estimator.estimateWorkflow(model, ctx.history, path);
    const estimatedMinutesPerRun = estimate.jobs.reduce((a, j) => a + j.minutesPerRun * j.entries, 0);
    const centsPerEstimatedMinute = estimatedMinutesPerRun > 0 ? estimate.jobs.reduce((a, j) => a + j.minutesPerRun * j.entries * j.pricePerMinute * 100, 0) / estimatedMinutesPerRun : 0;
    const history = ctx.history ? scheduledHistory(ctx.history, path) : null;
    const sideEffects = sideEffectSteps(model);
    const lowValue = history !== null && history.identicalConclusions && sideEffects.length === 0;
    const minutesPerRun = history?.medianMinutesPerRun ?? estimatedMinutesPerRun;
    const totalScheduleRuns = model.schedules.reduce((n, c) => n + cronInfo(c).runsPerMonth, 0);

    const out: Detection[] = [];
    const seen = new Set<string>();
    for (const cron of model.schedules) {
      if (seen.has(cron)) continue;
      seen.add(cron);
      const info = cronInfo(cron);
      if (!info.valid || info.runsPerMonth === 0) continue;
      const tooFrequent = info.minIntervalMinutes > 0 && info.minIntervalMinutes < SIX_HOURS;
      if (!tooFrequent && !lowValue) continue;

      const proposed = lowValue ? WEEKLY : history?.identicalConclusions ? DAILY : SIX_HOURLY;
      const proposedInfo = cronInfo(proposed);
      if (proposedInfo.runsPerMonth >= info.runsPerMonth) continue;

      const removedRuns = info.runsPerMonth - proposedInfo.runsPerMonth;
      const minutesPerMonth = Math.round(removedRuns * minutesPerRun);
      const centsPerMonth = Math.round(removedRuns * minutesPerRun * centsPerEstimatedMinute);
      const confidence = tooFrequent ? (history?.medianMinutesPerRun !== null && history !== null ? 0.8 : 0.6) : 0.4;
      const share = history !== null && history.shareOfRepoSpend !== null && totalScheduleRuns > 0 ? Math.round(history.shareOfRepoSpend * (info.runsPerMonth / totalScheduleRuns) * 1000) / 1000 : null;

      out.push({
        jobId: null,
        evidence: {
          cron,
          runsPerMonth: info.runsPerMonth,
          minIntervalMinutes: info.minIntervalMinutes,
          medianMinutesPerRun: history?.medianMinutesPerRun ?? null,
          estimatedMinutesPerRun,
          shareOfRepoSpend: share,
          proposedCron: proposed,
          proposedRunsPerMonth: proposedInfo.runsPerMonth,
          tooFrequent,
          lowValue,
          scheduledRunsInWindow: history?.runs.length ?? 0,
          identicalConclusions: history?.identicalConclusions ?? null,
          sideEffectSteps: sideEffects,
        },
        estimate: { minutesPerMonth, centsPerMonth, confidence },
        summary: tooFrequent
          ? `Schedule "${cron}" runs every ${info.minIntervalMinutes} minutes (${info.runsPerMonth} runs a month); "${proposed}" would run ${proposedInfo.runsPerMonth} times`
          : `Schedule "${cron}" produced ${history!.runs.length} identical runs with no deploy or publish step; "${proposed}" would run ${proposedInfo.runsPerMonth} times a month`,
        fix: (doc) => rewriteCron(doc, cron, proposed),
      });
    }
    return out;
  },
};
