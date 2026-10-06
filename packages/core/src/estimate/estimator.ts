import { classify, type RateOverrides } from "../cost/classify";
import type { History, NormalisedJob, NormalisedWorkflow } from "../model/types";
import { cronInfo } from "./cron";

export const DEFAULT_RUNS_PER_MONTH = { push: 60, pull_request: 40, workflow_dispatch: 4, other: 10 } as const;
export const DEFAULT_MINUTES_PER_JOB = { linux: 4, windows: 6, macos: 8, unknown: 4 } as const;

export interface JobEstimate {
  jobId: string;
  entries: number;
  runsPerMonth: number;
  minutesPerRun: number;
  pricePerMinute: number;
  provider: string;
  os: string;
  minutesPerMonth: number;
  centsPerMonth: number;
  /** "history" when the figure came from observed runs, "default" otherwise. */
  basis: "history" | "default";
}

export interface WorkflowEstimate {
  runsPerMonth: number;
  runsByEvent: Record<string, number>;
  jobs: JobEstimate[];
  minutesPerMonth: number;
  centsPerMonth: number;
  assumptions: string[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class Estimator {
  constructor(private readonly overrides: RateOverrides = {}, private readonly isPublicRepo = false) {}

  /** Runs per month by event, from history when present, else the defaults in COST_MODEL.md. */
  runsByEvent(model: NormalisedWorkflow, history: History | null, workflowPath: string): { byEvent: Record<string, number>; assumptions: string[] } {
    const byEvent: Record<string, number> = {};
    const assumptions: string[] = [];
    const scale = history ? 30 / Math.max(1, history.days) : 1;
    for (const event of model.events) {
      if (event === "schedule") {
        byEvent.schedule = model.schedules.reduce((n, c) => n + cronInfo(c).runsPerMonth, 0);
        continue;
      }
      const observed = history ? history.runs.filter((r) => r.workflowPath === workflowPath && r.event === event).length : 0;
      if (history && observed > 0) byEvent[event] = Math.round(observed * scale);
      else {
        const d = (DEFAULT_RUNS_PER_MONTH as Record<string, number>)[event] ?? DEFAULT_RUNS_PER_MONTH.other;
        byEvent[event] = d;
        assumptions.push(`${event}: no history, assumed ${d} runs a month`);
      }
    }
    return { byEvent, assumptions };
  }

  /** Median observed minutes for a job name, or the default for its runner class. */
  minutesPerRun(job: NormalisedJob, history: History | null, os: string): { minutes: number; basis: "history" | "default" } {
    const name = job.name ?? job.id;
    const obs = history?.jobs.filter((j) => (j.name === name || j.name.startsWith(name + " (")) && j.startedAt && j.completedAt).map((j) => Math.max(1, Math.ceil((j.completedAt!.getTime() - j.startedAt!.getTime()) / 60_000))) ?? [];
    const m = median(obs);
    if (m !== null) return { minutes: m, basis: "history" };
    return { minutes: (DEFAULT_MINUTES_PER_JOB as Record<string, number>)[os] ?? 4, basis: "default" };
  }

  estimateWorkflow(model: NormalisedWorkflow, history: History | null, workflowPath: string): WorkflowEstimate {
    const { byEvent, assumptions } = this.runsByEvent(model, history, workflowPath);
    let runsPerMonth = Object.values(byEvent).reduce((a, b) => a + b, 0);
    // Double trigger: push and pull_request with overlapping filters count twice (R02 evidence).
    if (model.events.includes("push") && model.events.includes("pull_request") && !model.pushBranches) {
      assumptions.push("push and pull_request both trigger on the same commits; counted as double runs");
    }
    const jobs: JobEstimate[] = [];
    for (const job of model.jobs) {
      if (job.if && /^\s*false\s*$/.test(job.if)) continue;
      const entries = job.matrix?.size ?? 1;
      const labelSets = job.matrix && job.runsOn.length > 1 ? job.runsOn.map((l) => [l]) : [job.runsOn];
      for (const labels of labelSets) {
        const c = classify(labels, this.overrides);
        const price = this.isPublicRepo && c.provider === "github" ? 0 : c.pricePerMinute;
        const { minutes, basis } = this.minutesPerRun(job, history, c.os);
        const entryCount = labelSets.length > 1 ? Math.max(1, Math.round(entries / labelSets.length)) : entries;
        const minutesPerMonth = runsPerMonth * entryCount * minutes;
        jobs.push({ jobId: job.id, entries: entryCount, runsPerMonth, minutesPerRun: minutes, pricePerMinute: price, provider: c.provider, os: c.os, minutesPerMonth, centsPerMonth: Math.round(minutesPerMonth * price * 100), basis });
      }
    }
    if (!model.events.length) runsPerMonth = 0;
    return {
      runsPerMonth,
      runsByEvent: byEvent,
      jobs,
      minutesPerMonth: jobs.reduce((a, j) => a + j.minutesPerMonth, 0),
      centsPerMonth: jobs.reduce((a, j) => a + j.centsPerMonth, 0),
      assumptions,
    };
  }
}
