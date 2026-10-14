import { z } from "zod";

// Read endpoints shared by the dashboard, the CLI and MCP (B03; DASHBOARD.md, Data). Roles come from GitHub
// (SECURITY.md, Roles): an admin sees everything on the account, a member only repositories they can read.

export const Role = z.enum(["admin", "member"]);
export type Role = z.infer<typeof Role>;

/** GET /v1/me: who the token is, and the Buildhound accounts they can open. */
export const MeResponse = z.object({
  login: z.string(),
  accounts: z.array(z.object({ login: z.string(), type: z.string(), role: Role })),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const JobItem = z.object({
  id: z.string(),
  repository: z.string().nullable(),
  run_id: z.number().nullable(),
  job_id: z.string().nullable(),
  /** The job's name as GitHub shows it; null for jobs reported by agents before 0.1.23. */
  name: z.string().nullable(),
  label: z.string(),
  machine: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(["running", "completed"]),
  conclusion: z.string().nullable(),
  queued_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  wait_seconds: z.number().int().nullable(),
  duration_seconds: z.number().int().nullable(),
  /** What the same minutes would have cost on GitHub-hosted (`packages/core/cost`); null while running. */
  hosted_equivalent_cents: z.number().int().nullable(),
  run_url: z.string().nullable(),
});
export type JobItem = z.infer<typeof JobItem>;

/** A job the control plane cancelled and re-ran, and where the re-run went. */
export const RerunItem = z.object({
  repository: z.string(),
  run_id: z.number(),
  job_name: z.string(),
  label: z.string().nullable(),
  reason: z.string(),
  routed_to: z.enum(["machine", "hosted"]),
  rerun_at: z.string(),
  run_url: z.string(),
});
export type RerunItem = z.infer<typeof RerunItem>;

export const JobsResponse = z.object({
  role: Role,
  jobs: z.array(JobItem),
  /** Pass as `before` for the next page; null on the last. */
  next_before: z.string().nullable(),
});
export type JobsResponse = z.infer<typeof JobsResponse>;

export const JobResponse = z.object({
  role: Role,
  job: JobItem,
  /** Re-runs of this job's run, oldest first: why it waited or moved. */
  reruns: z.array(RerunItem),
  calculation: z.string().nullable(),
});
export type JobResponse = z.infer<typeof JobResponse>;

export const AttentionItem = z.object({
  kind: z.enum(["machine_offline", "needs_update", "waiting_for_machine", "needs_plan", "job_waiting"]),
  detail: z.string(),
  next: z.string(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

/** One UTC day of the overview's month: jobs on the account's machines, how they ended, and re-runs on GitHub-hosted. */
export const OverviewDay = z.object({
  date: z.string(),
  jobs: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  hosted_equivalent_cents: z.number().int(),
  fell_back: z.number().int(),
});
export type OverviewDay = z.infer<typeof OverviewDay>;

export const OverviewResponse = z.object({
  role: Role,
  period: z.object({ start: z.string(), end: z.string() }),
  jobs_on_machines: z.number().int(),
  machine_minutes: z.number().int(),
  hosted_equivalent_cents: z.number().int(),
  /** Jobs re-run on GitHub-hosted because no machine could take them. */
  fell_back: z.number().int(),
  /** Jobs that finished with success; with jobs_on_machines, the success rate. */
  succeeded: z.number().int().default(0),
  /** Every day of the month up to today, oldest first. */
  daily: z.array(OverviewDay).default([]),
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      running_jobs: z.number().int(),
      trust: z.string(),
    }),
  ),
  recent_jobs: z.array(JobItem),
  attention: z.array(AttentionItem),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

export const SavingsMonth = z.object({
  month: z.string(),
  jobs: z.number().int(),
  minutes: z.number().int(),
  hosted_equivalent_cents: z.number().int(),
});
export type SavingsMonth = z.infer<typeof SavingsMonth>;

export const SavingsResponse = z.object({
  role: Role,
  months: z.array(SavingsMonth),
  machines: z.array(z.object({ id: z.string(), name: z.string(), months: z.array(SavingsMonth) })),
  /** The same months per family label (buildhound-macos, buildhound-linux), since GitHub prices them apart. */
  labels: z.array(z.object({ label: z.string(), months: z.array(SavingsMonth) })).default([]),
  /** How the numbers are made, shown with them (CLAUDE.md rules 4 and 15). */
  calculation: z.string(),
});
export type SavingsResponse = z.infer<typeof SavingsResponse>;
