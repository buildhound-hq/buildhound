import { z } from "zod";

// A job's timeline (2026-10-18, the canvas's Job timeline board): Buildhound's own phases on a machine (queued, picked
// up, the VM started), then GitHub's steps with their status and each step's usual time, and a step's log on demand.
// Every second is accounted for from what the agent and GitHub's webhooks report; a phase the agent does not report
// yet is named in `not_reported`, never guessed.

export const StepStatus = z.enum(["succeeded", "failed", "skipped", "cancelled", "running", "queued"]);
export type StepStatus = z.infer<typeof StepStatus>;

/** One step as GitHub's `workflow_job` webhooks give it, as stored on the job's row. */
export const StoredStep = z.object({
  number: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});
export type StoredStep = z.infer<typeof StoredStep>;

/** GitHub's status and conclusion as the timeline's word for a step. */
export function stepStatus(status: string, conclusion: string | null | undefined): StepStatus {
  if (status === "completed") {
    if (conclusion === "success") return "succeeded";
    if (conclusion === "skipped") return "skipped";
    if (conclusion === "cancelled") return "cancelled";
    return "failed";
  }
  return status === "in_progress" ? "running" : "queued";
}

export const PhaseKey = z.enum(["queued", "picked_up", "vm_started", "cache_restored", "vm_destroyed"]);
export type PhaseKey = z.infer<typeof PhaseKey>;

export const TimelinePhase = z.object({
  key: PhaseKey,
  /** "Queued", "Picked up by Benys-Mac-mini", "VM started". */
  title: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  seconds: z.number().int().nullable(),
  /** What the phase covers, for a tooltip. */
  detail: z.string().optional(),
});
export type TimelinePhase = z.infer<typeof TimelinePhase>;

export const TimelineStep = z.object({
  number: z.number().int(),
  name: z.string(),
  status: StepStatus,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  seconds: z.number().int().nullable(),
  /** The median of this step's time over the same repository, workflow and job's last 10 successful runs; null with fewer than 3. */
  usual_seconds: z.number().int().nullable(),
  /** The step's log excerpt, relative to the API: GET it for the last lines and the full log's URL on GitHub. */
  log_path: z.string(),
});
export type TimelineStep = z.infer<typeof TimelineStep>;

export const JobTimeline = z.object({
  phases: z.array(TimelinePhase),
  steps: z.array(TimelineStep),
  /** Phases the board shows that the Buildhound agent does not report yet (`cache_restored`, `vm_destroyed`). */
  not_reported: z.array(PhaseKey),
});
export type JobTimeline = z.infer<typeof JobTimeline>;

/** GET /v1/accounts/:owner/jobs/:id/steps/:number/log. */
export const StepLogResponse = z.object({
  number: z.number().int(),
  name: z.string().nullable(),
  /** The step's last lines, timestamps cut, as GitHub wrote them (secrets already masked by GitHub). */
  lines: z.array(z.string()),
  /** True when the step wrote more than these lines. */
  truncated: z.boolean(),
  /** The step in the job's full log on GitHub. */
  url: z.string(),
  /** When the excerpt was read from GitHub; it is kept an hour. */
  read_at: z.string(),
});
export type StepLogResponse = z.infer<typeof StepLogResponse>;

const secondsBetween = (a: string | null | undefined, b: string | null | undefined): number | null => {
  if (!a || !b) return null;
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return Number.isFinite(s) ? Math.max(0, s) : null;
};

/** The median of whole seconds; null for none. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Each step's usual time, by name, from earlier successful runs' steps (newest first, at most 10 used): the median of
 * that step's time where it succeeded, once at least 3 runs had it.
 */
export function usualSeconds(history: StoredStep[][], minimum = 3): Map<string, number> {
  const times = new Map<string, number[]>();
  for (const steps of history.slice(0, 10)) {
    for (const s of steps) {
      if (s.status !== "completed" || s.conclusion !== "success") continue;
      const t = secondsBetween(s.started_at, s.completed_at);
      if (t === null) continue;
      times.set(s.name, [...(times.get(s.name) ?? []), t]);
    }
  }
  const out = new Map<string, number>();
  for (const [name, list] of times) if (list.length >= minimum) out.set(name, median(list)!);
  return out;
}

/**
 * The timeline for a job: Buildhound's phases on a machine from the agent's report (`machine` null for a job on
 * GitHub-hosted, which has only its queue), then the steps GitHub's webhooks gave.
 */
export function buildTimeline(
  job: { queued_at: string | null; acquired_at: string | null; started_at: string | null; machine: string | null },
  steps: StoredStep[] | null,
  usual: Map<string, number>,
  logPath: (n: number) => string,
): JobTimeline {
  const phases: TimelinePhase[] = [];
  const pickedAt = job.acquired_at ?? job.started_at;
  if (job.queued_at) phases.push({ key: "queued", title: "Queued", started_at: job.queued_at, completed_at: pickedAt, seconds: secondsBetween(job.queued_at, pickedAt) });
  if (job.machine) {
    if (job.acquired_at) phases.push({ key: "picked_up", title: `Picked up by ${job.machine}`, started_at: job.acquired_at, completed_at: job.acquired_at, seconds: 0 });
    if (job.acquired_at && job.started_at) {
      phases.push({ key: "vm_started", title: "VM started", started_at: job.acquired_at, completed_at: job.started_at, seconds: secondsBetween(job.acquired_at, job.started_at), detail: "A clean copy of the image booted and its runner took the job" });
    }
  }
  const list = (steps ?? []).slice().sort((a, b) => a.number - b.number);
  return {
    phases,
    steps: list.map((s) => ({
      number: s.number,
      name: s.name,
      status: stepStatus(s.status, s.conclusion),
      started_at: s.started_at ?? null,
      completed_at: s.completed_at ?? null,
      seconds: secondsBetween(s.started_at, s.completed_at),
      usual_seconds: usual.get(s.name) ?? null,
      log_path: logPath(s.number),
    })),
    not_reported: job.machine ? ["cache_restored", "vm_destroyed"] : [],
  };
}

/** A log line's timestamp, `2026-10-18T16:07:50.1234567Z <text>`, and its text. */
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/;

/**
 * A step's lines from the job's whole log: those written between the step's start and end (a second's slack either side,
 * since GitHub reports whole seconds), timestamps cut, the last `max`. A line with no timestamp belongs to the one before.
 */
export function stepExcerpt(log: string, startedAt: string | null | undefined, completedAt: string | null | undefined, max = 40): { lines: string[]; truncated: boolean } {
  if (!startedAt) return { lines: [], truncated: false };
  const from = Date.parse(startedAt) - 1000;
  const to = completedAt ? Date.parse(completedAt) + 1000 : Infinity;
  const lines: string[] = [];
  let inside = false;
  for (const raw of log.split(/\r?\n/)) {
    const m = LINE.exec(raw.replace(/^\uFEFF/, ""));
    if (m) {
      const at = Date.parse(m[1]!.replace(/(\.\d{3})\d+Z$/, "$1Z"));
      inside = at >= from && at <= to;
      if (inside) lines.push(m[2]!);
    } else if (inside && raw) {
      lines.push(raw);
    }
  }
  return { lines: lines.slice(-max), truncated: lines.length > max };
}
