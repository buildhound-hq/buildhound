import { isCollection, isMap, isNode, isPair, isScalar, type Document, type Node } from "yaml";
import type { History, NormalisedConcurrency, RunRecord } from "../model/types";
import { ruleById } from "./registry";
import type { Detection, Rule, RuleContext } from "./types";

const GROUP = "${{ github.workflow }}-${{ github.ref }}";
const CANCEL = "${{ github.ref != format('refs/heads/{0}', github.event.repository.default_branch) }}";
/** Without history, this share of branch runs is assumed to be superseded by a newer push. */
const ASSUMED_SUPERSEDED_SHARE = 0.1;
const FALLBACK_RUN_MINUTES = 5;
const MAX_BRANCHES_NAMED = 10;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** `true` or any expression counts as set; `false` and absent do not. */
function cancels(c: NormalisedConcurrency | null): boolean {
  return c !== null && (c.cancelInProgress === true || typeof c.cancelInProgress === "string");
}

interface Overlap {
  pairs: number;
  /** Wall-clock minutes of superseded runs after the superseding run started, in the window. */
  supersededMinutes: number;
  branchRuns: number;
  medianRunMinutes: number | null;
  branches: string[];
}

function runStart(r: RunRecord): number {
  return (r.runStartedAt ?? r.createdAt).getTime();
}

function findOverlaps(history: History, workflowPath: string, defaultBranch: string, fallbackMinutes: number): Overlap {
  const runs = history.runs.filter((r) => r.workflowPath === workflowPath && (r.event === "push" || r.event === "pull_request") && r.headBranch !== null && r.headBranch !== defaultBranch);
  // Wall-clock duration of each run from its jobs, where timings exist.
  const span = new Map<number, { start: number; end: number }>();
  for (const job of history.jobs) {
    if (!job.startedAt || !job.completedAt) continue;
    const s = span.get(job.runId);
    const start = job.startedAt.getTime(), end = job.completedAt.getTime();
    if (!s) span.set(job.runId, { start, end });
    else { s.start = Math.min(s.start, start); s.end = Math.max(s.end, end); }
  }
  const durationMs = (r: RunRecord): number | null => {
    const s = span.get(r.id);
    return s ? Math.max(60_000, s.end - s.start) : null;
  };
  const observed = runs.map(durationMs).filter((d): d is number => d !== null).map((d) => d / 60_000);
  const medianRunMinutes = median(observed);
  const typicalMs = (medianRunMinutes ?? fallbackMinutes) * 60_000;

  const byBranch = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const list = byBranch.get(r.headBranch!) ?? [];
    list.push(r);
    byBranch.set(r.headBranch!, list);
  }
  let pairs = 0, supersededMs = 0;
  const branches = new Map<string, number>();
  for (const [branch, list] of byBranch) {
    list.sort((a, b) => runStart(a) - runStart(b));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!, next = list[i]!;
      const prevEnd = runStart(prev) + (durationMs(prev) ?? typicalMs);
      const nextStart = runStart(next);
      if (nextStart >= prevEnd) continue;
      pairs++;
      supersededMs += prevEnd - nextStart;
      branches.set(branch, (branches.get(branch) ?? 0) + 1);
    }
  }
  return {
    pairs,
    supersededMinutes: Math.round(supersededMs / 60_000),
    branchRuns: runs.length,
    medianRunMinutes: medianRunMinutes === null ? null : Math.round(medianRunMinutes * 10) / 10,
    branches: [...branches.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b),
  };
}

/** Insert the concurrency block directly after `on`, or complete an existing workflow-level block that does not cancel. */
function addConcurrency(doc: Document): void {
  const root = doc.contents;
  if (!isMap(root)) return;
  const existing = root.get("concurrency", true);
  if (isMap(existing)) {
    existing.set("cancel-in-progress", CANCEL);
    return;
  }
  if (isScalar(existing) && existing.value !== null) {
    const replacement = doc.createNode({ group: String(existing.value), "cancel-in-progress": CANCEL });
    root.set("concurrency", replacement);
    return;
  }
  if (existing !== undefined) root.delete("concurrency");
  const pair = doc.createPair("concurrency", { group: GROUP, "cancel-in-progress": CANCEL });
  const onIndex = root.items.findIndex((p) => isScalar(p.key) && (p.key.value === "on" || p.key.value === true));
  if (onIndex === -1) {
    root.items.push(pair);
    return;
  }
  // Keep the file's spacing: when a blank line separated `on` from the next key, put one around the new block too.
  // The parser records a blank line after an empty value (`pull_request:`) on that empty scalar, not on the next key.
  const next = root.items[onIndex + 1];
  const tail = lastLeaf(root.items[onIndex]!.value);
  const gapOnTail = tail !== null && tail.spaceBefore === true;
  const gapOnNext = next !== undefined && isNode(next.key) && next.key.spaceBefore === true;
  if ((gapOnTail || gapOnNext) && isNode(pair.key)) {
    if (!gapOnTail) pair.key.spaceBefore = true;
    if (next !== undefined && isNode(next.key)) next.key.spaceBefore = true;
  }
  root.items.splice(onIndex + 1, 0, pair);
}

/** The last scalar inside a collection, following the last item at each level. */
function lastLeaf(node: unknown): Node | null {
  let cur: unknown = node;
  while (isCollection(cur) && cur.items.length) {
    const last: unknown = cur.items[cur.items.length - 1];
    cur = isPair(last) ? last.value : last;
  }
  return isNode(cur) ? cur : null;
}

export const R03: Rule = {
  meta: ruleById("R03")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, path } = ctx.workflow;
    const defaultBranch = ctx.repository.defaultBranch;
    if (cancels(model.concurrency)) return [];
    const jobsWithOwnCancel = model.jobs.filter((j) => cancels(j.concurrency)).map((j) => j.id);
    if (model.jobs.length > 0 && jobsWithOwnCancel.length === model.jobs.length) return [];
    const branchEvents = model.events.filter((e) => e === "push" || e === "pull_request");

    const estimate = ctx.estimator.estimateWorkflow(model, ctx.history, path);
    const uncovered = estimate.jobs.filter((j) => !jobsWithOwnCancel.includes(j.jobId));
    const minutesPerRun = uncovered.reduce((a, j) => a + j.minutesPerRun * j.entries, 0);
    const centsPerRun = uncovered.reduce((a, j) => a + j.minutesPerRun * j.entries * j.pricePerMinute * 100, 0);
    const centsPerBillableMinute = minutesPerRun > 0 ? centsPerRun / minutesPerRun : 0;

    const overlap = ctx.history ? findOverlaps(ctx.history, path, defaultBranch, minutesPerRun || FALLBACK_RUN_MINUTES) : null;
    const hasRuns = overlap !== null && overlap.branchRuns > 0;
    if (hasRuns && overlap.pairs === 0) return [];
    if (!hasRuns && !branchEvents.length) return [];

    let minutesPerMonth: number, centsPerMonth: number, confidence: number, summary: string;
    if (hasRuns) {
      const scale = 30 / Math.max(1, ctx.history!.days);
      // Superseded wall-clock minutes become billable minutes across the run's jobs.
      const billablePerWallMinute = overlap.medianRunMinutes && minutesPerRun > 0 ? minutesPerRun / overlap.medianRunMinutes : 1;
      minutesPerMonth = Math.round(overlap.supersededMinutes * scale * billablePerWallMinute);
      centsPerMonth = Math.round(minutesPerMonth * centsPerBillableMinute);
      confidence = 0.8;
      summary = `${overlap.pairs} runs were superseded by a newer push on the same branch in ${ctx.history!.days} days (${overlap.supersededMinutes} minutes wasted); cancel in-progress runs off ${defaultBranch}`;
    } else {
      const branchRunsPerMonth = branchEvents.reduce((n, e) => n + (estimate.runsByEvent[e] ?? 0), 0);
      const supersededRuns = branchRunsPerMonth * ASSUMED_SUPERSEDED_SHARE;
      minutesPerMonth = Math.round(supersededRuns * minutesPerRun);
      centsPerMonth = Math.round(supersededRuns * centsPerRun);
      confidence = 0.4;
      summary = `No cancel-in-progress on ${branchEvents.join(" and ")} runs; a newer push on a branch leaves the previous run going`;
    }

    return [
      {
        jobId: null,
        evidence: {
          workflowConcurrencyGroup: model.concurrency?.group ?? null,
          jobsWithOwnConcurrency: jobsWithOwnCancel,
          branchEvents,
          overlappingPairs: overlap?.pairs ?? null,
          supersededMinutes: overlap?.supersededMinutes ?? null,
          branchRunsInWindow: overlap?.branchRuns ?? null,
          windowDays: ctx.history?.days ?? null,
          medianMinutesPerRun: overlap?.medianRunMinutes ?? null,
          branchesWithOverlaps: overlap?.branches.slice(0, MAX_BRANCHES_NAMED) ?? [],
          assumedSupersededShare: hasRuns ? null : ASSUMED_SUPERSEDED_SHARE,
          billableMinutesPerRun: minutesPerRun,
        },
        estimate: { minutesPerMonth, centsPerMonth, confidence },
        summary,
        fix: addConcurrency,
      },
    ];
  },
};
