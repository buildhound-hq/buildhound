import { z } from "zod";

export const MachineStatus = z.enum(["online", "offline", "paused", "draining", "needs_update"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

// Request and response bodies for docs/CONTROL_PLANE_API.md. Shared by apps/api, apps/cli and apps/mcp.

export const ControlPlaneErrorCode = z.enum([
  "UNAUTHENTICATED",
  "NOT_ADMIN",
  "NEEDS_HUMAN",
  "MACHINE_LIMIT",
  "DISK_NOT_ENCRYPTED",
  // An Actions service call on a scale set, session or runner that is not this machine's (ADR-026).
  "FORBIDDEN",
  // A runner registration refused while a job this machine may not run waits on its scale set (ADR-026).
  "JOB_NOT_ALLOWED",
  // The Actions service refused a brokered call; `upstream_status` is GitHub's status.
  "ACTIONS_SERVICE",
  "REMOVED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "INTERNAL",
  // The public scan (B13.8): no such repository, or not one anyone can read; a private one; GitHub failed.
  "REPO_NOT_FOUND",
  "REPO_PRIVATE",
  "GITHUB_UNAVAILABLE",
]);
export type ControlPlaneErrorCode = z.infer<typeof ControlPlaneErrorCode>;

export const MachineOs = z.enum(["macos", "linux"]);
export const MachineArch = z.enum(["arm64", "x64"]);
export const MachineIsolation = z.enum(["vm", "container"]);
export const FailoverMode = z.enum(["auto", "forced_machine", "forced_hosted"]);
export type FailoverMode = z.infer<typeof FailoverMode>;
export const FailoverReason = z.enum([
  "machine_online",
  "no_machine",
  // A private repository on an account without a subscription (ADR-025, CLAUDE.md rule 9).
  "needs_plan",
  "manual",
  "github_self_hosted_incident",
  // Fallback off (forced_machine, ADR-021) and no machine can take a job now: jobs wait for one.
  "waiting_for_machine",
  // Every machine for the label is busy: jobs wait for a free slot, for OVERFLOW_AFTER_SECONDS at most.
  "machines_busy",
  // Every machine is busy and a job waited too long: new jobs route to GitHub-hosted, and jobs already
  // waiting are re-run there, until a slot frees (B07).
  "overflow",
  // A secret-bearing job waited with no trusted machine free to take it: new jobs route to GitHub-hosted
  // and it is re-run there, until a trusted machine is free (ADR-023).
  "needs_trusted_machine",
  // A machine declined a public repository's job because its run started on an event outside the trusted
  // list, and it waited: new jobs route to GitHub-hosted and it is re-run there, whatever the mode (ADR-028).
  "untrusted_event",
]);
export type FailoverReason = z.infer<typeof FailoverReason>;

/** Quiet, Balanced (the default) or Max: how much of the Mac a job may take (RUNNERS.md, Resource use). */
export const PerformanceMode = z.enum(["quiet", "balanced", "max"]);
export type PerformanceMode = z.infer<typeof PerformanceMode>;

/**
 * A machine's settings. The latest change wins, whether made on the machine (menu bar, local socket)
 * or through the API (CLI, MCP, dashboard); `changed_at` orders them. Agents before 0.1.11 send no
 * `changed_at` and are taken as they report, as before.
 */
export const MachinePolicy = z.object({
  paused: z.boolean().default(false),
  idle_only: z.boolean().default(false),
  plugged_in_only: z.boolean().default(false),
  performance: PerformanceMode.optional(),
  changed_at: z.string().datetime({ offset: true }).optional(),
});
export type MachinePolicy = z.infer<typeof MachinePolicy>;

export const HostState = z.object({
  idle: z.boolean().default(true),
  on_battery: z.boolean().default(false),
  free_disk_gb: z.number().nonnegative().optional(),
  /** Labels the machine cannot run yet, for example while its image downloads. It takes none of their jobs. */
  not_ready: z.array(z.string().max(64)).max(16).optional(),
  /** Full-disk encryption on (FileVault, LUKS); a machine without it cannot be marked trusted. Absent before agent 0.1.16. */
  disk_encrypted: z.boolean().optional(),
  /** What the person at the Mac is doing (agent 0.1.21, B07.5). `idle` already counts a locked screen as idle and a call as not. */
  screen_locked: z.boolean().optional(),
  on_call: z.boolean().optional(),
  /** Low Power Mode on, or a serious or critical thermal state: the machine takes no new jobs. */
  low_power: z.boolean().optional(),
  thermal: z.string().max(16).optional(),
  /** A laptop whose owner has not opted in, on the laptop, to the organisation's pool: it takes no jobs (B07.5). */
  awaiting_pool_consent: z.boolean().optional(),
  /** Why the machine takes no new jobs to stay fast (agent 0.1.26, B06.4): memory_pressure, memory_low, swap_growing, thermal or low_power. */
  strain: z.string().max(32).optional(),
});
export type HostState = z.infer<typeof HostState>;

/** A repository full name, `owner/name`. */
export const RepositoryFullName = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

/** The repositories a machine is set to serve on a personal account (see MachineListItem). */
export const RepositoryFilterView = z.object({ all: z.boolean(), repositories: z.array(z.string()), pending: z.boolean() });
export type RepositoryFilterView = z.infer<typeof RepositoryFilterView>;

export const ScaleSet = z.object({
  label: z.string(),
  name: z.string(),
  runner_group: z.string(),
});
export type ScaleSet = z.infer<typeof ScaleSet>;

export const RegisterMachineRequest = z.object({
  owner: z.string().min(1),
  name: z.string().min(1).max(64),
  os: MachineOs,
  arch: MachineArch,
  cpu_cores: z.number().int().positive().optional(),
  memory_gb: z.number().int().positive().optional(),
  labels: z.array(z.string().regex(/^buildhound-[a-z0-9-]+$/)).min(1),
  capacity: z.number().int().min(1).max(64).default(2),
  isolation: MachineIsolation.default("vm"),
  agent_version: z.string().min(1),
});
export type RegisterMachineRequest = z.infer<typeof RegisterMachineRequest>;

/** Only a trusted machine takes secret-bearing jobs; every machine starts burst, and only a person marks it trusted (ADR-023). */
export const MachineTrust = z.enum(["burst", "trusted"]);
export type MachineTrust = z.infer<typeof MachineTrust>;

/** primary takes jobs; backup only when no primary can; off stays connected and visible but takes none. */
export const MachineRouting = z.enum(["primary", "backup", "off"]);
export type MachineRouting = z.infer<typeof MachineRouting>;

export const MachineSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  labels: z.array(z.string()),
  capacity: z.number().int(),
  status: MachineStatus,
  routing: MachineRouting,
  trust: MachineTrust,
});
export type MachineSummary = z.infer<typeof MachineSummary>;

/** Routing and settings changed through the API; at least one field. */
export const UpdateMachineRequest = z
  .object({
    routing: MachineRouting.optional(),
    paused: z.boolean().optional(),
    idle_only: z.boolean().optional(),
    plugged_in_only: z.boolean().optional(),
    performance: PerformanceMode.optional(),
    /** Only a person may change trust; the CLI asks for an interactive confirmation (ADR-023). */
    trust: MachineTrust.optional(),
    /**
     * Personal accounts: the repositories the machine serves, replacing its list; empty serves every repository the
     * GitHub App covers. `add_repositories` and `remove_repositories` change the list instead. The agent applies it
     * on its next heartbeat (agent 0.1.27 and later).
     */
    repositories: z.array(RepositoryFullName).max(1000).optional(),
    add_repositories: z.array(RepositoryFullName).max(1000).optional(),
    remove_repositories: z.array(RepositoryFullName).max(1000).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "set routing, paused, idle_only, plugged_in_only, performance, trust or repositories" })
  .refine((b) => b.repositories === undefined || (b.add_repositories === undefined && b.remove_repositories === undefined), {
    message: "set repositories, or add_repositories and remove_repositories, not both",
  });
export type UpdateMachineRequest = z.infer<typeof UpdateMachineRequest>;

export const GitHubScope = z.object({
  scope: z.enum(["org", "repo"]),
  owner: z.string(),
  repositories: z.array(z.string()),
});
export type GitHubScope = z.infer<typeof GitHubScope>;

export const RegisterMachineResponse = z.object({
  machine: MachineSummary,
  machine_token: z.string(),
  scale_sets: z.array(ScaleSet),
  github: GitHubScope,
  next: z.string(),
});
export type RegisterMachineResponse = z.infer<typeof RegisterMachineResponse>;

export const FailoverStateView = z.object({
  active_label: z.string().nullable(),
  mode: FailoverMode,
  reason: FailoverReason.nullable(),
  changed_at: z.string().nullable(),
});
export type FailoverStateView = z.infer<typeof FailoverStateView>;

/** One label's slots on a machine: jobs it takes at once, and how many run now. */
export const LabelSlot = z.object({ capacity: z.number().int().min(0).max(64), running: z.number().int().min(0) });
export type LabelSlot = z.infer<typeof LabelSlot>;

export const MachineListItem = MachineSummary.extend({
  os: MachineOs,
  arch: MachineArch,
  last_heartbeat_at: z.string().nullable(),
  running_jobs: z.number().int(),
  image_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  scale_sets: z.array(ScaleSet),
  /** The machine's settings as they stand, latest change wins. */
  policy: MachinePolicy,
  /** Each label's slots from the last heartbeat; empty for agents before 0.1.13. */
  slots: z.record(LabelSlot),
  /** Full-disk encryption from the last heartbeat (agent 0.1.16 and later); null when not reported. A trusted machine needs it. */
  disk_encrypted: z.boolean().nullable(),
  /** Hours a week the machine was free to take a job, from the counts its owner shares; null when not shared (B07.5). */
  free_hours_per_week: z.number().nullable(),
  /** Repositories the machine serves on a personal account, from its last heartbeat; empty for organisations. */
  repositories: z.array(z.string()),
  /**
   * What the machine is set to serve on a personal account: every repository the GitHub App covers (`all`), or only
   * `repositories`. `pending` while a change made through the API waits for the machine's next heartbeat. Null for
   * organisations and for agents before 0.1.27, which do not report it.
   */
  repository_filter: RepositoryFilterView.nullable().optional(),
  /** Why the machine takes no new jobs to stay fast, from its last heartbeat (B06.4); absent when it is not under strain. */
  strain: z.string().optional(),
  failover: z.record(FailoverStateView),
});
export type MachineListItem = z.infer<typeof MachineListItem>;

/**
 * Private repositories held with reason `needs_plan` while the account has no subscription
 * (ADR-025): their jobs route to GitHub-hosted, no job is blocked. `plan` is the one the account type
 * can buy; `next` returns the checkout URL as `needs_human`.
 */
export const NeedsPlanView = z.object({
  plan: z.enum(["personal", "team"]),
  repositories: z.array(z.string()),
  /** The dashboard's billing page, where a person chooses the plan; checkout from the CLI is not built yet (B13.2). */
  url: z.string().optional(),
  next: z.string(),
});
export type NeedsPlanView = z.infer<typeof NeedsPlanView>;

export const ListMachinesResponse = z.object({
  owner: z.string(),
  machines: z.array(MachineListItem),
  failover: z.record(FailoverStateView),
  needs_plan: NeedsPlanView.optional(),
});
export type ListMachinesResponse = z.infer<typeof ListMachinesResponse>;

export const GitHubTokenResponse = z.object({
  token: z.string(),
  expires_at: z.string(),
  scope: z.enum(["org", "repo"]),
  owner: z.string(),
  repositories: z.array(z.string()),
});
export type GitHubTokenResponse = z.infer<typeof GitHubTokenResponse>;

export const HeartbeatRequest = z.object({
  agent_version: z.string().min(1),
  image_id: z.string().nullable().optional(),
  capacity: z.number().int().min(1).max(64).optional(),
  running_jobs: z.number().int().min(0).default(0),
  host: HostState.default({}),
  policy: MachinePolicy.default({}),
  /** Repositories the agent serves, one scale set each, on a personal account. Absent or empty for organisation scope. */
  repositories: z.array(RepositoryFullName).max(1000).optional(),
  /** The `repositories` list in agent.json (agent 0.1.27 and later): empty serves every repository the GitHub App covers. */
  repositories_filter: z.array(RepositoryFullName).max(1000).optional(),
  /** Each label's slots (agent 0.1.13 and later); absent means the machine's capacity is shared by its labels. */
  labels: z.record(LabelSlot).optional(),
  /** With the owner's consent, hourly (B07.5): 168 UTC weekday hours from Sunday 00:00, [awake, plugged in, free] minutes. */
  availability: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)])).length(168).optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** One machine on the account as the menu bar shows it; every agent receives the whole list. */
export const AccountMachine = MachineSummary.extend({
  running_jobs: z.number().int(),
  standby: z.array(z.string()),
});
export type AccountMachine = z.infer<typeof AccountMachine>;

export const HeartbeatResponse = z.object({
  status: z.enum(["online", "paused", "draining", "needs_update"]),
  min_agent_version: z.string(),
  failover: z.record(FailoverStateView),
  removed: z.boolean(),
  /** This machine's routing, and the labels on which it must report zero capacity (CONTROL_PLANE_API.md). */
  routing: MachineRouting,
  standby: z.array(z.string()),
  machines: z.array(AccountMachine),
  /** The machine's settings, latest change wins. The agent applies them when `changed_at` is newer than its own. */
  policy: MachinePolicy.optional(),
  /** The machine's trust tier: a trusted machine's scale sets also carry the trusted labels (ADR-023). */
  trust: MachineTrust.optional(),
  /** An organisation's machine: a laptop among them waits for its owner's opt-in on the laptop (B07.5). */
  pool_consent_required: z.boolean().optional(),
  /**
   * Present while a repository list set through the API waits to be applied: the agent writes it to agent.json
   * and serves those repositories (empty: every repository the GitHub App covers).
   */
  repositories_filter: z.array(z.string()).optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/**
 * A burst machine asks before acquiring a job whether it may take it (ADR-023). The control plane reads
 * the workflow file at the run's commit and classifies the job (`packages/core`, classify-job).
 */
export const ClassifyJobRequest = z.object({
  repository: RepositoryFullName,
  run_id: z.number().int().positive(),
  /** The job's name as GitHub shows it, which is how the scale set message names it. */
  job_name: z.string().min(1).max(512),
});
export type ClassifyJobRequest = z.infer<typeof ClassifyJobRequest>;

export const ClassifyJobResponse = z.object({
  secret_bearing: z.boolean(),
  /**
   * Whether this machine may take the job: never when a public repository's run started on an event outside the
   * trusted list (reason `untrusted_event`), otherwise always for a trusted machine and only one that is not
   * secret-bearing for a burst one.
   */
  allowed: z.boolean(),
  reasons: z.array(z.object({ reason: z.string(), detail: z.string() })),
});
export type ClassifyJobResponse = z.infer<typeof ClassifyJobResponse>;

const ConfigUrl = z
  .string()
  .url()
  .max(300)
  .refine((u) => /^https:\/\/github\.com\/[^/]+(\/[^/]+)?$/.test(u), "an organisation or repository URL on github.com");
const Id = z.number().int().positive();

/** The labels and runner settings the agent asks for; the control plane sets the labels itself (ADR-026). */
const ScaleSetBody = z.object({ name: z.string().min(1).max(200) }).passthrough();

/**
 * POST /v1/machines/:id/actions: one Actions service call, brokered by the control plane so the machine holds
 * no GitHub credential (ADR-026). The operations mirror the scale set client the agent uses.
 */
export const ActionsRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("runner_group.get"), config_url: ConfigUrl, name: z.string().min(1).max(200) }),
  z.object({ op: z.literal("scale_set.get"), config_url: ConfigUrl, runner_group_id: z.number().int().nonnegative(), name: z.string().min(1).max(200) }),
  z.object({ op: z.literal("scale_set.create"), config_url: ConfigUrl, scale_set: ScaleSetBody }),
  z.object({ op: z.literal("scale_set.update"), config_url: ConfigUrl, id: Id, scale_set: ScaleSetBody }),
  z.object({ op: z.literal("scale_set.delete"), config_url: ConfigUrl, id: Id }),
  z.object({ op: z.literal("session.open"), config_url: ConfigUrl, scale_set_id: Id }),
  z.object({ op: z.literal("session.close"), session_id: z.string().uuid() }),
  z.object({ op: z.literal("message.get"), session_id: z.string().uuid(), last_message_id: z.number().int().nonnegative(), capacity: z.number().int().nonnegative().max(64) }),
  z.object({ op: z.literal("message.delete"), session_id: z.string().uuid(), message_id: Id }),
  z.object({ op: z.literal("jobs.acquire"), session_id: z.string().uuid(), request_ids: z.array(Id).max(64) }),
  z.object({ op: z.literal("runner.jit"), config_url: ConfigUrl, scale_set_id: Id, name: z.string().min(1).max(64), work_folder: z.string().max(512) }),
  z.object({ op: z.literal("runner.remove"), config_url: ConfigUrl, runner_id: Id }),
]);
export type ActionsRequest = z.infer<typeof ActionsRequest>;

/** GET /v1/machines/:id/scope: what the machine serves, without a token. */
export const MachineScopeResponse = z.object({
  scope: z.enum(["org", "repo"]),
  owner: z.string(),
  repositories: z.array(z.string()),
});
export type MachineScopeResponse = z.infer<typeof MachineScopeResponse>;

export const JobReportRequest = z.object({
  run_id: z.number().int().positive(),
  /** The scale set protocol's job id, a UUID string; numeric REST job ids are accepted too. */
  job_id: z.union([z.string().min(1).max(64), z.number().int().positive()]).transform((v) => String(v)),
  repository: RepositoryFullName,
  /** The job's name as GitHub shows it (agent 0.1.23 and later). */
  job_name: z.string().min(1).max(512).optional(),
  label: z.string().min(1),
  vm_id: z.string().nullable().optional(),
  event: z.enum(["started", "completed"]),
  queued_at: z.string().datetime({ offset: true }).nullable().optional(),
  started_at: z.string().datetime({ offset: true }).nullable().optional(),
  completed_at: z.string().datetime({ offset: true }).nullable().optional(),
  conclusion: z.string().nullable().optional(),
  /** The image and runner version the job ran on (agent 0.1.25 and later; SECURITY.md, Provenance). */
  image_id: z.string().min(1).max(128).optional(),
  runner_version: z.string().min(1).max(32).optional(),
});
export type JobReportRequest = z.infer<typeof JobReportRequest>;

export const JobReportResponse = z.object({
  id: z.string().uuid(),
  event: z.enum(["started", "completed"]),
  duration_seconds: z.number().int().nullable(),
  hosted_equivalent_cents: z.number().int().nullable(),
});
export type JobReportResponse = z.infer<typeof JobReportResponse>;

export const FailoverSetRequest = z.object({
  owner: z.string().min(1),
  label: z.string().regex(/^buildhound-[a-z0-9-]+$/),
  mode: FailoverMode,
  reason: z.string().max(200).optional(),
});
export type FailoverSetRequest = z.infer<typeof FailoverSetRequest>;

export const FailoverResponse = z.object({
  owner: z.string(),
  failover: z.record(FailoverStateView),
});
export type FailoverResponse = z.infer<typeof FailoverResponse>;

export const SweepResponse = z.object({
  marked_offline: z.number().int(),
  evaluated: z.number().int(),
});
export type SweepResponse = z.infer<typeof SweepResponse>;

/** `buildhound-macos` becomes `BUILDHOUND_MACOS`. */
export function variableNameForLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** The GitHub-hosted label a workflow falls back to for a Buildhound label family. */
export function hostedFallbackForLabel(label: string): "macos-latest" | "ubuntu-latest" {
  return label.startsWith("buildhound-macos") ? "macos-latest" : "ubuntu-latest";
}

/** Scale set name per CONTROL_PLANE_API.md: `<label>-<machine name slug>`. */
export function scaleSetName(label: string, machineName: string): string {
  const slug = machineName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${label}-${slug || "machine"}`;
}
