import { z } from "zod";

/*
 * Time to first step and the capacity line (THROUGHPUT.md, built 2026-10-19): the shapes every surface reads and
 * the sentences they say, so the dashboard, the CLI and MCP agree word for word.
 */

/**
 * How long jobs took to start, from GitHub's own clock on each job (the scale set protocol's `queueTime`,
 * `scaleSetAssignTime` and `runnerAssignTime`): `github_seconds` is queued to assigned to the machine's scale set,
 * GitHub's part; `machine_seconds` is assigned to the runner in the VM taking the job, the machine's part (the VM's
 * boot and the runner's start, the window ARC's `gha_job_startup_duration_seconds` measures); `total_seconds` is
 * both. On a job each is whole seconds; as a figure each is a median over the jobs counted. Null without the times.
 */
export const TimeToStart = z.object({
  total_seconds: z.number().int().nullable(),
  github_seconds: z.number().int().nullable(),
  machine_seconds: z.number().int().nullable(),
});
export type TimeToStart = z.infer<typeof TimeToStart>;

/** The medians over a set of jobs on the account's machines, with how many jobs they are over. */
export const StartFigure = TimeToStart.extend({ jobs: z.number().int() });
export type StartFigure = z.infer<typeof StartFigure>;
