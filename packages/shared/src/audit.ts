import { z } from "zod";

// The audit log in words (2026-10-18, the canvas's Audit board): each event says what actually changed ("changed
// performance on Benys-Mac-mini", not "changed settings") and lists each value before and after, read from its stored
// `detail`. Events written before a change recorded its old value show what they have. Codes stay as stored.

/** The Action filter's groups, and the stored action codes in each. */
export const AUDIT_GROUPS = {
  settings: ["machine.settings.changed", "defaults.changed"],
  repositories: ["machine.repositories.changed", "repository.route.opened", "repository_icon.changed", "repository_icon.cleared"],
  trust: ["machine.trust.changed", "machine.isolation.changed"],
  routing: ["machine.routing.changed"],
  fallback: ["fallback.changed"],
  machine_added: ["machine.connected"],
  machine_removed: ["machine.removed"],
  billing: ["billing.checkout_opened", "billing.period_switch_scheduled", "billing.period_switch_cancelled"],
} as const;
export const AuditGroup = z.enum(["settings", "repositories", "trust", "routing", "fallback", "machine_added", "machine_removed", "billing", "other"]);
export type AuditGroup = z.infer<typeof AuditGroup>;

/** The group an action code belongs to; `other` for re-runs, workflow runs, caches and anything newer. */
export function auditGroup(action: string): AuditGroup {
  for (const [group, actions] of Object.entries(AUDIT_GROUPS)) if ((actions as readonly string[]).includes(action)) return group as AuditGroup;
  return "other";
}

export const AuditChange = z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() });
export type AuditChange = z.infer<typeof AuditChange>;

const SETTING_LABELS: Record<string, string> = {
  performance: "Performance",
  paused: "Paused",
  idle_only: "Only when not in use",
  plugged_in_only: "Only when plugged in",
  stay_awake: "Stay awake",
  comfort: "Comfort",
  vm_memory_percent: "Memory for jobs",
};

const ROUTING: Record<string, string> = { primary: "Primary", backup: "Backup", off: "Off" };
const TRUST: Record<string, string> = { trusted: "Trusted", burst: "No secrets" };
const SIGN_IN: Record<string, string> = { github: "GitHub", google: "Google", passkey: "a passkey", email: "an email code" };
const FALLBACK: Record<string, string> = { auto: "On", forced_machine: "Off", forced_hosted: "GitHub-hosted only" };
const STAY_AWAKE: Record<string, string> = { never: "Never", plugged_in: "When plugged in", always: "Always" };

/** A stored value as people read it: on and off for switches, words capitalised, lists joined. */
export function auditValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return STAY_AWAKE[v] ?? (v ? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, " ") : v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return JSON.stringify(v);
}

/** What a machine serves, from a repository filter `{ all, repositories }`, with each repository's short name. */
function serves(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const f = v as { all?: unknown; repositories?: unknown };
  if (f.all === true) return "All repositories";
  return Array.isArray(f.repositories) ? f.repositories.map((r) => String(r).split("/").pop()).join(", ") || "None" : null;
}

/** A family label as people say it, for the fallback setting's target. */
function family(label: string): string {
  const f = label.replace(/^buildhound-/, "").replace(/-trusted$/, "");
  if (f === "macos") return "macOS";
  if (f === "linux") return "Linux";
  if (f === "linux-x64") return "Linux x64";
  if (f === "linux-arm64") return "Linux arm64";
  return label;
}

export interface AuditDescription {
  /** After the person's login: "changed performance on Benys-Mac-mini". */
  summary: string;
  changes: AuditChange[];
}

type Detail = Record<string, unknown>;
const obj = (v: unknown): Detail => (v && typeof v === "object" && !Array.isArray(v) ? (v as Detail) : {});

/** The words for one stored event: what it did, on what, and each value before and after where the detail has them. */
export function describeAudit(e: { action: string; target: string; detail: unknown }): AuditDescription {
  const d = obj(e.detail);
  const t = e.target;
  switch (e.action) {
    case "machine.settings.changed": {
      const from = obj(d.from);
      const to = obj(d.to);
      const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((k) => k !== "changed_at" && JSON.stringify(from[k]) !== JSON.stringify(to[k]));
      const changes = keys.map((k) => ({ field: SETTING_LABELS[k] ?? auditValue(k)!, from: auditValue(from[k]), to: auditValue(to[k]) }));
      if (keys.length === 1 && keys[0] === "paused") return { summary: `${to.paused ? "paused" : "resumed"} ${t}`, changes };
      const first = keys.find((k) => k !== "paused") ?? keys[0];
      return { summary: first ? `changed ${(SETTING_LABELS[first] ?? first).toLowerCase()} on ${t}` : `changed settings on ${t}`, changes };
    }
    case "defaults.changed": {
      const from = obj(d.from);
      const to = obj(d.to);
      const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k]));
      return { summary: "changed the defaults for new machines", changes: keys.map((k) => ({ field: SETTING_LABELS[k] ?? k, from: auditValue(from[k]), to: auditValue(to[k]) })) };
    }
    case "machine.repositories.changed":
      return { summary: `changed repositories on ${t}`, changes: "from" in d || "to" in d ? [{ field: "Serves", from: serves(d.from), to: serves(d.to) }] : [] };
    case "machine.trust.changed": {
      // How a person confirmed it (SECURITY.md, Where the person check lives): approved in the dashboard since 2026-10-19.
      const confirmed = obj(d.confirmed);
      const how = confirmed.by === "dashboard_approval" ? `Approved in the dashboard${typeof confirmed.sign_in_method === "string" && confirmed.sign_in_method !== "unknown" ? `, signed in with ${SIGN_IN[confirmed.sign_in_method] ?? confirmed.sign_in_method}` : ""}${typeof confirmed.requested_by === "string" ? `, asked by ${confirmed.requested_by} from ${String(confirmed.requested_from ?? "cli")}` : ""}` : null;
      return {
        summary: d.to === "trusted" ? `trusted ${t}` : `set ${t} to No secrets`,
        changes: [{ field: "Trust", from: TRUST[String(d.from)] ?? auditValue(d.from), to: TRUST[String(d.to)] ?? auditValue(d.to) }, ...(how ? [{ field: "Confirmed", from: null, to: how }] : [])],
      };
    }
    case "machine.isolation.changed":
      return { summary: `${t} now runs jobs in ${d.to === "container" ? "containers" : "VMs"}`, changes: [{ field: "Isolation", from: auditValue(d.from), to: auditValue(d.to) }] };
    case "machine.routing.changed":
      return { summary: `set ${t} to ${(ROUTING[String(d.to)] ?? String(d.to)).toLowerCase()}`, changes: [{ field: "Routing", from: ROUTING[String(d.from)] ?? auditValue(d.from), to: ROUTING[String(d.to)] ?? auditValue(d.to) }] };
    case "fallback.changed": {
      const to = String(d.to ?? d.mode ?? "");
      const verb = to === "auto" ? "turned fallback on for" : to === "forced_machine" ? "turned fallback off for" : to === "forced_hosted" ? "sent to GitHub-hosted only" : "changed fallback for";
      const changes = [{ field: "Fall back to GitHub-hosted", from: d.from !== undefined ? (FALLBACK[String(d.from)] ?? auditValue(d.from)) : null, to: FALLBACK[to] ?? auditValue(to) }];
      return { summary: `${verb} ${family(t)}`, changes };
    }
    case "machine.connected":
      return { summary: `connected ${t}`, changes: [] };
    case "machine.removed":
      return { summary: `removed ${t}`, changes: [] };
    case "machine.caches.cleared":
      return { summary: `cleared ${d.repository ? `${String(d.repository)}'s caches` : "the package caches"} on ${t}`, changes: [] };
    case "machine.caches.reset":
      return { summary: `reset the caches on ${t}`, changes: [] };
    case "machine.cleanup.requested":
      return { summary: `cleared Buildhound's caches on ${t}`, changes: [] };
    case "repository.route.opened":
      return { summary: `opened the routing pull request for ${t}`, changes: [] };
    case "repository_icon.changed":
      return { summary: `changed the icon of ${t}`, changes: [{ field: "Icon", from: auditValue(obj(d.from).source ?? obj(d.from).choice), to: auditValue(obj(d.to).source ?? obj(d.to).choice) }] };
    case "repository_icon.cleared":
      return { summary: `reset the icon of ${t}`, changes: [] };
    case "workflow.dispatched":
      return { summary: `ran ${String(d.workflow ?? "a workflow").split("/").pop()} on ${String(d.repository ?? t)}${d.ref ? ` at ${String(d.ref)}` : ""}`, changes: [] };
    case "job.rerun":
      return { summary: `re-ran ${d.scope === "failed_jobs" ? "the failed jobs of" : String(d.job ?? "a job")} ${d.scope === "failed_jobs" ? t : `in ${t}`}`, changes: [] };
    case "billing.checkout_opened":
      return { summary: `opened checkout for ${auditValue(d.plan) ?? "a plan"}`, changes: [] };
    case "billing.period_switch_scheduled":
      return { summary: `switched billing to ${String(d.to ?? "another period")} from the next renewal`, changes: [{ field: "Billing", from: auditValue(d.from), to: auditValue(d.to) }] };
    case "billing.period_switch_cancelled":
      return { summary: "kept the billing period as it is", changes: [] };
    case "trust_banner.dismissed":
      return { summary: `hid the banner about ${d.count ?? "the"} jobs with secrets on GitHub-hosted for everyone`, changes: [] };
    case "github.disconnected":
      return { summary: "disconnected their GitHub sign-in", changes: [] };
    default:
      return { summary: `${e.action.replace(/[._]/g, " ")} ${t}`.trim(), changes: [] };
  }
}

/** Events folded into one entry: runs of the same action by the same person and source within this many seconds. */
export const AUDIT_FOLD_SECONDS = 60;

export interface FoldableEvent {
  id: string;
  actor: string;
  action: string;
  target: string;
  source: string;
  created_at: string;
  summary: string;
}

/**
 * Folds runs of the same action by the same person from the same source, each within 60 seconds of the next, across
 * different targets, into one entry: the newest event, with `targets` listing each one and the summary naming how many
 * ("changed repositories on 2 machines"). Events are newest first, and stay so.
 */
export function foldAudit<T extends FoldableEvent>(events: T[], noun = (action: string) => (action.startsWith("machine.") ? "machines" : "items")): Array<T & { targets?: string[]; folded?: string[] }> {
  const out: Array<T & { targets?: string[]; folded?: string[] }> = [];
  // When the entry being built last took an event: the run goes on while each event is within the window of the one before.
  let lastAt = 0;
  for (const e of events) {
    const at = Date.parse(e.created_at);
    const last = out.at(-1);
    if (last && last.action === e.action && last.actor === e.actor && last.source === e.source && Math.abs(lastAt - at) <= AUDIT_FOLD_SECONDS * 1000 && !(last.targets ?? [last.target]).includes(e.target)) {
      const targets = [...(last.targets ?? [last.target]), e.target];
      const folded = [...(last.folded ?? [last.id]), e.id];
      out[out.length - 1] = { ...last, targets, folded, summary: `${describeVerb(last.targets ? last.summary : last.summary, last.target, Boolean(last.targets))}${targets.length} ${noun(e.action)}` };
    } else {
      out.push(e);
    }
    lastAt = at;
  }
  return out;
}

/** "changed repositories on Benys-Mac-mini" (or, once folded, "... on 2 machines") without its target: "changed repositories on ". */
function describeVerb(summary: string, target: string, folded: boolean): string {
  if (folded) return summary.replace(/\d+ \w+$/, "");
  const at = summary.lastIndexOf(target);
  return at > 0 ? summary.slice(0, at) : `${summary} `;
}

/** One CSV field, quoted when it must be. */
function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The export: time (UTC), person, action, summary, target, source and each change, one event a row. */
export function auditCsv(events: Array<{ created_at: string; actor: string; action: string; summary: string; target: string; source: string; changes: AuditChange[] }>): string {
  const head = ["time", "person", "action", "summary", "target", "source", "changes"];
  const rows = events.map((e) => [e.created_at, e.actor, e.action, `${e.actor} ${e.summary}`, e.target, e.source, e.changes.map((c) => `${c.field}: ${c.from ?? ""} to ${c.to ?? ""}`).join("; ")]);
  // A leading =, +, - or @ would be a formula in a spreadsheet: such a field starts with an apostrophe.
  const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
  return [head, ...rows].map((r) => r.map((v) => csvField(safe(v))).join(",")).join("\r\n") + "\r\n";
}
