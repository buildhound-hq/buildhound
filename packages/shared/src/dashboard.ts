import { z } from "zod";
import { CapacityLine } from "./capacity";
import { StartFigure, TimeToStart } from "./throughput";
import { AuditChange, AuditGroup } from "./audit";
import { SubscriptionView } from "./billing";
import { CancelReason, HostedReason, TrustBanner, WaitCause, WaitGroup } from "./why-hosted";
import { JobTimeline } from "./timeline";

// Read endpoints shared by the dashboard, the CLI and MCP (B03; DASHBOARD.md, Data). Roles come from GitHub
// (SECURITY.md, Roles): an admin sees everything on the account, a member only repositories they can read.

export const Role = z.enum(["admin", "member"]);
export type Role = z.infer<typeof Role>;

/**
 * GET /v1/me/connections (Profile, Connections; the canvas's S-Connections board): the sign-in, which is the person, and
 * the GitHub App's installations, which are their accounts. `status` is `needs_reconnecting` when GitHub no longer
 * accepts the token (expired or revoked on GitHub); `reconnect_url` signs in again.
 */
export const ConnectionsResponse = z.object({
  github: z.object({
    status: z.enum(["connected", "needs_reconnecting"]),
    login: z.string().nullable(),
    avatar_url: z.string().nullable(),
    /** Buildhound's access on GitHub's own settings, where a person can also revoke it. */
    manage_url: z.string(),
    reconnect_url: z.string(),
  }),
  installations: z.array(
    z.object({
      id: z.number().int(),
      account: z.object({ login: z.string(), type: z.enum(["User", "Organization"]), avatar_url: z.string().nullable() }),
      repository_selection: z.enum(["all", "selected"]),
      /** For `selected`, how many repositories the person can see through it; null for `all` or when GitHub would not say. */
      repositories: z.number().int().nullable(),
      /** Configure on GitHub. */
      settings_url: z.string(),
      /** Whether Buildhound has this account (it opens in the dashboard). */
      known: z.boolean(),
    }),
  ),
  /** Add account: installs the GitHub App on another account. */
  install_url: z.string(),
  /** True when GitHub would not list installations for this token (one not issued to the App). */
  installations_unavailable: z.boolean().optional(),
});
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

/** POST /v1/me/github/disconnect: the sign-in is revoked on GitHub; everything in `kept` stays as it is. */
export const DisconnectResponse = z.object({
  status: z.enum(["disconnected", "already_disconnected"]),
  login: z.string().nullable(),
  sign_in_url: z.string(),
  kept: z.array(z.string()),
  next: z.string(),
});
export type DisconnectResponse = z.infer<typeof DisconnectResponse>;

/** GET /v1/me: who the token is, and the Buildhound accounts they can open. */
export const MeResponse = z.object({
  login: z.string(),
  /** The public email on the person's GitHub profile, null when they set none; the support form replies there. */
  email: z.string().nullable().optional(),
  accounts: z.array(z.object({ login: z.string(), type: z.string(), role: Role })),
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * Where a repository's icon comes from (DASHBOARD.md, Repository icons): an image an admin uploaded, the favicon of its
 * GitHub homepage, or its owner's picture, in that order unless an admin picked one.
 */
export const RepoIconSource = z.enum(["custom", "homepage", "owner"]);
export type RepoIconSource = z.infer<typeof RepoIconSource>;

/**
 * The repository's icon on a job or repository: `icon_url` is an image on the control plane's own origin, or the owner's
 * GitHub picture. Absent from servers before 2026-10-18, and null for a job without a repository.
 */
const RepoIconFields = {
  icon_url: z.string().nullable().optional(),
  icon_source: RepoIconSource.nullable().optional(),
};

export const JobItem = z.object({
  id: z.string(),
  repository: z.string().nullable(),
  run_id: z.number().nullable(),
  job_id: z.string().nullable(),
  /** The job's name as GitHub shows it; null for jobs reported by agents before 0.1.23. */
  name: z.string().nullable(),
  /**
   * The workflow's name ("ci"), which the dashboard groups jobs under. From the run's `workflow_job` webhooks; null
   * until one arrives and for jobs before 2026-10-18, and absent from older API versions.
   */
  workflow_name: z.string().nullable().optional(),
  /**
   * The run's title as GitHub shows it: the head commit's first line, or the title of the pull request or manual
   * run. From the run's `workflow_run` webhooks; null until one arrives and for jobs before 2026-10-18, and absent
   * from older API versions.
   */
  display_title: z.string().nullable().optional(),
  /** The run's branch, from its webhooks; null until one arrives and for jobs before 2026-10-18, and absent from older API versions. */
  head_branch: z.string().nullable().optional(),
  label: z.string(),
  /** `os` (`macos` or `linux`) is absent from APIs before 2026-10-18 and for a machine since deleted. */
  machine: z.object({ id: z.string(), name: z.string(), os: z.enum(["macos", "linux"]).optional() }),
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
  ...RepoIconFields,
  /**
   * Where the job ran (2026-10-18): `machine`, or `github_hosted` for a job of one of the account's repositories that ran
   * there. Such a job's `machine` is `{ id: "github-hosted", name: "GitHub-hosted", os }` and its `id` is
   * `gh-<GitHub job id>`. Absent from older servers, which list only jobs on machines.
   */
  ran_on: z.enum(["machine", "github_hosted"]).optional(),
  /**
   * Why a job meant for the account's machines (its workflow reads a Buildhound variable) ran on GitHub-hosted, in the
   * words of the one table (why-hosted.ts). Null for a job on a machine and for a job never meant for machines.
   */
  hosted_reason: HostedReason.nullable().optional(),
  /**
   * Why a job that ended `cancelled` was cancelled (2026-10-18): Buildhound's own re-run, then what GitHub's annotations
   * said (a newer run in the same concurrency group, a person, the time limit), else "Cancelled on GitHub". Null for any
   * other job.
   */
  cancel_reason: CancelReason.nullable().optional(),
  /**
   * How long the job took to start by GitHub's own clock (2026-10-19; `TimeToStart`): GitHub's queue, then the
   * machine's VM boot and runner start, then both. Null for a job on GitHub-hosted and for one whose scale set
   * messages the control plane did not see; absent from older servers.
   */
  time_to_start: TimeToStart.nullable().optional(),
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

/**
 * A job GitHub queued for the account's machines that none has taken yet (DASHBOARD.md, Jobs): listed above the jobs
 * on the first page as "Waiting for a machine", with why in one sentence.
 */
export const WaitingJob = z.object({
  id: z.string(),
  run_id: z.string(),
  repository: z.string(),
  name: z.string().nullable(),
  label: z.string(),
  queued_at: z.string(),
  reason: z.string(),
});
export type WaitingJob = z.infer<typeof WaitingJob>;

export const JobsResponse = z.object({
  role: Role,
  jobs: z.array(JobItem),
  /** Jobs waiting for a machine, oldest first, on the first page without a machine or result filter; absent before 2026-10-19. */
  waiting: z.array(WaitingJob).optional(),
  /** Pass as `before` for the next page; null on the last. */
  next_before: z.string().nullable(),
  /** Pass as `after` for the previous page; null on the first. Absent from servers before 2026-10-18. */
  prev_after: z.string().nullable().optional(),
  /** Jobs the filters match on every page, so a page reads "1 to 50 of 1,284". Absent from servers before 2026-10-18. */
  total: z.number().int().optional(),
  /** Jobs listed before this page's first, newest first: the page starts at `offset + 1`. Absent from servers before 2026-10-18. */
  offset: z.number().int().optional(),
  /**
   * With `facets=1` (2026-10-18, the Filter menu): counts per value of each filter, each counted with the other filters
   * applied and its own left out. `machine` is keyed by machine name (and `GitHub-hosted`), `repository` by `owner/name`,
   * `workflow` by name ("" for jobs whose workflow is not known).
   */
  facets: z
    .object({
      status: z.record(z.number().int()),
      ran_on: z.record(z.number().int()),
      machine: z.record(z.number().int()),
      repository: z.record(z.number().int()),
      workflow: z.record(z.number().int()),
      os: z.record(z.number().int()),
    })
    .optional(),
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
  /** Buildhound's phases and GitHub's steps with their usual times (Job timeline board, 2026-10-18); absent from older servers. */
  timeline: JobTimeline.optional(),
});
export type JobResponse = z.infer<typeof JobResponse>;

export const AttentionItem = z.object({
  kind: z.enum(["machine_offline", "needs_update", "waiting_for_machine", "needs_plan", "job_waiting", "capacity_short"]),
  detail: z.string(),
  next: z.string(),
  /**
   * Why, in one short sentence for the sidebar's status card ("Benys-Mac-mini is full."); job_waiting only, absent before
   * 2026-10-19. On `waiting_for_machine` (2026-10-19) what happens and what to do, from the shared wait words.
   */
  why: z.string().optional(),
  /**
   * `waiting_for_machine` only (2026-10-19): the label families whose jobs wait, trusted twins folded in, and why
   * (`waitGroups` in why-hosted.ts). `detail` is then the headline, no longer `<label>: ...`. Absent from older servers.
   */
  labels: z.array(z.string()).optional(),
  cause: WaitCause.optional(),
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

const noStart = (): StartFigure => ({ total_seconds: null, github_seconds: null, machine_seconds: null, jobs: 0 });
const noStartComparison = () => ({ macs: noStart(), github: { median_seconds: null, jobs: 0, source: "none" as const } });

export const StartComparison = z.object({ macs: StartFigure, github: HostedWaitFigure });
export type StartComparison = z.infer<typeof StartComparison>;

export const OverviewStart = StartComparison.extend({
  by_os: z.object({ macos: StartComparison, linux: StartComparison }).default(() => ({ macos: noStartComparison(), linux: noStartComparison() })),
});
export type OverviewStart = z.infer<typeof OverviewStart>;

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
  /**
   * Time to first step for the month (2026-10-19; THROUGHPUT.md): `macs` is the median over jobs on the account's
   * machines by GitHub's own clock, split into GitHub's part and the machine's; `github` is the account's
   * GitHub-hosted median from `hosted_waits`, as in `wait`. Per OS as well. Absent from older servers.
   */
  time_to_start: OverviewStart.optional(),
  /** The capacity line per label over the last 7 days (2026-10-19), labels in order; absent from older servers. */
  capacity: z.array(CapacityLine).optional(),
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      running_jobs: z.number().int(),
      trust: z.string(),
      /** For the sidebar's machine glyph; older servers leave it out and the name decides. */
      os: z.string().optional(),
      /** Jobs it takes at once, for "2 of 2"; absent before 2026-10-19. */
      capacity: z.number().int().optional(),
      /** Why it holds new jobs back though connected (MachineHold); absent when it does not. */
      hold: z.string().optional(),
      /** The label families it serves, trusted twins folded in, to tell busy from offline per label; absent before 2026-10-19. */
      labels: z.array(z.string()).optional(),
      /** Its routing (primary, backup, off), so the bulk bar's Routing menu can tick the value every selected machine shares; absent before 2026-10-19. */
      routing: z.string().optional(),
      /** When it was last heard from, for "Offline 23 min" in the sidebar's tree; absent before 2026-10-19. */
      last_heartbeat_at: z.string().nullable().optional(),
      /**
       * Each slot now, for the sidebar's machine tree (B04.1): running jobs first, with the job, its repository, when it
       * started, its workflow and branch; then free slots, with why the machine holds new jobs back (MachineHold) or
       * null. A job in a repository the viewer cannot see shows as a busy slot with `reason: "private"` and nothing
       * else. Absent before 2026-10-19.
       */
      slots_now: z
        .array(
          z.object({
            os: z.string(),
            job: z.string().nullable(),
            repository: z.string().nullable(),
            reason: z.string().nullable(),
            started_at: z.string().nullable().optional(),
            workflow: z.string().nullable().optional(),
            branch: z.string().nullable().optional(),
          }),
        )
        .optional(),
    }),
  ),
  recent_jobs: z.array(JobItem),
  /** What needs a person. Waiting with Fall back to GitHub-hosted off is here only when it needs one (`waits`, `act`). */
  attention: z.array(AttentionItem),
  /**
   * Every family whose jobs wait with Fall back to GitHub-hosted off, merged by cause (2026-10-19): status while a
   * serving machine is online (`act` false, the sidebar's amber line), and the same items as `attention` when `act`.
   * Absent from older servers.
   */
  waits: z.array(WaitGroup).optional(),
  /** The trust banner (D-TrustOnboard, panel 2), the same object as on GET /routing; absent from older servers. */
  trust_banner: TrustBanner.optional(),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

export const SavingsMonth = z.object({
  month: z.string(),
  jobs: z.number().int(),
  minutes: z.number().int(),
  hosted_equivalent_cents: z.number().int(),
  /**
   * UTC days in the month on which the machine started at least one job, summed over machines on the account's
   * months (ADR-033): what the plan's price is spread over, `machineDaysCents` in `packages/core`. Absent on labels,
   * and from servers before 2026-10-18.
   */
  machine_days: z.number().int().nonnegative().optional(),
});
export type SavingsMonth = z.infer<typeof SavingsMonth>;

export const SavingsResponse = z.object({
  role: Role,
  months: z.array(SavingsMonth),
  /** Every machine with a job or a machine day in the months, removed ones included (`removed`, named "removed machine"). */
  machines: z.array(z.object({ id: z.string(), name: z.string(), removed: z.boolean().default(false), months: z.array(SavingsMonth) })),
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
      plan: z.literal("pro"),
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
  /** The last push to it, from GitHub's listing. Absent before 2026-10-18. */
  pushed_at: z.string().nullable().optional(),
  /** GitHub's main language for it. Absent before 2026-10-18. */
  language: z.string().nullable().optional(),
  /**
   * Only with `?hosted=`: its jobs on GitHub-hosted runners in the window `hosted_window` describes, from the same
   * read as `/github-usage`; null when it was not among the repositories read or ran no job there.
   */
  hosted: z.object({ jobs: z.number().int(), macos_minutes: z.number().int(), linux_minutes: z.number().int() }).nullable().optional(),
  /** Jobs on the account's machines in the last 30 days per family label (`labels`), for the Runs badges' tips. Absent before 2026-10-18. */
  label_jobs: z.record(z.string(), z.number().int()).optional(),
  ...RepoIconFields,
});
export type RepositoryItem = z.infer<typeof RepositoryItem>;

/** Whether the homepage's favicon was found: `no_homepage` when the repository has none on GitHub, `pending` before the first read. */
export const FaviconState = z.enum(["found", "none", "blocked", "error", "no_homepage", "pending"]);
export type FaviconState = z.infer<typeof FaviconState>;

/**
 * GET, PUT and DELETE /v1/accounts/:owner/repositories/:name/icon: the icon shown, what an admin picked (`choice`, null
 * for the order: upload, homepage, owner) and each choice's own image, for the dashboard's Change icon dialog.
 */
export const RepositoryIconResponse = z.object({
  role: Role,
  repository: z.string(),
  icon_url: z.string(),
  icon_source: RepoIconSource,
  choice: RepoIconSource.nullable(),
  /** The homepage on GitHub, as last read; null when it has none. */
  homepage: z.string().nullable(),
  /**
   * The homepage's favicon. `queued` (2026-10-18): the homepage was never read (or the repository is not listed yet) and
   * the next icon run, at most 5 minutes away, reads it ahead of others; the GET that answers queues it.
   */
  favicon: z.object({ state: FaviconState, url: z.string().nullable(), checked_at: z.string().nullable(), queued: z.boolean().optional() }),
  owner_url: z.string(),
  /** The uploaded image, while `choice` is custom. */
  custom_url: z.string().nullable(),
  /** On a PUT or DELETE: whether anything changed. A repeat changes nothing and records nothing in the audit log. */
  changed: z.boolean().optional(),
  next: z.string(),
});
export type RepositoryIconResponse = z.infer<typeof RepositoryIconResponse>;

/** Image types an icon may be, checked against the bytes themselves. */
export const ICON_CONTENT_TYPES = ["image/png", "image/x-icon", "image/svg+xml", "image/webp", "image/jpeg"] as const;
/** The largest icon image, decoded: 256 KB. */
export const ICON_MAX_BYTES = 262_144;

/**
 * PUT /v1/accounts/:owner/repositories/:name/icon (admins): `homepage` or `owner` picks that image and drops an upload;
 * `custom` stores `image`, base64 of a PNG, ICO, SVG, WebP or JPEG up to 256 KB.
 */
export const SetRepositoryIconRequest = z.object({
  source: RepoIconSource,
  image: z.object({ content_type: z.string().optional(), data_base64: z.string().max(400_000) }).optional(),
});
export type SetRepositoryIconRequest = z.infer<typeof SetRepositoryIconRequest>;

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
  /**
   * What the installation covers on GitHub: every repository of the account, or the ones a person selected. Read from
   * GitHub on each call, so a change made there shows at once. Absent before 2026-10-18 or when GitHub did not answer.
   */
  repository_selection: z.enum(["all", "selected"]).optional(),
  /**
   * Only with `?hosted=`: the window behind each repository's `hosted`. `read` is how many of the most recently pushed
   * repositories were read (at most 30), `capped` when more were pushed in the window than were read. Null when
   * `?hosted=cached` found nothing kept yet, or GitHub could not be read.
   */
  hosted_window: z.object({ days: z.number().int(), read: z.number().int(), capped: z.boolean(), computed_at: z.string() }).nullable().optional(),
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
  /**
   * The connected machines that will take the routed jobs once the pull request is merged: each one serving the
   * repository (after `machines` gain it) with a label family one of the jobs reads. Absent before 2026-10-18.
   */
  runs_on: z.array(z.object({ id: z.string(), name: z.string(), os: z.string() })).optional(),
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
  /** What the account can buy: Pro, on any account type (ADR-039). */
  plan: z.literal("pro"),
  /** What it has now: Pro while a subscription runs, Enterprise when set by hand, else none (Free). */
  effective: z.enum(["pro", "enterprise", "none"]),
  /** Always null: there are no trials. Kept because the published CLI 0.1.1 reads it. */
  trial_ends_at: z.string().nullable(),
  valid_until: z.string().nullable(),
  /** Connected machines, not removed: what Pro bills for, at least 1. */
  machines: z.number().int(),
  /** What the machines connected now come to a month on Pro billed monthly, in cents before tax; null on Enterprise. */
  estimated_cents: z.number().int().nullable().optional(),
  /** A machine a month billed monthly; every savings figure uses this one. */
  price_per_machine_cents: z.number().int(),
  /** A machine a year billed annually, the default billing period shown. */
  price_per_machine_annual_cents: z.number().int(),
  /** Without a plan, how many machines it may connect. */
  free_machine_limit: z.number().int(),
  /** Without a plan, how many private repositories route (ADR-039). */
  free_private_repositories: z.number().int().optional(),
  /** Free's one private repository, the first the account routed; null until one is. */
  free_repository: z.string().nullable().optional(),
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
  /**
   * What it did, after the person's login: "changed performance on Benys-Mac-mini" (2026-10-18, `describeAudit` in
   * packages/shared/src/audit.ts), and each value before and after from the stored detail; older events show what they
   * recorded. Absent from older servers.
   */
  summary: z.string().optional(),
  changes: z.array(AuditChange).optional(),
  /** The Action filter's group. */
  group: AuditGroup.optional(),
  /** With `fold=1`: the targets of a run of the same change folded into this entry, and the ids of its events. */
  targets: z.array(z.string()).optional(),
  folded: z.array(z.string()).optional(),
});
export type AuditItem = z.infer<typeof AuditItem>;
export const AuditResponse = z.object({
  events: z.array(AuditItem),
  next_before: z.string().nullable(),
  /** As on JobsResponse: the previous page's cursor, every event's count and the events before this page. Absent before 2026-10-18. */
  prev_after: z.string().nullable().optional(),
  total: z.number().int().optional(),
  offset: z.number().int().optional(),
  /** With `facets=1`: counts per value of each filter, each with the others applied and its own left out. */
  facets: z
    .object({
      action: z.record(z.number().int()),
      machine: z.record(z.number().int()),
      actor: z.record(z.number().int()),
      source: z.record(z.number().int()),
    })
    .optional(),
});
export type AuditResponse = z.infer<typeof AuditResponse>;

/**
 * Why routing changed or a job moved, in one set of words for every surface (docs/BRAND.md, Glossary): the
 * dashboard's Fleet and Job pages and the CLI say the same thing for the same reason code. Codes stay as stored.
 */
export const REASON_TEXT: Record<string, string> = {
  machine_online: "Your machines can take jobs",
  no_machine: "No machine was online",
  needs_plan: "Needs Pro",
  manual: "Set by hand",
  github_self_hosted_incident: "GitHub runner incident",
  waiting_for_machine: "Jobs wait for your machines",
  machines_busy: "Your machines are busy, new jobs wait for a free one",
  overflow: "Your machines were busy",
  machines_held: "Your machines were holding new jobs back",
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

/** Global search's scopes (the canvas's Search board); `settings` is the web's own pages and actions, so it finds nothing here. */
export const SearchScope = z.enum(["all", "jobs", "machines", "repositories", "settings"]);
export type SearchScope = z.infer<typeof SearchScope>;

/** One result: what to show and the dashboard path that opens it, relative to the dashboard's root (`/<owner>/...`). */
export const SearchResult = z.object({
  kind: z.enum(["machine", "repository", "job"]),
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  path: z.string(),
  /** Jobs: when it started; repositories: their last job on the machines. Null when unknown. */
  at: z.string().nullable(),
  /** Jobs: success, failure, cancelled... or running; machines: their status. */
  status: z.string().nullable(),
  /** Repositories only: the repository's own icon, as on jobs and `/repositories`; absent from servers before 2026-10-19. */
  ...RepoIconFields,
});
export type SearchResult = z.infer<typeof SearchResult>;

/** GET /v1/accounts/:owner/search: results grouped, machines first, each group newest or best first. */
export const SearchResponse = z.object({
  role: Role,
  owner: z.string(),
  q: z.string(),
  scope: SearchScope,
  groups: z.object({ machines: z.array(SearchResult), repositories: z.array(SearchResult), jobs: z.array(SearchResult) }),
  total: z.number().int(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** A view an account's live event concerns (ARCHITECTURE.md, Live updates). */
export const LiveSection = z.enum(["fleet", "jobs", "routing", "settings"]);
export type LiveSection = z.infer<typeof LiveSection>;

/**
 * POST /v1/accounts/:owner/live: a ticket to open the account's live socket at `url`, asking for the subprotocols
 * `protocol` and `ticket.<ticket>`. Good for a minute; the connection then lives up to an hour.
 */
export const LiveTicketResponse = z.object({
  owner: z.string(),
  url: z.string(),
  protocol: z.string(),
  ticket: z.string(),
  expires_at: z.string(),
});
export type LiveTicketResponse = z.infer<typeof LiveTicketResponse>;

/** One message on the live socket: `hello` on connecting, `changed` with the machines and views to read again. */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("changed"), machines: z.array(z.string()), sections: z.array(LiveSection) }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
