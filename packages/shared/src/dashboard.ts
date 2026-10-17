import { z } from "zod";
import { SubscriptionView } from "./billing";

// Read endpoints shared by the dashboard, the CLI and MCP (B03; DASHBOARD.md, Data). Roles come from GitHub
// (SECURITY.md, Roles): an admin sees everything on the account, a member only repositories they can read.

export const Role = z.enum(["admin", "member"]);
export type Role = z.infer<typeof Role>;

/** GET /v1/me: who the token is, and the Buildhound accounts they can open. */
export const MeResponse = z.object({
  login: z.string(),
  /**
   * `team_only` is set for a member of an organisation without Team: the account is theirs on GitHub, but members
   * open it only on Team, so the dashboard says so instead of a 404 (PRD.md, Pricing).
   */
  accounts: z.array(z.object({ login: z.string(), type: z.string(), role: Role, team_only: z.boolean().optional() })),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const JobItem = z.object({
  id: z.string(),
  repository: z.string().nullable(),
  run_id: z.number().nullable(),
  job_id: z.string().nullable(),
  /** The job's name as GitHub shows it; null for jobs reported by agents before 0.1.23. */
  name: z.string().nullable(),
  /**
   * The workflow's name ("ci"), so a job reads "ci › typescript". From the run's `workflow_job` webhooks; null
   * until one arrives and for jobs before 2026-10-18, and absent from older API versions.
   */
  workflow_name: z.string().nullable().optional(),
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
  /** `vm` or `container` (a Sysbox container on a Linux host without KVM); null for jobs recorded before 2026-10-17. */
  isolation: z.enum(["vm", "container"]).nullable().default(null),
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

/**
 * GET /v1/accounts/:owner/github-usage: the account's GitHub-hosted jobs over the last 30 days, from its workflow
 * runs on GitHub and priced with `packages/core/cost` (rule 4), for Overview's first day. Members see only
 * repositories they can read.
 */
export const GitHubUsageResponse = z.object({
  role: Role,
  /** The days the figures cover: 30, or fewer when `capped` cut the newest runs short. */
  days: z.number().int(),
  /** True when the run or repository limit left some of the window out. */
  capped: z.boolean(),
  /** Runs read, newest first. */
  runs: z.number().int(),
  computed_at: z.string(),
  /** Jobs that ran on GitHub-hosted runners, and the repositories they ran in. */
  jobs: z.number().int(),
  repositories: z.number().int(),
  /** Minutes rounded up per job, as GitHub meters them; public and private repositories alike. */
  macos_minutes: z.number().int(),
  linux_minutes: z.number().int(),
  /** GitHub's macOS rate over its Linux rate, rounded ("10x the Linux rate"). */
  macos_rate_vs_linux: z.number().int(),
  /** Private repositories only, at GitHub's list rates before any included minutes; public repositories run free. */
  charged_cents: z.number().int(),
  /** Jobs ran only in public repositories: no saving is claimed (ADR-025). */
  public_only: z.boolean(),
  /** Median wait before a GitHub-hosted macOS job started, over 30 days; null below 5 jobs. */
  macos_wait: WaitFigure.extend({ median_seconds: z.number().int() }).nullable(),
  /**
   * The monthly saving on a machine the account already has, on the plan it would buy, against its private macOS
   * and Linux spend; null when public only or no jobs. No hardware is priced (2026-10-15): the dashboard reads
   * `monthly_saving_cents`, zero or below meaning no saving at this spend.
   */
  payback: z
    .object({
      plan: z.enum(["personal", "team"]),
      machine_fee_cents: z.number().int(),
      hosted_cents_per_month: z.number().int(),
      /** GitHub-hosted spend that would move, less the plan's monthly price per machine. */
      monthly_saving_cents: z.number().int(),
      /** Deprecated, not shown: a $899 Mac mini's price, still sent for dashboards deployed before 2026-10-15. */
      hardware_cents: z.number().int().optional(),
      /** Deprecated, not shown: months to pay back `hardware_cents`, null when no saving. Still sent, as above. */
      months: z.number().int().nullable().optional(),
    })
    .nullable(),
  calculation: z.string(),
});
export type GitHubUsageResponse = z.infer<typeof GitHubUsageResponse>;

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
  /**
   * Where a person adds or removes repositories on GitHub: the installation's settings page, or the App's install page
   * when it is not installed. Absent before 2026-10-18.
   */
  access_url: z.string().optional(),
});
export type RepositoriesResponse = z.infer<typeof RepositoriesResponse>;

/**
 * POST /v1/accounts/:owner/repositories/:name/route (admins): the routing pull request for one repository, the same one
 * `buildhound route --apply` opens, built on the control plane from the default branch. Read-only unless `confirm` is
 * true; again with `confirm` it updates the same pull request or answers `unchanged`.
 */
export const RouteRepositoryRequest = z.object({ confirm: z.boolean().optional() });
export type RouteRepositoryRequest = z.infer<typeof RouteRepositoryRequest>;

export const RouteRepositoryResponse = z.object({
  repository: z.string(),
  /** plan: nothing written; applied: the pull request opened or updated and the machines' repository lists changed. */
  mode: z.enum(["plan", "applied"]),
  /** Null when nothing would change: every job already routed, or none a connected machine can run. */
  pull_request: z
    .object({
      branch: z.string(),
      title: z.string(),
      status: z.enum(["planned", "created", "updated", "unchanged", "skipped"]),
      url: z.string().nullable(),
      number: z.number().int().nullable(),
      note: z.string().optional(),
      files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
      diff: z.string(),
    })
    .nullable(),
  /** Jobs the pull request routes; `trusted` for one that can reach secrets, which only Trusted machines run (rule 19). */
  routed: z.array(z.object({ workflow: z.string(), job: z.string(), from: z.string(), variable: z.string(), trusted: z.boolean() })),
  not_routed: z.array(z.object({ workflow: z.string(), job: z.string(), label: z.string().nullable(), reason: z.string() })),
  /** Jobs already on a routing expression. */
  already_routed: z.number().int(),
  /** Personal accounts: the machines whose repository list gains this repository (`added` once written). */
  machines: z.array(z.object({ id: z.string(), name: z.string(), added: z.boolean() })),
  assumptions: z.array(z.string()),
  next: z.string(),
});
export type RouteRepositoryResponse = z.infer<typeof RouteRepositoryResponse>;

/** Where to read how to make a workflow startable by hand (`on: workflow_dispatch`). */
export const DISPATCH_DOCS_URL = "https://buildhound.sh/docs/workflows#by-hand";

/** One input of a workflow started by hand, as `on.workflow_dispatch.inputs` declares it (`packages/core`, dispatch.ts). */
export const DispatchInputItem = z.object({
  name: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  type: z.enum(["string", "boolean", "choice", "number", "environment"]),
  default: z.string().nullable(),
  options: z.array(z.string()),
});
export type DispatchInputItem = z.infer<typeof DispatchInputItem>;

export const DispatchableWorkflow = z.object({ id: z.number().int(), name: z.string(), path: z.string(), inputs: z.array(DispatchInputItem) });
export type DispatchableWorkflow = z.infer<typeof DispatchableWorkflow>;

/**
 * GET /v1/accounts/:owner/workflows?repository=owner/name: the workflows a person can start by hand in one repository,
 * read through the GitHub App on the default branch. Workflows without `workflow_dispatch`, or that GitHub has
 * disabled, are listed under not_dispatchable so the dialog can say why the list is short.
 */
export const WorkflowsResponse = z.object({
  role: Role,
  repository: z.string(),
  default_branch: z.string(),
  /** Up to 100 branch names, the default branch first. */
  branches: z.array(z.string()),
  workflows: z.array(DispatchableWorkflow),
  not_dispatchable: z.array(z.object({ name: z.string(), path: z.string(), reason: z.enum(["no_workflow_dispatch", "disabled", "unreadable"]) })),
  /** Whether this person may start them: admins only (SECURITY.md, Roles). */
  can_run: z.boolean(),
  docs_url: z.string(),
  next: z.string(),
});
export type WorkflowsResponse = z.infer<typeof WorkflowsResponse>;

/** POST /v1/accounts/:owner/workflows/dispatch. `workflow` is the id, the file name or its path; `ref` defaults to the default branch. */
export const DispatchRequest = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workflow: z.union([z.number().int().positive(), z.string().min(1).max(255)]),
  ref: z.string().min(1).max(255).optional(),
  inputs: z.record(z.string(), z.string().max(65_535)).optional(),
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;

export const DispatchResponse = z.object({
  /** already_dispatched: the same request within a minute, answered without starting a second run. */
  status: z.enum(["dispatched", "already_dispatched"]),
  repository: z.string(),
  workflow: z.object({ id: z.number().int(), name: z.string(), path: z.string() }),
  ref: z.string(),
  inputs: z.record(z.string(), z.string()),
  dispatched_at: z.string(),
  /** The workflow's runs on GitHub, where the new run appears first. */
  runs_url: z.string(),
  next: z.string(),
});
export type DispatchResponse = z.infer<typeof DispatchResponse>;

/** POST /v1/accounts/:owner/jobs/:id/rerun. `failed: true` re-runs every failed or cancelled job of the run instead of this one. */
export const RerunRequest = z.object({ failed: z.boolean().optional() });
export type RerunRequest = z.infer<typeof RerunRequest>;

export const RerunResponse = z.object({
  status: z.literal("requested"),
  scope: z.enum(["job", "failed_jobs"]),
  repository: z.string(),
  run_id: z.number().int(),
  job: z.object({ id: z.string(), name: z.string().nullable() }),
  run_url: z.string(),
  next: z.string(),
});
export type RerunResponse = z.infer<typeof RerunResponse>;

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
  /** Connected machines, not removed. The published CLI 0.1.1 reads it; the bill reads `billable_machines`. */
  machines: z.number().int(),
  /**
   * The invoice quantity so far this period (ADR-033): machines that ran at least one job each UTC day,
   * averaged over the period's days up to today, to 2 decimals. An idle machine counts for nothing that day.
   * Absent from servers before 2026-10-15.
   */
  billable_machines: z.number().nonnegative().optional(),
  /** Machines that started a job today, UTC. */
  active_machines_today: z.number().int().nonnegative().optional(),
  /**
   * The days the bill counts so far (ADR-033): machines that ran at least one job, summed over the period's UTC days
   * up to today, the same machine-days the renewal's settlement reads. `billable_machines` is this over `days_elapsed`.
   * Absent from servers before 2026-10-16.
   */
  machine_days: z.number().int().nonnegative().optional(),
  /** The period's UTC days so far, today included. */
  days_elapsed: z.number().int().nonnegative().optional(),
  /** `machine_days` by machine, most first, removed machines included. */
  machine_days_by_machine: z.array(z.object({ id: z.string(), name: z.string(), days: z.number().int().nonnegative() })).optional(),
  /** The billing period, `start` inclusive and `end` exclusive (ISO, UTC midnights): the calendar month until Paddle periods exist. */
  period: z.object({ start: z.string(), end: z.string() }).optional(),
  /**
   * An estimate, not an invoice: `billable_machines` times the monthly price, in integer cents, before tax.
   * Null without a per-machine subscription (Free, or Enterprise, which is quoted).
   */
  estimated_cents: z.number().int().nullable().optional(),
  /** A machine a month billed monthly; every savings figure uses this one. */
  price_per_machine_cents: z.number().int(),
  /** A machine a year billed annually, the default billing period shown. */
  price_per_machine_annual_cents: z.number().int(),
  /** Without a plan, how many machines it may connect for public repositories. */
  free_machine_limit: z.number().int(),
  /** What to do without a plan: a person chooses one on the dashboard's billing page (`checkout_url`). */
  checkout_next: z.string(),
  checkout_url: z.string().optional(),
  /** The Paddle subscription behind a paid plan (B13.2): absent without one. */
  subscription: SubscriptionView.optional(),
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

/**
 * Why routing changed or a job moved, in one set of words for every surface (docs/BRAND.md, Glossary): the
 * dashboard's Fleet and Job pages and the CLI say the same thing for the same reason code. Codes stay as stored.
 */
export const REASON_TEXT: Record<string, string> = {
  machine_online: "Your machines can take jobs",
  no_machine: "No machine was online",
  needs_plan: "Needs a plan",
  manual: "Set by hand",
  github_self_hosted_incident: "GitHub runner incident",
  waiting_for_machine: "Jobs wait for your machines",
  machines_busy: "Your machines are busy, new jobs wait for a free one",
  overflow: "Your machines were busy",
  needs_trusted_machine: "No Trusted machine was free",
  untrusted_event: "Started from a fork or by someone outside the repository",
  stuck: "It waited too long for your machines",
  host_vanished: "Its machine stopped responding mid-job",
  host_stopped: "Its machine stopped mid-job",
};

/** A reason code as people read it; an unknown code shows as it is rather than as nothing. */
export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}
