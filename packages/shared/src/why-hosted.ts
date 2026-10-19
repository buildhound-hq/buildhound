import { z } from "zod";
import { FailoverMode, FailoverReason, isLinuxArm64Label, isLinuxX64Label, isTrustedTwin, labelFamily } from "./control-plane";

// Why jobs run on GitHub-hosted, in one explanation for every surface (the canvas's W-WhyHosted board, approved
// 2026-10-18): the dashboard's Overview banner, Fleet and Job pages, `buildhound status`, `buildhound jobs` and the
// MCP tool `routing_status` all say the same three things for the same reason: what happened, the fix, and who can
// do it. A reason that fixes itself says so, so nobody chases it. Reason codes stay as stored (failover_states,
// job_reruns); the words live only here.

/**
 * Every reason new jobs, or one job, ran where they did: the failover reasons, `not_served` (a family no connected
 * machine can run, Linux x64 on Macs for one), and two that only a single job has, re-run after its machine stopped
 * responding (`host_vanished`) or stopped (`host_stopped`) mid-job.
 */
export const WhyCode = z.enum([...FailoverReason.options, "not_served", "host_vanished", "host_stopped"]);
export type WhyCode = z.infer<typeof WhyCode>;

/** Who fixes it: it comes back on its own, a person on the account does something, or nothing needs fixing. */
export const WhyWho = z.enum(["automatic", "you", "nobody"]);
export type WhyWho = z.infer<typeof WhyWho>;

/** How a surface draws it: all well, busy for a moment, a person should look, or expected and quiet. */
export const WhyTone = z.enum(["ok", "busy", "attention", "quiet"]);
export type WhyTone = z.infer<typeof WhyTone>;

/** Where new jobs of a family go now. */
export const RoutedWhere = z.enum(["machines", "github_hosted"]);
export type RoutedWhere = z.infer<typeof RoutedWhere>;

/**
 * One row of the table. `summary`, `fix`, `job` and `next` may name `{owner}`, `{label}`, `{kind}` (macOS, Linux x64),
 * `{machine}` (Mac, or machine for Linux), `{machine_name}`
 * and `{encryption}` (FileVault, or disk encryption on Linux); `explainWhy` fills them in.
 */
export interface WhyEntry {
  /** Where new jobs go while this is the reason. */
  where: RoutedWhere;
  /** What we say, from the board. */
  summary: string;
  /** One sentence: the fix, or that it comes back on its own, or that nothing needs fixing. */
  fix: string;
  who: WhyWho;
  tone: WhyTone;
  /** What a job's page says under "Ran on GitHub-hosted.": why this one job did. Empty where a job never has it. */
  job: string;
  /** A CLI command, or a dashboard path starting with `/`. */
  next: string;
}

export const WHY_HOSTED: Record<WhyCode, WhyEntry> = {
  machine_online: {
    where: "machines",
    summary: "Your machines take new jobs",
    fix: "Nothing to fix.",
    who: "nobody",
    tone: "ok",
    job: "",
    next: "buildhound jobs --org {owner}",
  },
  machines_busy: {
    where: "machines",
    summary: "Every machine is busy, so new jobs wait for a free slot",
    fix: "A job that waits 150 seconds runs on GitHub-hosted instead. Comes back on its own when a slot frees.",
    who: "automatic",
    tone: "busy",
    job: "",
    next: "buildhound status --org {owner}",
  },
  waiting_for_machine: {
    where: "machines",
    summary: "Fall back to GitHub-hosted is off, so jobs wait for your machines",
    fix: "Turn Fall back to GitHub-hosted on, or bring a machine back online.",
    who: "you",
    tone: "attention",
    job: "",
    next: "buildhound failover --org {owner} --label {label} --fallback on --yes",
  },
  overflow: {
    where: "github_hosted",
    summary: "Every machine was busy too long",
    fix: "Jobs waited 150 seconds, so new ones went to GitHub-hosted. Comes back when a slot frees. Add a machine for more room.",
    who: "automatic",
    tone: "busy",
    job: "Every machine was busy, and it waited 150 seconds for a free slot.",
    next: "buildhound status --org {owner}",
  },
  machines_held: {
    where: "github_hosted",
    summary: "Your machines are holding new jobs back",
    fix: 'Comes back on its own once a machine takes jobs again; or turn off "Only when not in use" on a desktop.',
    who: "automatic",
    tone: "attention",
    job: "Your machines were holding new jobs back.",
    next: "buildhound status --org {owner}",
  },
  no_machine: {
    where: "github_hosted",
    summary: "No machine is connected",
    fix: "Run buildhound doctor on each machine listed to see why it takes no jobs.",
    who: "you",
    tone: "attention",
    job: "No machine was online to take it.",
    next: "buildhound doctor --org {owner}",
  },
  needs_trusted_machine: {
    where: "github_hosted",
    summary: "Jobs with secrets need a trusted machine",
    fix: "Set up a trusted {machine}: {encryption} on, then Trust this {machine}.",
    who: "you",
    tone: "attention",
    job: "It uses secrets and no trusted {machine} was free.",
    next: "buildhound runner set --org {owner} --machine {machine_name} --trusted on",
  },
  untrusted_event: {
    where: "github_hosted",
    summary: "A fork or outside event started this run",
    fix: "Public repositories never run strangers' jobs on your machines. Nothing to fix, it is free on GitHub-hosted.",
    who: "nobody",
    tone: "quiet",
    job: "It was started from a fork or by someone outside the repository.",
    next: "buildhound jobs --org {owner}",
  },
  needs_plan: {
    where: "github_hosted",
    summary: "More private repositories need Pro",
    fix: "Choose Pro. Free runs one private repository, and every public one keeps running here.",
    who: "you",
    tone: "attention",
    job: "Its repository is private, the account is on Free, and Free's one private repository is another.",
    next: "buildhound billing checkout --org {owner}",
  },
  manual: {
    where: "github_hosted",
    summary: "You set this to GitHub-hosted",
    fix: "Switch it back in Fleet when you want your machines to take these jobs.",
    who: "you",
    tone: "quiet",
    job: "This kind of job was set to GitHub-hosted by hand.",
    next: "buildhound failover --org {owner} --label {label} --set auto --yes",
  },
  github_self_hosted_incident: {
    where: "github_hosted",
    summary: "GitHub's self-hosted runners are down",
    fix: "New jobs route to the healthy side until GitHub recovers.",
    who: "automatic",
    tone: "attention",
    job: "GitHub's self-hosted runners were down.",
    next: "buildhound status --org {owner}",
  },
  not_served: {
    where: "github_hosted",
    summary: "Your machines can't run this kind",
    fix: "Expected, nothing to fix; a {kind} machine would take them.",
    who: "nobody",
    tone: "quiet",
    job: "None of your machines can run {kind} jobs.",
    next: "buildhound runner add --org {owner} --check",
  },
  host_vanished: {
    where: "github_hosted",
    summary: "Its machine stopped responding mid-job",
    fix: "It was re-run on GitHub-hosted. Run buildhound doctor on that machine if it happens again.",
    who: "you",
    tone: "attention",
    job: "Its machine stopped responding mid-job, so it was re-run on GitHub-hosted.",
    next: "buildhound doctor --org {owner}",
  },
  host_stopped: {
    where: "github_hosted",
    summary: "Its machine stopped mid-job",
    fix: "It was re-run. Nothing to fix when the machine was shut down or restarted on purpose.",
    who: "nobody",
    tone: "quiet",
    job: "Its machine shut down or restarted mid-job, so it was re-run.",
    next: "buildhound jobs --org {owner}",
  },
};

/** A label family as people say it: macOS, Linux, Linux x64, Linux arm64; a trusted twin as its family. */
export function familyName(label: string): string {
  const family = labelFamily(label);
  if (family.startsWith("buildhound-macos")) return "macOS";
  if (isLinuxX64Label(family)) return "Linux x64";
  if (isLinuxArm64Label(family)) return "Linux arm64";
  if (family.startsWith("buildhound-linux")) return "Linux";
  return family.replace(/^buildhound-/, "");
}

export interface WhyContext {
  owner: string;
  /** The family label, such as `buildhound-macos`. */
  label?: string | undefined;
  /** A machine a person could mark trusted, for `needs_trusted_machine`; `<machine>` when there is none. */
  machine_name?: string | undefined;
}

export interface Why {
  code: WhyCode;
  where: RoutedWhere;
  summary: string;
  fix: string;
  who: WhyWho;
  tone: WhyTone;
  job: string;
  next: string;
}

/** The table's row for a reason with every placeholder filled in. */
export function explainWhy(code: WhyCode, ctx: WhyContext): Why {
  const entry = WHY_HOSTED[code];
  const label = ctx.label ?? "buildhound-macos";
  const mac = labelFamily(label).startsWith("buildhound-macos");
  const values: Record<string, string> = {
    owner: ctx.owner,
    label: labelFamily(label),
    kind: familyName(label),
    machine: mac ? "Mac" : "machine",
    machine_name: ctx.machine_name ?? "<machine>",
    encryption: mac ? "FileVault" : "disk encryption",
  };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
  return { code, where: entry.where, summary: fill(entry.summary), fix: fill(entry.fix), who: entry.who, tone: entry.tone, job: fill(entry.job), next: fill(entry.next) };
}

/** A job's re-run reason (job_reruns) as a reason here, or null when it is not one a job on GitHub-hosted can have. */
export function whyFromRerun(reason: string): WhyCode | null {
  const parsed = WhyCode.safeParse(reason);
  return parsed.success && WHY_HOSTED[parsed.data].where === "github_hosted" ? parsed.data : null;
}

// Jobs waiting for the machines with Fall back to GitHub-hosted off (2026-10-19, founder: Overview showed four near
// identical "jobs are waiting for a machine" rows while the Mac mini was simply busy). One set of words for the
// Overview's Needs you, the sidebar's status card, `buildhound overview` and the MCP tool `overview_get`:
//
// 1. A trusted twin is its family: buildhound-linux and buildhound-linux-trusted are one.
// 2. Waiting is the person's own choice (fallback off), so while a machine that serves the family is online and not
//    paused (free, busy or holding back for a moment) it is status, never something that needs a person.
// 3. It needs a person only when nothing can take the jobs: every machine that serves the family is paused, or has been
//    offline for more than WAIT_OFFLINE_AFTER_MS. Then the words name the real cause.
// 4. Families in the same state are one item: "Linux and Linux arm64 jobs wait for your machines".

/** How long a machine is offline before its families' waiting jobs need a person: a reboot or a blip never does. */
export const WAIT_OFFLINE_AFTER_MS = 5 * 60_000;

/**
 * Why a family waits: `working` (a serving machine is online, free, busy or holding back), `paused` (every one is),
 * `offline` (every one is offline), `down` (no machine serves it, or each is paused or offline).
 */
export const WaitCause = z.enum(["working", "paused", "offline", "down"]);
export type WaitCause = z.infer<typeof WaitCause>;

/** One item of waiting families, in the words every surface uses. */
export const WaitGroup = z.object({
  /** The families, in Fleet's order (macOS, Linux, Linux arm64, Linux x64). */
  labels: z.array(z.string()),
  /** "Linux and Linux arm64". */
  names: z.string(),
  cause: WaitCause,
  /** Whether a person has to do something: every serving machine paused, or offline for a while. */
  act: z.boolean(),
  /** The machines that serve these families, by name. */
  machines: z.array(z.string()),
  /** A headline: "Linux jobs wait for your Macs", "Benys-Mac-mini is paused", "No machine that runs macOS is online". */
  title: z.string(),
  /** What happens, and what to do, in a sentence or two. */
  text: z.string(),
  /** The CLI command that fixes it, or that shows more. */
  next: z.string(),
});
export type WaitGroup = z.infer<typeof WaitGroup>;

/** A machine as the wait words need it. */
export interface WaitMachine {
  name: string;
  status: string;
  os?: string | undefined;
  /** Label families it serves, when known; else the OS decides (a Mac serves macOS and Linux on Arm). */
  labels?: readonly string[] | undefined;
  last_heartbeat_at?: string | null | undefined;
}

/** "macOS", "macOS and Linux", "macOS, Linux and Linux arm64". */
export function joinNames(list: readonly string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** The machines that serve a family: by their labels when known, else a Mac serves macOS and Linux on Arm. */
export function servingMachines<M extends WaitMachine>(family: string, machines: readonly M[]): M[] {
  return machines.filter((m) => {
    if (m.labels && m.labels.length) return m.labels.map(labelFamily).includes(family);
    if (family.startsWith("buildhound-macos")) return m.os === "macos";
    if (isLinuxX64Label(family)) return m.os === "linux";
    if (family.startsWith("buildhound-linux")) return m.os === "macos" || m.os === "linux";
    return true;
  });
}

/** Why a family waits, from the machines that serve it, and whether that needs a person. */
export function waitCause(serving: readonly WaitMachine[], now: number): { cause: WaitCause; act: boolean } {
  if (!serving.length) return { cause: "down", act: true };
  const up = serving.filter((m) => m.status !== "offline" && m.status !== "paused" && m.status !== "removed");
  if (up.length) return { cause: "working", act: false };
  const paused = serving.filter((m) => m.status === "paused");
  if (paused.length === serving.length) return { cause: "paused", act: true };
  // Offline a moment ago is a reboot or a blip: it waits like a busy machine until it has been gone a few minutes.
  const lately = serving.some((m) => {
    if (m.status !== "offline") return false;
    const t = m.last_heartbeat_at ? Date.parse(m.last_heartbeat_at) : NaN;
    return Number.isFinite(t) && now - t < WAIT_OFFLINE_AFTER_MS;
  });
  return { cause: paused.length ? "down" : "offline", act: !lately };
}

const machinesNoun = (machines: readonly WaitMachine[]) => (machines.length && machines.every((m) => m.os === "macos") ? "Macs" : "machines");

const WAIT_ORDER = ["buildhound-macos", "buildhound-linux", "buildhound-linux-arm64", "buildhound-linux-x64"];

function waitWords(g: { labels: string[]; names: string; cause: WaitCause }, serving: readonly WaitMachine[], owner: string): { title: string; text: string; next: string } {
  const runs = g.names.replace(/ and /g, " or ");
  const fallback = g.labels.length === 1 ? explainWhy("waiting_for_machine", { owner, label: g.labels[0] }).next : `buildhound status --org ${owner}`;
  const after = "Jobs wait for them, since Fall back to GitHub-hosted is off. Turn it on and new jobs route to GitHub-hosted.";
  switch (g.cause) {
    case "paused":
      return {
        title: serving.length === 1 ? `${serving[0]!.name} is paused` : `Your ${machinesNoun(serving)} are paused`,
        text: `${g.names} jobs wait until one is resumed, since Fall back to GitHub-hosted is off.`,
        next: serving.length === 1 ? `buildhound runner set --org ${owner} --machine ${serving[0]!.name} --resume` : `buildhound runner status --org ${owner}`,
      };
    case "offline":
      return { title: `No machine that runs ${runs} is online`, text: after, next: fallback };
    case "down":
      return { title: `No machine that runs ${runs} can take jobs`, text: serving.length ? `Each one is paused or offline. ${after}` : after, next: fallback };
    case "working":
      return { title: `${g.names} jobs wait for your ${machinesNoun(serving)}`, text: `${WHY_HOSTED.waiting_for_machine.summary}. They start as soon as one is free.`, next: `buildhound status --org ${owner}` };
  }
}

/**
 * The waiting families as items, one per cause, in Fleet's order: `labels` are the labels whose jobs wait (a trusted
 * twin folds into its family), `machines` the account's machines. On an account of Macs, Linux and Linux arm64 are
 * one thing (every Mac runs Linux on Arm), so they are never named side by side.
 */
export function waitGroups(labels: readonly string[], machines: readonly WaitMachine[], now: number, owner: string): WaitGroup[] {
  const macsOnly = machines.length > 0 && machines.every((m) => m.os === "macos");
  const families: string[] = [];
  for (const label of labels) {
    const raw = labelFamily(label);
    const family = macsOnly && raw === "buildhound-linux-arm64" ? "buildhound-linux" : raw;
    if (!families.includes(family)) families.push(family);
  }
  const rank = (f: string) => (WAIT_ORDER.includes(f) ? WAIT_ORDER.indexOf(f) : WAIT_ORDER.length);
  families.sort((a, b) => rank(a) - rank(b));
  const groups: Array<{ labels: string[]; cause: WaitCause; act: boolean; serving: WaitMachine[] }> = [];
  for (const family of families) {
    const serving = servingMachines(family, machines);
    const { cause, act } = waitCause(serving, now);
    const same = groups.find((g) => g.cause === cause && g.act === act);
    if (same) {
      same.labels.push(family);
      for (const m of serving) if (!same.serving.includes(m)) same.serving.push(m);
    } else groups.push({ labels: [family], cause, act, serving: [...serving] });
  }
  return groups.map(({ serving, ...g }) => {
    const names = joinNames([...new Set(g.labels.map(familyName))]);
    return { ...g, names, machines: serving.map((m) => m.name), ...waitWords({ ...g, names }, serving, owner) };
  });
}

// Each machine's own why, for a family on GitHub-hosted because the machines hold new jobs back or none can take them
// (`machines_held`, `no_machine`): the board names each machine with a short reason, "Benys-MacBook-Pro in use".

export const MachineWhyCode = z.enum([
  "free",
  "busy",
  "offline",
  "needs_update",
  "removed",
  "routing_off",
  "paused",
  "in_use",
  "on_battery",
  "memory_pressure",
  "swap_growing",
  "memory_low",
  "heat",
  "low_power",
  "comfort",
  "strain",
  "pool_consent",
  "not_ready",
  "starting",
  "not_listening",
  "no_repositories",
  "not_this_kind",
  "no_secrets",
  "container",
]);
export type MachineWhyCode = z.infer<typeof MachineWhyCode>;

/** Each code as a few plain words, after the machine's name. */
export const MACHINE_WHY: Record<MachineWhyCode, string> = {
  free: "free",
  busy: "busy",
  offline: "offline",
  needs_update: "updating its Buildhound agent",
  removed: "removed",
  routing_off: "routing off",
  paused: "paused",
  in_use: "in use",
  on_battery: "on battery",
  memory_pressure: "short on memory",
  swap_growing: "short on memory",
  memory_low: "short on memory",
  heat: "hot",
  low_power: "Low Power Mode",
  comfort: "easing off to stay comfortable",
  strain: "easing off to stay fast",
  pool_consent: "waiting for its owner to say yes on it",
  not_ready: "image not ready yet",
  starting: "just connected",
  not_listening: "not listening for jobs",
  no_repositories: "serves no repository",
  not_this_kind: "can't run this kind",
  no_secrets: "No secrets",
  container: "container isolation, never takes secrets",
};

/** What the control plane knows about a machine from its record and last heartbeat (CONTROL_PLANE_API.md, Failover). */
export interface MachineWhyInput {
  status: string;
  removed?: boolean | undefined;
  /** The machine's label families, without trusted twins. */
  labels: readonly string[];
  routing: string;
  trust?: string | undefined;
  isolation?: string | null | undefined;
  paused?: boolean | undefined;
  idle_only?: boolean | undefined;
  plugged_in_only?: boolean | undefined;
  /** From the last heartbeat; a machine that never sent one counts as idle and plugged in. */
  idle?: boolean | undefined;
  on_battery?: boolean | undefined;
  low_power?: boolean | undefined;
  thermal?: string | undefined;
  strain?: string | undefined;
  memory_low?: readonly string[] | undefined;
  awaiting_pool_consent?: boolean | undefined;
  not_ready?: readonly string[] | undefined;
  running_jobs?: number | undefined;
  capacity?: number | undefined;
  slot?: { capacity: number; running: number } | undefined;
  exclusive?: string | undefined;
  /** False until the machine has sent the two heartbeats in a row it needs to take jobs. */
  heartbeats_ok?: boolean | undefined;
  /** False when its Buildhound agent has not polled GitHub for the label lately. */
  listening?: boolean | undefined;
  /** False for a machine on a personal account that serves no repository. */
  serves_repositories?: boolean | undefined;
}

const HOT = new Set(["serious", "critical"]);

/**
 * Why a machine takes a label's new jobs or not, in the order the control plane decides it (`availability` in
 * apps/api/src/failover.ts), with the owner's own rules named before the strain behind them. A machine under memory
 * or heat strain that runs jobs of its own is busy, since the strain passes with those jobs (`strainedByOwnJobs`).
 * For a trusted twin (`buildhound-macos-trusted`) a machine that does not take secrets says so first.
 */
export function machineWhy(m: MachineWhyInput, label: string): MachineWhyCode {
  const family = labelFamily(label);
  if (m.removed) return "removed";
  if (!m.labels.includes(family)) return "not_this_kind";
  if (isTrustedTwin(label)) {
    if (m.isolation === "container") return "container";
    if (m.trust !== "trusted") return "no_secrets";
  }
  if (m.status === "needs_update") return "needs_update";
  if (m.status !== "online" && m.status !== "paused" && m.status !== "draining") return "offline";
  if (m.routing === "off") return "routing_off";
  if (m.paused || m.status === "paused" || m.status === "draining") return "paused";
  if (m.serves_repositories === false) return "no_repositories";
  if (m.idle_only && m.idle === false) return "in_use";
  if (m.plugged_in_only && m.on_battery) return "on_battery";
  if (m.low_power || m.strain === "low_power") return "low_power";
  if (m.strain === "comfort") return "comfort";
  if (m.awaiting_pool_consent) return "pool_consent";
  if (m.not_ready?.includes(family)) return "not_ready";
  if (m.listening === false) return "not_listening";
  if (m.heartbeats_ok === false) return "starting";
  const memory: MachineWhyCode | null =
    m.strain === "memory_pressure" ? "memory_pressure" : m.strain === "swap_growing" ? "swap_growing" : m.strain === "memory_low" || m.memory_low?.includes(family) ? "memory_low" : null;
  const heat = (m.thermal && HOT.has(m.thermal)) || m.strain === "thermal";
  // Strain from the machine's own running jobs passes with them: the machine is busy, not held.
  if ((memory || heat) && (m.running_jobs ?? 0) > 0) return "busy";
  if (memory) return memory;
  if (heat) return "heat";
  if (m.strain) return "strain";
  if ((m.capacity !== undefined && (m.running_jobs ?? 0) >= m.capacity) || m.exclusive === "running" || m.exclusive === "finishing_up") return "busy";
  if (m.slot && m.slot.running >= m.slot.capacity) return "busy";
  return "free";
}

/** One machine of a family, as `routing_status` and the Fleet show it. */
export const RoutingMachine = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string(),
  why: MachineWhyCode,
  /** `why` in plain words: "in use", "short on memory". */
  phrase: z.string(),
  /** For `offline`, when its last heartbeat arrived; null otherwise. */
  since: z.string().nullable(),
});
export type RoutingMachine = z.infer<typeof RoutingMachine>;

const WhyFields = {
  reason: WhyCode.nullable(),
  summary: z.string(),
  fix: z.string(),
  who: WhyWho,
  tone: WhyTone,
  next: z.string(),
};

/** Where one family's jobs that use secrets go (its trusted twin, ADR-023). */
export const RoutingSecrets = z.object({ where: RoutedWhere, ...WhyFields });
export type RoutingSecrets = z.infer<typeof RoutingSecrets>;

/** One label family on the account: where its new jobs go now and why, and each machine's own why. */
export const RoutingFamily = z.object({
  label: z.string(),
  /** macOS, Linux, Linux x64, Linux arm64. */
  name: z.string(),
  where: RoutedWhere,
  ...WhyFields,
  /** Fall back to GitHub-hosted: `auto` is on, `forced_machine` is off, `forced_hosted` set to GitHub-hosted by hand. */
  mode: FailoverMode,
  changed_at: z.string().nullable(),
  machines: z.array(RoutingMachine),
  /** Jobs that use secrets, through the family's trusted twin; null for a family no machine serves. */
  secrets: RoutingSecrets.nullable(),
});
export type RoutingFamily = z.infer<typeof RoutingFamily>;

/**
 * The Overview's trust banner (the canvas's D-TrustOnboard board, panel 2): jobs that use secrets ran on GitHub-hosted
 * in the last 7 days while no machine was trusted. `show` already weighs a dismissal: 30 days for everyone on the
 * account, sooner only when the count has doubled since. Only an admin dismisses it (`can_dismiss`); a member is shown
 * "Ask an admin to set up a trusted Mac" instead.
 */
export const TrustBanner = z.object({
  show: z.boolean(),
  count: z.number().int(),
  days: z.number().int(),
  summary: z.string(),
  fix: z.string(),
  can_dismiss: z.boolean(),
  dismissed_until: z.string().nullable(),
  next: z.string(),
});
export type TrustBanner = z.infer<typeof TrustBanner>;

/** GET /v1/accounts/:owner/routing: per family, where new jobs go now and why (`buildhound status`, MCP `routing_status`). */
export const RoutingStatusResponse = z.object({
  /** As on every read endpoint (dashboard.ts, Role); spelled out here so this module stands alone. */
  role: z.enum(["admin", "member"]),
  owner: z.string(),
  families: z.array(RoutingFamily),
  trust_banner: TrustBanner,
});
export type RoutingStatusResponse = z.infer<typeof RoutingStatusResponse>;

/** Why one job ran on GitHub-hosted, on the jobs list and a job's page: the table's words for its reason. */
export const HostedReason = z.object({
  code: WhyCode,
  summary: z.string(),
  /** What the job's page says under "Ran on GitHub-hosted.". */
  job: z.string(),
  fix: z.string(),
  who: WhyWho,
  tone: WhyTone,
  next: z.string(),
});
export type HostedReason = z.infer<typeof HostedReason>;

/** The table's row for one job that ran on GitHub-hosted. */
export function hostedReason(code: WhyCode, ctx: WhyContext): HostedReason {
  const w = explainWhy(code, ctx);
  return { code, summary: w.summary, job: w.job || w.summary, fix: w.fix, who: w.who, tone: w.tone, next: w.next };
}

/** The trust banner's words: "12 jobs with secrets ran on GitHub-hosted this week". */
export function trustBannerSummary(count: number): string {
  return `${count} job${count === 1 ? "" : "s"} with secrets ran on GitHub-hosted this week`;
}

/** Whether a dismissed banner shows again: 30 days have passed, or the count has doubled since it was dismissed. */
export function bannerShows(count: number, dismissal: { at: Date; count: number } | null, now: Date, days = 30): boolean {
  if (count <= 0) return false;
  if (!dismissal) return true;
  if (now.getTime() >= dismissal.at.getTime() + days * 86_400_000) return true;
  return count >= 2 * Math.max(1, dismissal.count);
}

// Why a job ended cancelled (2026-10-18), in the same shape as the table above, so the Job page and the jobs list say it
// the same way. In order: the control plane's own record (it cancelled the run to re-run the job elsewhere, job_reruns),
// then what GitHub's annotations on the job said, read once when the job completed and stored (never on a page view),
// else only that it was cancelled on GitHub, with no guess.

export const CancelCode = z.enum(["rerun", "superseded", "cancelled_by_person", "cancelled_by_buildhound", "timed_out", "cancelled_on_github"]);
export type CancelCode = z.infer<typeof CancelCode>;

/** What is stored for a cancelled job from GitHub's annotations: the code, and the login, group or minutes it named. */
export const StoredCancel = z.object({
  code: z.enum(["superseded", "cancelled_by_person", "cancelled_by_buildhound", "timed_out", "cancelled_on_github"]),
  login: z.string().optional(),
  group: z.string().optional(),
  minutes: z.number().int().optional(),
});
export type StoredCancel = z.infer<typeof StoredCancel>;

/**
 * GitHub's annotation messages for a cancelled job as a reason. `appSlug` names the GitHub App, whose bot cancelling a run
 * is Buildhound's own cancel. A message none of these match is `cancelled_on_github`.
 */
export function cancelFromAnnotations(messages: readonly string[], appSlug?: string): StoredCancel {
  for (const m of messages) {
    const superseded = /higher priority waiting request for '?(.+?)'? exists/i.exec(m);
    if (superseded) return { code: "superseded", group: superseded[1]! };
    const time = /exceeded the maximum execution time of (\d+) minutes?/i.exec(m);
    if (time) return { code: "timed_out", minutes: Number(time[1]) };
    const by = /cancel+ed by @([\w-]+(?:\[bot\])?)/i.exec(m);
    if (by) {
      const login = by[1]!;
      if (appSlug && login.toLowerCase() === `${appSlug.toLowerCase()}[bot]`) return { code: "cancelled_by_buildhound", login };
      return { code: "cancelled_by_person", login };
    }
  }
  return { code: "cancelled_on_github" };
}

/** Why a cancelled job was cancelled, as the jobs list and a job's page show it. */
export const CancelReason = z.object({
  code: CancelCode,
  summary: z.string(),
  fix: z.string(),
  who: WhyWho,
  tone: WhyTone,
  /** For `rerun`: where the control plane re-ran it, and why (a `WhyCode` or `stuck`). */
  rerun_to: z.enum(["machines", "github_hosted"]).optional(),
  rerun_reason: z.string().optional(),
  /** `cancelled_by_person`: who, as GitHub named them. */
  login: z.string().optional(),
});
export type CancelReason = z.infer<typeof CancelReason>;

/** The words for a cancelled job: a re-run by the control plane first, then the stored annotation, else "Cancelled on GitHub". */
export function cancelReason(
  ctx: { workflow?: string | null | undefined; branch?: string | null | undefined },
  rerun: { reason: string; routed_to: "machine" | "hosted" } | null,
  stored: StoredCancel | null,
): CancelReason {
  if (rerun) {
    const to = rerun.routed_to === "hosted" ? "github_hosted" : "machines";
    const why = WhyCode.safeParse(rerun.reason);
    const where = to === "github_hosted" ? "GitHub-hosted" : "your machines";
    const because = rerun.reason === "stuck" ? "it was stuck in GitHub's queue while a machine had room" : why.success ? lowerFirst(WHY_HOSTED[why.data].job && !/re-run/.test(WHY_HOSTED[why.data].job) ? WHY_HOSTED[why.data].job : WHY_HOSTED[why.data].summary).replace(/\.$/, "") : rerun.reason.replace(/_/g, " ");
    return { code: "rerun", summary: `Buildhound re-ran it on ${where}: ${because}`, fix: "Nothing to fix: the re-run took its place.", who: "automatic", tone: "quiet", rerun_to: to, rerun_reason: rerun.reason };
  }
  const s = stored ?? { code: "cancelled_on_github" as const };
  switch (s.code) {
    case "superseded": {
      const of = ctx.workflow ? ` of ${ctx.workflow}` : "";
      const on = ctx.branch ? ` on ${ctx.branch}` : "";
      return { code: "superseded", summary: `A newer run${of}${on} replaced this one`, fix: "Nothing to fix: the workflow's concurrency group cancels an older run when a newer one starts.", who: "nobody", tone: "quiet" };
    }
    case "cancelled_by_person":
      return { code: "cancelled_by_person", summary: `Cancelled by @${s.login ?? "someone"}`, fix: "Nothing to fix.", who: "nobody", tone: "quiet", ...(s.login ? { login: s.login } : {}) };
    case "cancelled_by_buildhound":
      return { code: "cancelled_by_buildhound", summary: "Buildhound cancelled its run to re-run it", fix: "Nothing to fix: the re-run took its place.", who: "automatic", tone: "quiet" };
    case "timed_out":
      return { code: "timed_out", summary: "Hit the job's time limit", fix: `Raise the job's timeout-minutes${s.minutes ? ` (${s.minutes} now)` : ""}, or make it faster.`, who: "you", tone: "attention" };
    default:
      return { code: "cancelled_on_github", summary: "Cancelled on GitHub", fix: "GitHub gave no reason.", who: "nobody", tone: "quiet" };
  }
}

const lowerFirst = (s: string) => (/^(GitHub|Low Power|Linux|FileVault|Buildhound)/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
