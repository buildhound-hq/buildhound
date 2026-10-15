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

/**
 * What a job ran on (SECURITY.md, Provenance): the machine's trust tier and agent version when the job started,
 * and the image (with its published digest) and runner version the agent reported. Null for jobs recorded
 * before 2026-10-15; the image and runner fields fill from agent 0.1.25.
 */
export const JobProvenance = z.object({
  trust: z.enum(["trusted", "burst"]).nullable(),
  agent_version: z.string().nullable(),
  image_id: z.string().nullable(),
  image_sha256: z.string().nullable(),
  runner_version: z.string().nullable(),
});
export type JobProvenance = z.infer<typeof JobProvenance>;

export const JobResponse = z.object({
  role: Role,
  job: JobItem,
  provenance: JobProvenance.nullable().default(null),
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

/** The median wait for a runner of a set of jobs, in whole seconds; null without jobs. */
export const WaitFigure = z.object({ median_seconds: z.number().int().nullable(), jobs: z.number().int() });
export type WaitFigure = z.infer<typeof WaitFigure>;

/**
 * Where the GitHub-hosted figure comes from: `webhooks` (jobs seen live), `backfill` (only the 30 days seeded when
 * the installation was first seen), `mixed` (both), `none` (no jobs).
 */
export const HostedWaitSource = z.enum(["webhooks", "backfill", "mixed", "none"]);
export type HostedWaitSource = z.infer<typeof HostedWaitSource>;

export const HostedWaitFigure = WaitFigure.extend({ source: HostedWaitSource });
export type HostedWaitFigure = z.infer<typeof HostedWaitFigure>;

export const WaitComparison = z.object({ macs: WaitFigure, github: HostedWaitFigure });
export type WaitComparison = z.infer<typeof WaitComparison>;

const noWait = (): WaitComparison => ({ macs: { median_seconds: null, jobs: 0 }, github: { median_seconds: null, jobs: 0, source: "none" } });

/**
 * Queue relief for the month: jobs on the account's machines (queued and start times both known) against macOS
 * and Linux jobs on GitHub-hosted, in total and per OS.
 */
export const OverviewWait = WaitComparison.extend({
  by_os: z.object({ macos: WaitComparison, linux: WaitComparison }).default(() => ({ macos: noWait(), linux: noWait() })),
});
export type OverviewWait = z.infer<typeof OverviewWait>;

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
  wait: OverviewWait.default(() => ({ ...noWait(), by_os: { macos: noWait(), linux: noWait() } })),
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

/** GET /v1/accounts/:owner/repositories: every repository the GitHub App can see that the person can read. */
export const RepositoryItem = z.object({
  full_name: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  /** Jobs it ran on the account's machines in the last 30 days. */
  jobs: z.number().int(),
  last_job_at: z.string().nullable(),
  labels: z.array(z.string()),
  /** routed: its jobs run on the machines; needs_plan: private and held until a plan (ADR-025); not_routed: none yet. */
  state: z.enum(["routed", "needs_plan", "not_routed"]),
});
export type RepositoryItem = z.infer<typeof RepositoryItem>;

export const RepositoriesResponse = z.object({
  role: Role,
  repositories: z.array(RepositoryItem),
  /** The command that routes a repository: it opens the routing pull request (B13.3). */
  route_next: z.string(),
});
export type RepositoriesResponse = z.infer<typeof RepositoriesResponse>;

/** GET and PUT /v1/accounts/:owner/settings: what a newly connected machine starts with. */
export const AccountDefaults = z.object({ performance: z.enum(["quiet", "balanced", "max"]).optional() });
export type AccountDefaults = z.infer<typeof AccountDefaults>;
export const SettingsResponse = z.object({ role: Role, defaults: AccountDefaults });
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** GET /v1/accounts/:owner/plan: the plan as it stands, never per minute (rule 9). */
export const PlanResponse = z.object({
  role: Role,
  /** What the account can buy, by GitHub account type alone (ADR-025). */
  plan: z.enum(["personal", "team"]),
  /** What it has now: a plan while a subscription, or a trial started before 2026-10-15, runs, else none. */
  effective: z.enum(["personal", "team", "enterprise", "none"]),
  /** Set only for a trial started before 2026-10-15; no new trials (ADR-031). The published CLI 0.1.1 reads it. */
  trial_ends_at: z.string().nullable(),
  valid_until: z.string().nullable(),
  machines: z.number().int(),
  /** A machine a month billed monthly; payback and savings use this one. */
  price_per_machine_cents: z.number().int(),
  /** A machine a year billed annually, the default billing period shown. */
  price_per_machine_annual_cents: z.number().int(),
  /** Without a plan, how many machines it may connect for public repositories. */
  free_machine_limit: z.number().int(),
  checkout_next: z.string(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const AuditItem = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  source: z.string(),
  detail: z.record(z.unknown()),
  created_at: z.string(),
});
export type AuditItem = z.infer<typeof AuditItem>;
export const AuditResponse = z.object({ events: z.array(AuditItem), next_before: z.string().nullable() });
export type AuditResponse = z.infer<typeof AuditResponse>;
