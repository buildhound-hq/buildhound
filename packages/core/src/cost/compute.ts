import { githubIncludedMinutesDrawn } from "./rates/github";

export interface JobTiming {
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobCost {
  durationSeconds: number;
  rawMinutes: number;
  billableMinutes: number;
  billableCents: number;
}

/**
 * Per-job computation from COST_MODEL.md:
 * duration floored at 0; raw minutes = ceil(seconds / 60), minimum 1 for any started job;
 * billable minutes = round(raw × multiplier), the included minutes the job draws (whole minutes; GitHub draws them at
 * list price, so the multiplier is fractional); cents = round(raw × price × 100).
 * Jobs that never started cost nothing.
 */
export function computeJobCost(timing: JobTiming, pricePerMinute: number, multiplier: number): JobCost {
  if (!timing.startedAt) return { durationSeconds: 0, rawMinutes: 0, billableMinutes: 0, billableCents: 0 };
  const end = timing.completedAt ?? timing.startedAt;
  const durationSeconds = Math.max(0, Math.floor((end.getTime() - timing.startedAt.getTime()) / 1000));
  const rawMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
  return {
    durationSeconds,
    rawMinutes,
    billableMinutes: githubIncludedMinutesDrawn(rawMinutes, { multiplier }),
    billableCents: Math.round(rawMinutes * pricePerMinute * 100),
  };
}
