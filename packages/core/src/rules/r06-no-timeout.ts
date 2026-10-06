import { isMap, type Document } from "yaml";
import { classify } from "../cost/classify";
import type { History, JobRecord, NormalisedJob } from "../model/types";
import { ruleById } from "./registry";
import type { Detection, Rule, RuleContext } from "./types";

const OUTLIER_FACTOR = 3;
const TIMEOUT_FACTOR = 1.5;
const MIN_TIMEOUT = 10;
const DEFAULT_TIMEOUT = 30;

function historyJobs(history: History | null, job: NormalisedJob): JobRecord[] {
  const name = job.name ?? job.id;
  return history?.jobs.filter((j) => (j.name === name || j.name.startsWith(name + " (")) && j.startedAt && j.completedAt) ?? [];
}

const durationMinutes = (j: JobRecord): number => Math.max(0, j.completedAt!.getTime() - j.startedAt!.getTime()) / 60_000;

/** Nearest-rank percentile over a sorted list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function median(sorted: number[]): number {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Insert timeout-minutes right after runs-on so the diff reads naturally; append when runs-on is absent. */
function insertTimeout(doc: Document, jobId: string, minutes: number): void {
  const job = doc.getIn(["jobs", jobId], true);
  if (!isMap(job)) return;
  const pair = doc.createPair("timeout-minutes", minutes);
  const at = job.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === "runs-on");
  job.items.splice(at < 0 ? job.items.length : at + 1, 0, pair);
}

export const R06: Rule = {
  meta: ruleById("R06")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, doc } = ctx.workflow;
    const out: Detection[] = [];
    for (const job of model.jobs) {
      if (job.timeoutMinutes !== null) continue;
      if (doc.hasIn(["jobs", job.id, "uses"])) continue; // reusable workflow calls take no timeout
      const c = classify(job.runsOn);
      const expensiveOs = job.runsOn.some((l) => { const os = classify([l]).os; return os === "macos" || os === "windows"; });
      const price = !ctx.repository.private && c.provider === "github" ? 0 : c.pricePerMinute;
      const durations = historyJobs(ctx.history, job).map(durationMinutes).sort((a, b) => a - b);
      const hasHistory = durations.length > 0;
      const p50 = hasHistory ? median(durations) : null;
      const p99 = hasHistory ? percentile(durations, 99) : null;
      const threshold = p50 === null ? null : p50 * OUTLIER_FACTOR;
      const over = threshold === null ? [] : durations.filter((d) => d > threshold);
      const excess = threshold === null ? 0 : over.reduce((a, d) => a + (d - threshold), 0);
      const scale = ctx.history ? 30 / Math.max(1, ctx.history.days) : 1;
      const minutes = Math.round(excess * scale);
      const hasOutliers = over.length > 0;
      const severity = hasOutliers || expensiveOs ? "medium" : "low";
      const confidence = hasOutliers ? 0.7 : expensiveOs ? 0.5 : 0.3;
      const timeout = p99 === null ? DEFAULT_TIMEOUT : Math.max(MIN_TIMEOUT, Math.ceil(p99 * TIMEOUT_FACTOR));
      const reason = hasOutliers
        ? `${over.length} run${over.length === 1 ? "" : "s"} exceeded ${OUTLIER_FACTOR}x its median duration`
        : expensiveOs ? `a hang on ${c.os} is expensive` : "a hang would run until GitHub's 6 hour limit";
      out.push({
        jobId: job.id,
        severity,
        evidence: {
          runsOn: job.runsOn,
          os: c.os,
          runsObserved: durations.length,
          p50Minutes: p50 === null ? null : round1(p50),
          p99Minutes: p99 === null ? null : round1(p99),
          runsOver3xP50: over.length,
          worstMinutes: hasHistory ? round1(durations[durations.length - 1]!) : null,
          excessMinutesPerMonth: minutes,
          proposedTimeoutMinutes: timeout,
          pricePerMinute: price,
        },
        estimate: { minutesPerMonth: minutes, centsPerMonth: Math.round(minutes * price * 100), confidence },
        summary: `Job "${job.id}" has no timeout-minutes; ${reason}`,
        fix: (d: Document) => insertTimeout(d, job.id, timeout),
      });
    }
    return out;
  },
};
