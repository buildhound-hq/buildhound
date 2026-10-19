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
  "CONTAINER_ISOLATION",
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
  // The public scan (B13.8): no such repository, or not one anyone can read; a private one; an organisation whose
  // token policy refuses the scan's token; GitHub failed.
  "REPO_NOT_FOUND",
  "REPO_PRIVATE",
  "ORG_BLOCKS_TOKEN",
  "GITHUB_UNAVAILABLE",
  // Billing (B13.2, BILLING.md): the plan is the account type's; one subscription at a time; nothing to manage; Paddle not configured.
  "PLAN_MISMATCH",
  "ALREADY_SUBSCRIBED",
  "NO_SUBSCRIPTION",
  "BILLING_UNAVAILABLE",
  // A billing change on a subscription that is past due, paused or set to end (BILLING.md, Switching period).
  "SUBSCRIPTION_NOT_ACTIVE",
  // The routing pull request: the person's GitHub login cannot push to the repository, or it is archived.
  "NO_PUSH_ACCESS",
  "REPO_ARCHIVED",
  // Run workflow and Re-run (DASHBOARD.md, Jobs): the workflow has no `workflow_dispatch`, or GitHub disabled it; the
  // job's run is still in progress, so GitHub would refuse a re-run.
  "NOT_DISPATCHABLE",
  "RUN_IN_PROGRESS",
  "PAYLOAD_TOO_LARGE",
  // Paddle locks a subscription while it renews (billing period switch).
  "RENEWAL_IN_PROGRESS",
  // A repository icon upload that is not a PNG, ICO, SVG, WebP or JPEG up to 256 KB, or an SVG with active content.
  "INVALID_IMAGE",
  // The open dashboard's live socket (CONTROL_PLANE_API.md, Live updates) on a control plane without it: tabs keep polling.
  "LIVE_UNAVAILABLE",
  // Sign-in (ADR-038): not set up on this control plane; an account id that is gone; GitHub refused a token; a GitHub
  // account that already has its own Buildhound account; an address Google has not verified or that is not one; an
  // email code that is wrong, spent or expired, or that could not be sent; a passkey prompt that expired, a passkey
  // that did not verify, or one that is on no account.
  "SIGN_IN_NOT_CONFIGURED",
  "USER_NOT_FOUND",
  "GITHUB_TOKEN_REJECTED",
  "GITHUB_LINKED_ELSEWHERE",
  "EMAIL_NOT_VERIFIED",
  "INVALID_EMAIL",
  "INVALID_CODE",
  "CODE_EXPIRED",
  "EMAIL_NOT_SENT",
  "CHALLENGE_EXPIRED",
  "PASSKEY_REJECTED",
  "PASSKEY_UNKNOWN",
]);
export type ControlPlaneErrorCode = z.infer<typeof ControlPlaneErrorCode>;

export const MachineOs = z.enum(["macos", "linux"]);
export const MachineArch = z.enum(["arm64", "x64"]);
/**
 * How a machine isolates each job: `vm` (a microVM on a Linux host, Apple's framework on a Mac) or `container`
 * (a Sysbox system container on a Linux host without KVM, sharing the host's kernel; RUNNERS.md, Linux hosts).
 */
export const MachineIsolation = z.enum(["vm", "container"]);
export type MachineIsolation = z.infer<typeof MachineIsolation>;

/**
 * Whether a machine may take jobs that use secrets: only a trusted machine whose jobs run in a VM. A container
 * shares the host's kernel, so a container-isolated machine never takes them, whatever its trust tier (CLAUDE.md
 * rule 19; SECURITY.md, Isolation). Every routing decision about secret-bearing jobs and trusted twins asks this.
 */
export const CONTAINER_ISOLATION_WARNING = "Each job runs in a Sysbox system container that shares this machine's kernel, weaker than a microVM, so jobs that use secrets never run here.";

/** Whether a machine may take jobs that use secrets; see above. */
export function takesSecrets(machine: { trust: string; isolation?: string | null }): boolean {
  return machine.trust === "trusted" && machine.isolation !== "container";
}
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
  // Every connected machine for the label holds new jobs back, short on memory, hot, in Low Power Mode or by its
  // owner's rules (on battery, in use): new jobs route to GitHub-hosted until one takes jobs again, and a job that
  // waited 5 minutes is re-run there. With fallback off they wait (waiting_for_machine).
  "machines_held",
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
/** Stay awake between jobs (RUNNERS.md, Resource use): hold off idle sleep never, while on mains power, or always. */
export const StayAwake = z.enum(["never", "plugged_in", "always"]);
export type StayAwake = z.infer<typeof StayAwake>;

/** Adaptive comfort (ADR-035): adapt a running job's VM before refusing new jobs, or today's checks only. */
export const ComfortMode = z.enum(["adaptive", "off"]);
export type ComfortMode = z.infer<typeof ComfortMode>;

export const MachinePolicy = z.object({
  paused: z.boolean().default(false),
  idle_only: z.boolean().default(false),
  plugged_in_only: z.boolean().default(false),
  performance: PerformanceMode.optional(),
  /** Absent from agents that do not report it: the control plane then keeps the value set through the API. */
  stay_awake: StayAwake.optional(),
  /** Absent from agents before adaptive comfort: the control plane then keeps the value set through the API. */
  comfort: ComfortMode.optional(),
  changed_at: z.string().datetime({ offset: true }).optional(),
});
export type MachinePolicy = z.infer<typeof MachinePolicy>;

/**
 * The macOS image build's current step as the agent reports it in its heartbeat (RUNNERS.md, The macOS image build):
 * `state` is running, needs_human (the password step), waiting (paused, for example on battery), ready, failed or
 * blocked; `percent` is the current step's; `total_seconds_left` is the whole build's, -1 when unknown. `command` is
 * the one a person runs for the password step.
 */
export const ImageBuildView = z.object({
  state: z.string().max(16),
  step: z.string().max(32).optional(),
  step_number: z.number().int().min(0).max(32).optional(),
  steps: z.number().int().min(0).max(32).optional(),
  title: z.string().max(120).optional(),
  percent: z.number().int().min(0).max(100).default(0),
  total_seconds_left: z.number().int().min(-1).optional(),
  command: z.string().max(200).optional(),
});
export type ImageBuildView = z.infer<typeof ImageBuildView>;

/**
 * One of the agent's doctor checks (B04.1): `sleep` (stays awake on mains power), `power_restart` (starts after a
 * power failure, desktop Macs), `filevault` (full-disk encryption, FileVault or LUKS, on a Trusted machine only),
 * `disk` (20 GB or more free) and `image` (every label it serves has its image). A check that does not apply to the
 * machine is left out; the dashboard has the words.
 */
export const MachineCheck = z.object({ key: z.string().min(1).max(32), ok: z.boolean() });
export type MachineCheck = z.infer<typeof MachineCheck>;

/**
 * What Buildhound keeps on a machine's disk, in bytes (agents after 0.1.44; RUNNERS.md, Disk space): the images jobs
 * start from now, older images, the macOS image build's cache (Apple's restore image and the macOS install kept for
 * rebuilds) and the package caches. Old images and the build cache count what removing them frees (an APFS clone's
 * shared blocks are not counted twice).
 */
export const BuildhoundBytes = z.object({
  images: z.number().int().min(0),
  old_images: z.number().int().min(0),
  build_cache: z.number().int().min(0),
  package_cache: z.number().int().min(0),
});
export type BuildhoundBytes = z.infer<typeof BuildhoundBytes>;

/** What clearing Buildhound's leftovers frees now, in bytes: old images no job uses, the build cache unless a build runs, package caches over their limits. */
export const ReclaimableBytes = z.object({
  old_images: z.number().int().min(0),
  build_cache: z.number().int().min(0),
  package_cache: z.number().int().min(0),
});
export type ReclaimableBytes = z.infer<typeof ReclaimableBytes>;

/** A cleanup the agent finished, repeated on every heartbeat: the request it answers, when it ended and what it freed. */
export const CleanupReport = z.object({
  requested_at: z.string().max(64),
  finished_at: z.string().max(64),
  bytes_freed: z.number().int().min(0),
  freed: ReclaimableBytes,
});
export type CleanupReport = z.infer<typeof CleanupReport>;

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
  /**
   * Why the machine takes no new jobs to stay fast (agent 0.1.26, B06.4): memory_pressure, swap_growing, thermal or
   * low_power. Agents up to 0.1.36 also send memory_low here, for the whole machine.
   */
  strain: z.string().max(32).optional(),
  /**
   * Labels whose next job VM does not fit in the memory available now with 2 GB left free (agents after 0.1.36, B06.4):
   * only these take no new jobs, so a Mac in use still takes Linux jobs while its macOS guest waits.
   */
  memory_low: z.array(z.string().max(64)).max(16).optional(),
  /**
   * Exclusive jobs (agent 0.1.30, B09): `ready` while the machine would take one once nothing runs on it (a laptop
   * only on AC power with nobody at it; strain does not count from agents after 0.1.31, since it comes from the
   * machine's own jobs and passes with them), `finishing_up` while it takes no other job so a waiting exclusive job
   * can start, `running` while one runs. Absent: it takes none now, or an older agent.
   */
  exclusive: z.enum(["ready", "finishing_up", "running"]).optional(),
  /**
   * The laptop limit new jobs start under now (agents after 0.1.41, RUNNERS.md Laptop limits): `away` (nobody at it,
   * on mains power: planned like a desktop under 70% of RAM), `in_use` (two jobs at most under 40%), `battery` or
   * `quiet` (one job under 40%). Absent on a desktop or from an older agent; an unknown value is dropped, never refused.
   */
  limit: z.enum(["away", "in_use", "battery", "quiet"]).optional().catch(undefined),
  /**
   * How long without input counts as not in use, in seconds (agents after 0.1.41; the agent's IdleThreshold), so the
   * dashboard can say when a machine set to "Only when not in use" takes jobs again. Absent from older agents; a
   * malformed one is dropped, never refused.
   */
  idle_after_seconds: z.number().int().min(1).max(86_400).optional().catch(undefined),
  /** The macOS image build on a Mac (agents after 0.1.29, B06.2); absent when no build has run. A malformed one is dropped, never refused. */
  image_build: ImageBuildView.optional().catch(undefined),
  /**
   * Fleet health (agents after 0.1.43, B04.1): the whole machine's CPU busy and memory in use in percent, the free and
   * total bytes of the volume holding the agent's home, and seconds since boot. Whole-machine numbers only, never
   * processes, users or files. Each is absent when the agent cannot read it; a malformed one is dropped, never refused.
   */
  cpu_percent: z.number().min(0).max(100).optional().catch(undefined),
  memory_percent: z.number().min(0).max(100).optional().catch(undefined),
  disk_free_bytes: z.number().int().min(0).optional().catch(undefined),
  disk_total_bytes: z.number().int().min(0).optional().catch(undefined),
  uptime_seconds: z.number().int().min(0).optional().catch(undefined),
  /** The doctor checks the agent runs every few minutes (MachineCheck), each passing or not; malformed ones are dropped. */
  checks: z.array(MachineCheck).max(16).optional().catch(undefined),
  /** What Buildhound keeps on that volume and what clearing its leftovers frees (agents after 0.1.44); a malformed one is dropped, never refused. */
  buildhound_bytes: BuildhoundBytes.optional().catch(undefined),
  reclaimable_bytes: ReclaimableBytes.optional().catch(undefined),
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
    stay_awake: StayAwake.optional(),
    comfort: ComfortMode.optional(),
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
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "set routing, paused, idle_only, plugged_in_only, performance, stay_awake, comfort, trust or repositories" })
  .refine((b) => b.repositories === undefined || (b.add_repositories === undefined && b.remove_repositories === undefined), {
    message: "set repositories, or add_repositories and remove_repositories, not both",
  });
export type UpdateMachineRequest = z.infer<typeof UpdateMachineRequest>;

export const GitHubScope = z.object({
  scope: z.enum(["org", "repo"]),
  owner: z.string(),
  repositories: z.array(z.string()),
  /** Each covered repository's default branch, keyed by owner/name in lower case: the agent's cache branch scopes (B08). */
  default_branches: z.record(z.string(), z.string()).optional(),
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

/**
 * Fleet health (B04.1): CPU, memory, disk and uptime from the machine's last heartbeat, and the doctor checks' result.
 * GB are 2^30 bytes, to one decimal.
 */
export const MachineHealth = z.object({
  cpu_percent: z.number().min(0).max(100),
  memory_percent: z.number().min(0).max(100),
  disk_free_gb: z.number().min(0),
  disk_total_gb: z.number().min(0).optional(),
  uptime_seconds: z.number().int().min(0),
  /** The agent's doctor checks, each passing or not; the dashboard has the words (lib/dash/fleet-health.ts, CHECKS). */
  checks: z.array(MachineCheck).optional(),
  /** The machine's memory in GB, for "Mac mini, 24 GB". */
  memory_gb: z.number().int().optional(),
});
export type MachineHealth = z.infer<typeof MachineHealth>;

/** What can happen to a machine (B04.1); `hosted` is new jobs for its labels going to GitHub-hosted. */
export const MachineActivityKind = z.enum(["connected", "disconnected", "rebooted", "updated", "paused", "resumed", "hosted"]);
export type MachineActivityKind = z.infer<typeof MachineActivityKind>;

/** One thing that happened to a machine, kept 30 days by the control plane (B04.1). */
export const MachineActivity = z.object({
  at: z.string(),
  kind: MachineActivityKind,
  /** The entry in words: "Updated to 0.1.44", "Paused by BenyD", "New jobs went to GitHub-hosted, no machine was online". */
  text: z.string(),
});
export type MachineActivity = z.infer<typeof MachineActivity>;

/** What Buildhound keeps on a machine and what clearing its leftovers frees, from its last heartbeat (RUNNERS.md, Disk space). */
export const MachineStorage = z.object({ used: BuildhoundBytes, reclaimable: ReclaimableBytes });
export type MachineStorage = z.infer<typeof MachineStorage>;

/**
 * The last time a person asked a machine to clear Buildhound's leftovers: `requested` until its next heartbeat picks
 * the request up and reports back (within 30 seconds when it is online), `done` with what it freed, `expired` when the
 * machine did not pick it up within an hour.
 */
export const MachineCleanup = z.object({
  requested_at: z.string(),
  status: z.enum(["requested", "done", "expired"]),
  finished_at: z.string().nullable(),
  bytes_freed: z.number().int().nullable(),
  freed: ReclaimableBytes.nullable(),
});
export type MachineCleanup = z.infer<typeof MachineCleanup>;

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
  /** `container` for a Sysbox-isolated Linux host, which never takes jobs that use secrets; absent from APIs before 2026-10-17. */
  isolation: MachineIsolation.optional(),
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
  /** Labels that take no new jobs until memory frees up, from its last heartbeat (agents after 0.1.36, B06.4); absent when none. */
  memory_low: z.array(z.string()).optional(),
  /**
   * On battery power, from its last heartbeat (the dashboard's "On battery" or "Plugged in" on a laptop); absent before
   * its first heartbeat and from APIs before 2026-10-18. The heartbeat carries no battery percent.
   */
  on_battery: z.boolean().optional(),
  /** Someone is using the machine, from its last heartbeat (`idle` false: not locked, not idle, or on a call); absent as above. */
  in_use: z.boolean().optional(),
  /** Jobs it takes at once; absent from APIs before 2026-10-19. */
  capacity: z.number().int().optional(),
  /**
   * How long without input counts as not in use, in seconds, from its last heartbeat (agents after 0.1.41): "Only when
   * not in use" takes jobs this long after the person stops. Absent from older agents and APIs before 2026-10-19.
   */
  idle_after_seconds: z.number().int().optional(),
  /**
   * Why it holds new jobs back though connected: `in_use`, `on_battery`, `heat`, `low_power`, `memory` or `strain`
   * (the dashboard's amber pause); absent when it does not, and from APIs before 2026-10-19.
   */
  hold: z.string().optional(),
  /** When the machine was registered; absent from APIs before 2026-10-16. */
  registered_at: z.string().optional(),
  /** Labels it cannot run yet, from its last heartbeat: an image still downloading or not built (B06). */
  not_ready: z.array(z.string()).optional(),
  /** The macOS image build from its last heartbeat (B06.2); absent when none has run or the agent does not report it. */
  image_build: ImageBuildView.optional(),
  failover: z.record(FailoverStateView),
  /** Health from its last heartbeat (agents after 0.1.43, B04.1); absent until a heartbeat carries it, and from older APIs. */
  health: MachineHealth.optional(),
  /** What happened to the machine in the last 30 days, newest first, at most 20 (B04.1); absent from older APIs. */
  activity: z.array(MachineActivity).optional(),
  /** What Buildhound keeps on its disk, from its last heartbeat (agents after 0.1.44); absent from older agents and APIs. */
  storage: MachineStorage.optional(),
  /** The last cleanup asked of it; absent when none was, and from APIs before 2026-10-19. */
  cleanup: MachineCleanup.optional(),
});
export type MachineListItem = z.infer<typeof MachineListItem>;

/**
 * Private repositories held with reason `needs_plan` while the account has no subscription
 * (ADR-025): their jobs route to GitHub-hosted, no job is blocked. `plan` is the one the account type
 * can buy; `next` returns the checkout URL as `needs_human`.
 */
export const NeedsPlanView = z.object({
  plan: z.literal("pro"),
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

/**
 * A job a machine has acquired from its scale set and not started yet (agents after 0.1.32): sent as the `acquired` job
 * report at once and listed in every heartbeat until the runner starts, so the control plane counts it as taken while
 * its VM boots, when GitHub still shows it queued (CONTROL_PLANE_API.md, Failover).
 */
export const AcquiredJob = z.object({
  run_id: z.number().int().positive(),
  /** The scale set protocol's job id, a UUID string. */
  job_id: z.union([z.string().min(1).max(64), z.number().int().positive()]).transform((v) => String(v)),
  repository: RepositoryFullName,
  job_name: z.string().min(1).max(512).optional(),
  label: z.string().min(1),
  queued_at: z.string().datetime({ offset: true }).nullable().optional(),
  acquired_at: z.string().datetime({ offset: true }),
});
export type AcquiredJob = z.infer<typeof AcquiredJob>;

/** One repository's package cache on a machine, as the heartbeat reports it (B08). */
export const CacheRepositoryReport = z.object({
  repository: z.string().min(1).max(200),
  bytes: z.number().int().min(0),
  /** When a job last used it, UTC; absent when never. */
  last_used_at: z.string().max(64).optional(),
  /** A job holds it now: a clear of it waits for that job to end. */
  in_use: z.boolean().default(false),
  /** A clear was asked for while a job held it; it goes when the job ends. */
  clear_pending: z.boolean().optional(),
});
export type CacheRepositoryReport = z.infer<typeof CacheRepositoryReport>;

/** The package caches on a machine as the heartbeat reports them: sizes as of each cache's last sweep. */
export const CachesReport = z.object({
  /** Every repository's caches together, listed or not. */
  bytes: z.number().int().min(0),
  /** The cap over every repository: 20 GiB on a laptop, 50 GiB on a desktop. */
  limit_bytes: z.number().int().min(0).optional(),
  /** The largest repositories first, at most 100. */
  repositories: z.array(CacheRepositoryReport).max(200),
});
export type CachesReport = z.infer<typeof CachesReport>;

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
  /** Jobs acquired and not started yet (agents after 0.1.32), repeated until each starts, so none is lost to a missed report. */
  acquired_jobs: z.array(AcquiredJob).max(64).optional(),
  /**
   * The job ids of every job the machine holds now, running or waiting for a turn (agents after 0.1.40). The control
   * plane closes a job the machine reported started and no longer lists, so a lost `completed` report never leaves a
   * job running on the dashboard. Without it, a heartbeat with `running_jobs` 0 closes every started job.
   */
  running_job_ids: z.array(z.string().min(1).max(64)).max(128).optional(),
  /** The `requested_at` of the last cache clear the agent applied (agents after 0.1.32, B08); the control plane stops asking for it. */
  cache_cleared_at: z.string().max(64).optional(),
  /**
   * What the package caches take (agents after 0.1.34, B08), for `buildhound cache list`. A report that does not
   * parse is dropped, never the heartbeat.
   */
  caches: CachesReport.optional().catch(undefined),
  /** The last cleanup the control plane asked for that the agent finished (agents after 0.1.44); a malformed one is dropped, never the heartbeat. */
  cleanup: CleanupReport.optional().catch(undefined),
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
  /**
   * Exclusive labels with a job queued that this machine is chosen to run (B09): while present the machine takes no
   * other job, lets the running ones finish, then offers its exclusive scale set. Empty or absent: none.
   */
  exclusive_waiting: z.array(z.string()).optional(),
  /**
   * The account's last payment failed and the processor is retrying (BILLING.md, past due): private repositories stay
   * on the machines until `until`, then go to GitHub-hosted. The menu bar app tells the person once, with `url`, the
   * billing page. Absent while the plan is paid or there is none.
   */
  billing_notice: z.object({ status: z.literal("past_due"), until: z.string().nullable(), url: z.string() }).optional(),
  /**
   * A `buildhound cache clear` sent through the control plane (B08), present until the agent reports its
   * `requested_at` back as `cache_cleared_at`: the agent drops the repository's package caches, or every
   * repository's when `repository` is absent. With `reset` (`buildhound cache reset`), the clean slate: every cache,
   * the tool cache and whatever else the machine's cache directory holds; an agent older than it clears every
   * repository instead.
   */
  cache_clear: z.object({ requested_at: z.string(), repository: z.string().optional(), reset: z.boolean().optional() }).optional(),
  /**
   * A person asked the machine to clear Buildhound's leftovers (`buildhound runner cleanup`, the dashboard's Free up
   * space): present until the agent reports a `cleanup` with this `requested_at`, for an hour at most. An agent before
   * it ignores it.
   */
  cleanup: z.object({ requested_at: z.string() }).optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/**
 * `GET /v1/machines/:id/cleanup`: what Buildhound keeps on the machine and what clearing its leftovers frees, from its
 * last heartbeat, and the last cleanup asked of it. Read only.
 */
export interface MachineCleanupResponse {
  machine: { id: string; name: string };
  /** When the machine last checked in; null before its first heartbeat. */
  reported_at: string | null;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  /** Null when its agent does not report it (0.1.44 and older). */
  storage: MachineStorage | null;
  cleanup: MachineCleanup | null;
  next: string;
}

/** `POST /v1/machines/:id/cleanup`: asks the machine to clear Buildhound's leftovers. No body. Idempotent while one is pending. */
export interface RequestCleanupResponse {
  machine: { id: string; name: string };
  /** The machine clears on its next heartbeat, within 30 seconds; a request it does not pick up within an hour expires. */
  status: "requested";
  requested_at: string;
  /** What its last heartbeat said the cleanup frees, in bytes; null when its agent does not report it. */
  reclaimable_bytes: number | null;
  next: string;
}

/** `POST /v1/machines/:id/caches/clear` (B08): one repository's package caches on the machine, or every repository's. */
export const ClearCachesRequest = z.object({ repository: RepositoryFullName.optional() });
export type ClearCachesRequest = z.infer<typeof ClearCachesRequest>;

/** `GET /v1/machines/:id/caches` (B08): what the machine's last heartbeat reported, and a clear still waiting for it. */
export interface MachineCachesResponse {
  machine: { id: string; name: string };
  /** When the machine last reported its caches; null when it never did (an agent before 0.1.35) or not in the last day. */
  reported_at: string | null;
  bytes: number | null;
  limit_bytes: number | null;
  repositories: Array<{ repository: string; bytes: number; last_used_at: string | null; in_use: boolean; clear_pending: boolean }>;
  /**
   * A `buildhound cache clear` or `cache reset` the machine has not applied yet: it does on its next heartbeat, within
   * 30 seconds. `reset` is true for a reset, which takes every repository.
   */
  pending_clear: { requested_at: string; repository: string | null; reset: boolean } | null;
  next: string;
}

/**
 * `GET /v1/machines/:id/jobs/:job_id/steps` (B10): a job that ran on the calling machine and its steps, for the menu
 * bar app's Jobs pane. Names and timings only, never logs. `steps` is null when GitHub could not be read or the job
 * was not found in its run.
 */
export interface MachineJobStepsResponse {
  job: {
    /** The job id the agent reported (`job_id` in `POST /v1/machines/:id/jobs`). */
    id: string;
    repository: string | null;
    run_id: number | null;
    name: string | null;
    status: "running" | "completed";
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    run_url: string | null;
  };
  /** GitHub's order, pending steps (no `started_at`) included. */
  steps: Array<{ number: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }> | null;
  /** The job's page on GitHub when it was found in its run, else the run's page. */
  url: string | null;
}

/** One machine of the account as the menu bar app's Machines pane shows it (B10). */
export interface FleetMachine {
  id: string;
  name: string;
  /** True for the machine that asked. */
  this: boolean;
  routing: MachineRouting;
  status: MachineStatus;
  trust: MachineTrust;
  os: z.infer<typeof MachineOs>;
  arch: z.infer<typeof MachineArch>;
  cpu_cores: number | null;
  memory_gb: number | null;
  isolation: MachineIsolation;
  labels: string[];
  capacity: number;
  running_jobs: number;
  last_heartbeat_at: string | null;
  /** When the machine's latest job finished; null when none has. */
  last_job_at: string | null;
  /** When the oldest job still running on it started; null when none is. */
  running_since: string | null;
}

/** `GET /v1/machines/:id/fleet` (B10): the account's machines, this one first, then by name. Read only. */
export interface MachineFleetResponse {
  owner: string;
  machines: FleetMachine[];
}

export interface ClearCachesResponse {
  machine: { id: string; name: string };
  /** The repository asked for, or null for every repository. */
  repository: string | null;
  /** The agent clears on its next heartbeat, within 30 seconds, and the request is dropped after an hour unanswered. */
  status: "requested";
  requested_at: string;
  next: string;
}

/** `POST /v1/machines/:id/caches/reset` (B08): the clean slate for the machine's caches. No body. */
export interface ResetCachesResponse {
  machine: { id: string; name: string };
  /** The agent resets on its next heartbeat, within 30 seconds, and the request is dropped after an hour unanswered. */
  status: "requested";
  requested_at: string;
  next: string;
}

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
  /** `acquired` (agents after 0.1.32) when the scale set hands the machine the job, before its VM is up. */
  event: z.enum(["acquired", "started", "completed"]),
  queued_at: z.string().datetime({ offset: true }).nullable().optional(),
  acquired_at: z.string().datetime({ offset: true }).nullable().optional(),
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
  event: z.enum(["acquired", "started", "completed"]),
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

/**
 * The GitHub-hosted label a workflow falls back to for a Buildhound label family, which prices the job's hosted
 * equivalent (rule 4): `buildhound-linux` on any machine and `buildhound-linux-x64` both price at `ubuntu-latest`;
 * `buildhound-linux-arm64` prices at `ubuntu-24.04-arm`, GitHub's arm64 Linux runner (decided 2026-10-17).
 */
export function hostedFallbackForLabel(label: string): "macos-latest" | "ubuntu-latest" | "ubuntu-24.04-arm" {
  if (label.startsWith("buildhound-macos")) return "macos-latest";
  return isLinuxArm64Label(label) ? "ubuntu-24.04-arm" : "ubuntu-latest";
}

/** Whether a label is the arm64 Linux family or one of its suffixed forms (`buildhound-linux-arm64-exclusive`). */
export function isLinuxArm64Label(label: string): boolean {
  return /^buildhound-linux-arm64(-|$)/.test(label);
}

/** Whether a label is the x86-64 Linux family or one of its suffixed forms (`buildhound-linux-x64-trusted`). */
export function isLinuxX64Label(label: string): boolean {
  return /^buildhound-linux-x64(-|$)/.test(label);
}

const TRUSTED_SUFFIX = "-trusted";

/** Whether a label is a family's trusted twin, `buildhound-macos-trusted`, which only trusted machines serve (ADR-023). */
export function isTrustedTwin(label: string): boolean {
  return label.startsWith("buildhound-") && label.endsWith(TRUSTED_SUFFIX);
}

/** A family's trusted twin: `buildhound-macos` becomes `buildhound-macos-trusted`, read through `BUILDHOUND_MACOS_TRUSTED`. */
export function trustedTwin(family: string): string {
  return isTrustedTwin(family) ? family : `${family}${TRUSTED_SUFFIX}`;
}

/** The family a label belongs to: a trusted twin's family, or the label itself. */
export function labelFamily(label: string): string {
  return isTrustedTwin(label) ? label.slice(0, -TRUSTED_SUFFIX.length) : label;
}

/**
 * Whether a machine may register a label family (RUNNERS.md, Labels; decided 2026-10-16 and 2026-10-17). `buildhound-linux`
 * is any Linux: every Linux host and every Mac's Linux guests. `buildhound-linux-x64` and its suffixed forms are x86-64
 * Linux hosts only, so a job pinned to x86-64 never lands on an arm64 machine. `buildhound-linux-arm64` and its suffixed
 * forms are arm64 Linux hosts and Macs: a Mac's Linux guests are arm64 (only Apple silicon runs job VMs), whatever
 * architecture the CLI that registered it ran under, so a job pinned to arm64 never lands on an x86-64 host. A trusted
 * twin is never registered: the control plane adds it to a machine's scale sets while a person has the machine marked
 * trusted, and takes it off when they unmark it.
 */
export function labelFitsHost(label: string, host: { os: string; arch: string }): boolean {
  if (isTrustedTwin(label)) return false;
  if (isLinuxX64Label(label)) return host.os === "linux" && host.arch === "x64";
  if (isLinuxArm64Label(label)) return host.os === "macos" || (host.os === "linux" && host.arch === "arm64");
  return true;
}

/** The suffix of an exclusive label family: a job on it runs alone on a machine (RUNNERS.md, Exclusive jobs). */
export const EXCLUSIVE_SUFFIX = "-exclusive";

/** Whether a label is an exclusive family (`buildhound-macos-exclusive`), not its trusted twin or a machine's own name. */
export function isExclusiveLabel(label: string): boolean {
  return /^buildhound-[a-z0-9-]+-exclusive$/.test(label);
}

/**
 * Whether a job's `runs-on` asks for an exclusive scale set: an exclusive family (`buildhound-macos-exclusive`) or one
 * machine's exclusive scale set (`buildhound-macos-exclusive-mini`). Such a job never falls back to GitHub-hosted, so
 * routing leaves it as written (RUNNERS.md, Exclusive jobs).
 */
export function runsExclusive(labels: readonly string[]): boolean {
  return labels.some((l) => /^buildhound-[a-z0-9-]+-exclusive(-[a-z0-9-]+)?$/i.test(l));
}

/**
 * The family a label belongs to, for grouping jobs and savings: `buildhound-macos-exclusive` and
 * `buildhound-macos-trusted` are both `buildhound-macos`.
 */
export function familyLabel(label: string): string {
  return label.replace(/-trusted$/, "").replace(/-exclusive$/, "");
}

/**
 * Each family scale set's exclusive twin (RUNNERS.md, Exclusive jobs, B09): one more scale set per family, named
 * like the family's own with `-exclusive` after the label (`buildhound-macos-mini` becomes
 * `buildhound-macos-exclusive-mini`), so its name pins the machine and its label is the family's exclusive label.
 * Derived, never stored: the agent derives the same names from agent.json (config.ExclusiveTwins).
 */
export function exclusiveScaleSets(sets: readonly ScaleSet[]): ScaleSet[] {
  const names = new Set(sets.map((s) => s.name.toLowerCase()));
  const out: ScaleSet[] = [];
  for (const s of sets) {
    if (isExclusiveLabel(s.label) || /-trusted$/.test(s.label)) continue;
    const prefix = `${s.label}-`;
    const machine = s.name.toLowerCase().startsWith(prefix) ? s.name.slice(prefix.length) : s.name;
    const twin = { label: `${s.label}${EXCLUSIVE_SUFFIX}`, name: `${s.label}${EXCLUSIVE_SUFFIX}-${machine}`, runner_group: s.runner_group };
    if (names.has(twin.name.toLowerCase())) continue;
    names.add(twin.name.toLowerCase());
    out.push(twin);
  }
  return out;
}

/**
 * The `buildhound-linux-arm64` scale set a machine serves without having registered it (RUNNERS.md, Labels): on a Mac
 * or an arm64 Linux host whose stored scale sets include plain `buildhound-linux`, one named like that set with
 * `-arm64` after the label (`buildhound-linux-mini` becomes `buildhound-linux-arm64-mini`), sharing its slots, so
 * machines connected before the family existed (2026-10-17) serve it with the agent update and no new `runner add`.
 * Nothing on an x86-64 Linux host, and nothing when an arm64 scale set is already stored. Derived, never stored: the
 * agent derives the same set from agent.json (config.LinuxArm64ScaleSets).
 */
export function linuxArm64ScaleSets(sets: readonly ScaleSet[], host: { os: string; arch: string }): ScaleSet[] {
  if (!labelFitsHost("buildhound-linux-arm64", host)) return [];
  if (sets.some((s) => isLinuxArm64Label(s.label))) return [];
  const linux = sets.find((s) => s.label === "buildhound-linux");
  if (!linux) return [];
  const prefix = `${linux.label}-`;
  const machine = linux.name.toLowerCase().startsWith(prefix) ? linux.name.slice(prefix.length) : linux.name;
  const name = `buildhound-linux-arm64-${machine}`;
  if (sets.some((s) => s.name.toLowerCase() === name.toLowerCase())) return [];
  return [{ label: "buildhound-linux-arm64", name, runner_group: linux.runner_group }];
}

/** Scale set name per CONTROL_PLANE_API.md: `<label>-<machine name slug>`. */
export function scaleSetName(label: string, machineName: string): string {
  const slug = machineName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${label}-${slug || "machine"}`;
}
