import { z } from "zod";

export const MachineStatus = z.enum(["online", "offline", "paused", "draining", "needs_update"]);
export type MachineStatus = z.infer<typeof MachineStatus>;

// Request and response bodies for docs/CONTROL_PLANE_API.md. Shared by apps/api, apps/cli and apps/mcp.

export const ControlPlaneErrorCode = z.enum([
  "UNAUTHENTICATED",
  "NOT_ADMIN",
  "NEEDS_HUMAN",
  "MACHINE_LIMIT",
  "REMOVED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "INTERNAL",
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
  "needs_team",
  "manual",
  "github_self_hosted_incident",
]);
export type FailoverReason = z.infer<typeof FailoverReason>;

export const MachinePolicy = z.object({
  paused: z.boolean().default(false),
  idle_only: z.boolean().default(false),
  plugged_in_only: z.boolean().default(false),
});
export type MachinePolicy = z.infer<typeof MachinePolicy>;

export const HostState = z.object({
  idle: z.boolean().default(true),
  on_battery: z.boolean().default(false),
  free_disk_gb: z.number().nonnegative().optional(),
});
export type HostState = z.infer<typeof HostState>;

/** A repository full name, `owner/name`. */
export const RepositoryFullName = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

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
});
export type MachineSummary = z.infer<typeof MachineSummary>;

export const UpdateMachineRequest = z.object({ routing: MachineRouting });
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

export const MachineListItem = MachineSummary.extend({
  os: MachineOs,
  arch: MachineArch,
  last_heartbeat_at: z.string().nullable(),
  running_jobs: z.number().int(),
  image_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  scale_sets: z.array(ScaleSet),
  /** Repositories the machine serves on a personal account, from its last heartbeat; empty for organisations. */
  repositories: z.array(z.string()),
  failover: z.record(FailoverStateView),
});
export type MachineListItem = z.infer<typeof MachineListItem>;

export const ListMachinesResponse = z.object({
  owner: z.string(),
  machines: z.array(MachineListItem),
  failover: z.record(FailoverStateView),
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
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const JobReportRequest = z.object({
  run_id: z.number().int().positive(),
  /** The scale set protocol's job id, a UUID string; numeric REST job ids are accepted too. */
  job_id: z.union([z.string().min(1).max(64), z.number().int().positive()]).transform((v) => String(v)),
  repository: RepositoryFullName,
  label: z.string().min(1),
  vm_id: z.string().nullable().optional(),
  event: z.enum(["started", "completed"]),
  queued_at: z.string().datetime({ offset: true }).nullable().optional(),
  started_at: z.string().datetime({ offset: true }).nullable().optional(),
  completed_at: z.string().datetime({ offset: true }).nullable().optional(),
  conclusion: z.string().nullable().optional(),
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
