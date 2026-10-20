import { Command, Option } from "commander";
import { EXIT } from "@buildhound/shared";
import { readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { ENCRYPTION_WHY, ensureEncryption, pollUntil, readEncryption, systemExec, terminalIO, trustNeedsHuman, type BlockedBy, type TrustIO } from "../lib/trust-step";
import { CliError, emit, wantsJson } from "../output";
import { color, done, needed, next } from "../lib/style";

export interface RunnerSetOptions {
  machine?: string | undefined;
  org?: string | undefined;
  routing?: string | undefined;
  pause?: boolean | undefined;
  resume?: boolean | undefined;
  performance?: string | undefined;
  /** Adaptive comfort (ADR-035): `adaptive` adapts a running job's VM before refusing new jobs, `off` keeps today's checks. */
  comfort?: string | undefined;
  /** Stay awake between jobs (RUNNERS.md, Resource use): never, plugged_in (on mains power only) or always. */
  stayAwake?: string | undefined;
  idleOnly?: string | boolean | undefined;
  pluggedInOnly?: string | boolean | undefined;
  trusted?: string | boolean | undefined;
  /** Hidden alias for `--trusted`, kept for agents and scripts written against 0.1.1: trusted, no-secrets or burst. */
  trust?: string | undefined;
  /** Personal accounts: the repositories the machine serves, as owner/name separated by commas, or `all`. */
  repositories?: string | undefined;
  addRepository?: string | undefined;
  removeRepository?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface MachineSettings {
  paused: boolean;
  idle_only: boolean;
  plugged_in_only: boolean;
  performance?: string;
  comfort?: string;
  /** Absent until set through the API or reported by the machine: the default, plugged_in. */
  stay_awake?: string;
  changed_at?: string;
}

/** What a machine on a personal account is set to serve; `pending` until its next heartbeat applies a change. */
export interface RepositoryFilter {
  all: boolean;
  repositories: string[];
  pending: boolean;
}

export interface RunnerSetResult {
  status: "updated" | "unchanged";
  machine: { id: string; name: string; routing: string; trust?: string };
  settings: MachineSettings;
  /** Personal accounts: the repositories the machine serves now, and what it is set to serve. */
  repositories?: string[];
  repository_filter?: RepositoryFilter | null;
  owner: string;
  failover: Record<string, unknown>;
  next: string;
}

/** Marking a machine trusted needs a person at a terminal (ADR-023); an agent gets this instead. */
export interface RunnerSetNeedsHuman {
  status: "needs_human";
  /** A person marks a machine trusted at a terminal or on the dashboard, or adds a repository to the GitHub App on GitHub. */
  reason: "trust_needs_person" | "repository_not_in_app" | (string & {});
  url: string;
  /** For trust: the disk is not encrypted yet, which only jobs that use secrets need (trust-step.ts). */
  blocked_by?: BlockedBy;
  next: string;
}

const ROUTINGS = ["primary", "backup", "off"] as const;
const MODES = ["quiet", "balanced", "max"] as const;
const COMFORTS = ["adaptive", "off"] as const;
const STAY_AWAKE = ["never", "plugged_in", "always"] as const;
/** The stay_awake setting in words, as the Mac app's Stay awake choice says it. */
export const STAY_AWAKE_WORDS: Record<string, string> = { never: "never stays awake between jobs", plugged_in: "stays awake between jobs while plugged in", always: "always stays awake between jobs" };
/** `--trust` values: the stored tier `burst` is shown as "no secrets" (docs/BRAND.md, Glossary); both spellings work. */
const TRUSTS: Record<string, "trusted" | "burst"> = { trusted: "trusted", "no-secrets": "burst", burst: "burst" };
type Listed = { machines?: Array<{ id?: unknown; name?: unknown; os?: unknown; disk_encrypted?: unknown; trust?: unknown }> };
type Patched = {
  machine: { id: string; name: string; routing: string };
  policy: MachineSettings;
  repositories?: string[];
  repository_filter?: RepositoryFilter | null;
  changed: boolean;
  failover: Record<string, unknown>;
};

/** `owner/a,owner/b`: repository full names separated by commas. */
function repositoryList(v: string, flag: string, usage: string): string[] {
  const list = v.split(",").map((r) => r.trim()).filter(Boolean);
  if (list.length === 0) throw new CliError("USAGE", `${flag} takes owner/name entries separated by commas`, usage, EXIT.usage);
  for (const r of list) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new CliError("USAGE", `${flag} takes owner/name entries separated by commas, got "${r}"`, usage, EXIT.usage);
  }
  return list;
}

function onOff(v: string | boolean | undefined, flag: string, usage: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === "on") return true;
  if (v === false || v === "off") return false;
  throw new CliError("USAGE", `${flag} must be on or off, got "${String(v)}"`, usage, EXIT.usage);
}

/**
 * Changes a machine's routing and settings through the control plane. Settings reach the machine on
 * its next heartbeat, within 30 seconds; a change made on the machine afterwards still wins (latest
 * change wins). Idempotent and reversible, so no --yes.
 */
export async function runRunnerSet(opts: RunnerSetOptions): Promise<RunnerSetResult | RunnerSetNeedsHuman> {
  const usage =
    "buildhound runner set --machine <id|name> --org <login> [--routing primary|backup|off] [--pause | --resume] [--performance quiet|balanced|max] [--comfort adaptive|off] [--stay-awake never|plugged_in|always] [--idle-only on|off] [--plugged-in-only on|off] [--trusted on|off] [--repositories <owner/a,owner/b|all> | --add-repository <owner/a> --remove-repository <owner/b>]";
  if (!opts.org || !opts.machine) throw new CliError("USAGE", "--machine and --org are required", usage, EXIT.usage);
  if (opts.routing !== undefined && !(ROUTINGS as readonly string[]).includes(opts.routing)) {
    throw new CliError("USAGE", `--routing must be primary, backup or off, got "${opts.routing}"`, usage, EXIT.usage);
  }
  if (opts.performance !== undefined && !(MODES as readonly string[]).includes(opts.performance)) {
    throw new CliError("USAGE", `--performance must be quiet, balanced or max, got "${opts.performance}"`, usage, EXIT.usage);
  }
  if (opts.comfort !== undefined && !(COMFORTS as readonly string[]).includes(opts.comfort)) {
    throw new CliError("USAGE", `--comfort must be adaptive or off, got "${opts.comfort}"`, usage, EXIT.usage);
  }
  if (opts.stayAwake !== undefined && !(STAY_AWAKE as readonly string[]).includes(opts.stayAwake)) {
    throw new CliError("USAGE", `--stay-awake must be never, plugged_in or always, got "${opts.stayAwake}"`, usage, EXIT.usage);
  }
  if (opts.pause && opts.resume) throw new CliError("USAGE", "--pause and --resume cannot be used together", usage, EXIT.usage);
  if (opts.trust !== undefined && !Object.hasOwn(TRUSTS, opts.trust)) {
    throw new CliError("USAGE", `--trust must be trusted or no-secrets, got "${opts.trust}"; prefer --trusted on|off`, usage, EXIT.usage);
  }
  const trustedFlag = onOff(opts.trusted, "--trusted", usage);
  const fromAlias = opts.trust !== undefined ? TRUSTS[opts.trust] : undefined;
  const fromFlag = trustedFlag === undefined ? undefined : trustedFlag ? "trusted" : "burst";
  if (fromAlias && fromFlag && fromAlias !== fromFlag) throw new CliError("USAGE", "--trusted and --trust disagree; pass only --trusted on|off", usage, EXIT.usage);
  const trust = fromFlag ?? fromAlias;
  const body: Record<string, unknown> = {};
  if (opts.routing !== undefined) body.routing = opts.routing;
  if (opts.pause) body.paused = true;
  if (opts.resume) body.paused = false;
  if (opts.performance !== undefined) body.performance = opts.performance;
  if (opts.comfort !== undefined) body.comfort = opts.comfort;
  if (opts.stayAwake !== undefined) body.stay_awake = opts.stayAwake;
  const idle = onOff(opts.idleOnly, "--idle-only", usage);
  if (idle !== undefined) body.idle_only = idle;
  const plugged = onOff(opts.pluggedInOnly, "--plugged-in-only", usage);
  if (plugged !== undefined) body.plugged_in_only = plugged;
  if (trust !== undefined) body.trust = trust;
  if (opts.repositories !== undefined && (opts.addRepository !== undefined || opts.removeRepository !== undefined)) {
    throw new CliError("USAGE", "--repositories replaces the list: pass it, or --add-repository and --remove-repository, not both", usage, EXIT.usage);
  }
  if (opts.repositories !== undefined) body.repositories = opts.repositories.trim() === "all" ? [] : repositoryList(opts.repositories, "--repositories", usage);
  if (opts.addRepository !== undefined) body.add_repositories = repositoryList(opts.addRepository, "--add-repository", usage);
  if (opts.removeRepository !== undefined) body.remove_repositories = repositoryList(opts.removeRepository, "--remove-repository", usage);
  if (Object.keys(body).length === 0) {
    throw new CliError("USAGE", "nothing to change: pass --routing, --pause, --resume, --performance, --comfort, --stay-awake, --idle-only, --plugged-in-only, --trusted or --repositories", usage, EXIT.usage);
  }
  const flags = Object.entries({ routing: opts.routing, performance: opts.performance, comfort: opts.comfort, "stay-awake": opts.stayAwake, "idle-only": opts.idleOnly, "plugged-in-only": opts.pluggedInOnly, trusted: trust === undefined ? undefined : trust === "trusted" })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` --${k} ${String(v === true ? "on" : v === false ? "off" : v)}`)
    .join("");
  const repoFlags = Object.entries({ repositories: opts.repositories, "add-repository": opts.addRepository, "remove-repository": opts.removeRepository })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` --${k} ${String(v)}`)
    .join("");
  const base = `buildhound runner set --machine ${opts.machine} --org ${opts.org}${opts.pause ? " --pause" : ""}${opts.resume ? " --resume" : ""}${flags}${repoFlags}`;
  const api = ApiClient.forCommand(opts, base);
  const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(opts.org)}`, undefined, base);
  const found = (list.machines ?? []).find((m) => m.id === opts.machine || m.name === opts.machine);
  if (!found || typeof found.id !== "string") throw new CliError("NOT_FOUND", `no machine named ${opts.machine} in ${opts.org}`, `buildhound runner status --org ${opts.org}`, EXIT.usage);
  // A trusted machine receives jobs that carry secrets: only a person may mark one (CLAUDE.md rule 19), and its disk must
  // be encrypted. Turning trusted off (the No secrets tier, stored as burst) is always allowed, since it only takes jobs away.
  if (trust === "trusted") {
    const blocked = await trustGate(opts as RunnerSetOptions & { machine: string; org: string }, { id: found.id, name: typeof found.name === "string" ? found.name : opts.machine, os: typeof found.os === "string" ? found.os : "macos", reported: typeof found.disk_encrypted === "boolean" ? found.disk_encrypted : null }, api);
    if (blocked) return blocked;
  }
  const path = `/v1/machines/${encodeURIComponent(found.id)}`;
  // The control plane holds a trust-on until a person approves it in the dashboard and applies nothing else from that
  // request (SECURITY.md, Where the person check lives), so the other settings go first and trust alone after them.
  const first = { ...body };
  if (trust === "trusted") delete first.trust;
  let patched = Object.keys(first).length ? await api.request<Patched>("PATCH", path, first, base) : null;
  // A repository the GitHub App does not cover yet: only a person can add it, on GitHub.
  if (patched?.kind === "needs_human") return { status: "needs_human", reason: patched.body.reason, url: patched.body.url, next: patched.body.next };
  let changed = patched?.kind === "ok" && patched.body.changed;
  if (trust === "trusted") {
    const asked = await api.request<Patched>("PATCH", path, { trust: "trusted" }, base);
    if (asked.kind === "needs_human") {
      const approved = asked.body.reason === "trust_needs_person" && atTerminal() && !wantsJson(opts) ? await waitForApproval(api, opts.org, found.id, asked.body.url) : false;
      if (!approved) return { status: "needs_human", reason: asked.body.reason, url: asked.body.url, next: asked.body.next };
      // Approved: the machine is trusted now, so asking again answers with it and changes nothing more.
      patched = await api.request<Patched>("PATCH", path, { trust: "trusted" }, base);
      if (patched.kind === "needs_human") return { status: "needs_human", reason: patched.body.reason, url: patched.body.url, next: patched.body.next };
      changed = true;
    } else {
      patched = asked;
      changed ||= asked.body.changed;
    }
  }
  const r = patched!.body as Patched;
  return {
    status: changed ? "updated" : "unchanged",
    machine: r.machine,
    settings: r.policy,
    ...(r.repositories !== undefined ? { repositories: r.repositories } : {}),
    ...(r.repository_filter !== undefined ? { repository_filter: r.repository_filter } : {}),
    owner: opts.org,
    failover: r.failover,
    next: `buildhound runner status --org ${opts.org}`,
  };
}

/** Whether a terminal is here for the person: questions and `sudo fdesetup enable` need one. */
const atTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * At a terminal: the person approves the trust change in the dashboard (SECURITY.md, Where the person check lives), and
 * the command waits, up to the request's ten minutes, until the control plane says the machine is trusted.
 */
async function waitForApproval(api: ApiClient, org: string, id: string, url: string): Promise<boolean> {
  const say = (line: string) => process.stderr.write(`${line}\n`);
  for (const line of needed("A person approves this in the dashboard, signed in as an admin of " + org + ":", url)) say(line);
  say(color.dim("  Waiting for the approval, up to 10 minutes"));
  const trusted = async () => {
    const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(org)}`, undefined, `buildhound runner status --org ${org}`);
    return (list.machines ?? []).some((m) => m.id === id && m.trust === "trusted");
  };
  return pollUntil(trusted, 10 * 60_000, 3_000);
}

/**
 * Before a person marks a machine Trusted: its disk must be encrypted (SECURITY.md, Secrets). On this machine the disk is
 * read here, and at a terminal on a Mac with FileVault off the person is offered to turn it on (trust-step.ts); another
 * machine answers from its last heartbeat. Null when the disk is not known to be off, so the control plane decides;
 * otherwise the `needs_human` answer, with `blocked_by`. The person's approval itself happens in the dashboard.
 */
async function trustGate(opts: RunnerSetOptions & { machine: string; org: string }, m: { id: string; name: string; os: string; reported: boolean | null }, api: ApiClient, io?: TrustIO): Promise<RunnerSetNeedsHuman | null> {
  const local = readAgentConfig();
  const here = local !== null && (local.machine_id === m.id || local.machine_name === m.name);
  const encrypted = here ? await readEncryption(m.os, systemExec) : m.reported;
  const answer = (now: boolean | null) => trustNeedsHuman({ owner: opts.org, machine: opts.machine, os: m.os, encrypted: now, apiUrl: api.baseUrl });
  if (encrypted === false) {
    if (!here || !atTerminal()) return answer(false);
    const reported = async () => {
      const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(opts.org)}`, undefined, `buildhound runner status --org ${opts.org}`);
      return (list.machines ?? []).some((x) => x.id === m.id && x.disk_encrypted === true);
    };
    const terminal = io ?? terminalIO(() => readEncryption(m.os, systemExec), () => pollUntil(reported));
    if (!(await ensureEncryption({ owner: opts.org, machine: opts.machine, os: m.os }, terminal, false))) return answer(await readEncryption(m.os, systemExec));
  }
  return null;
}

const MEANING: Record<string, string> = {
  primary: "takes jobs whenever it can",
  backup: "takes jobs only when no primary can",
  off: "stays connected and visible but takes no jobs",
};

/** "Serves benyd/app and benyd/site", or every repository; with the change still on its way when pending. */
export function servesLine(f: RepositoryFilter | null | undefined, served: string[] | undefined): string | null {
  if (f) {
    const what = f.all ? "every repository the Buildhound app covers" : f.repositories.join(", ");
    return f.pending ? `Will serve ${what} after its next check-in` : `Serves ${what}`;
  }
  return served && served.length ? `Serves ${served.join(", ")}` : null;
}

export function prettyRunnerSet(r: RunnerSetResult | RunnerSetNeedsHuman): string {
  if (r.status === "needs_human" && r.reason === "repository_not_in_app") return [...needed("Add the repository to the Buildhound app on GitHub first:", r.url), "", r.next].join("\n");
  if (r.status === "needs_human" && r.blocked_by === "filevault_off") return [...needed(`FileVault is off on this Mac. ${ENCRYPTION_WHY}`, "sudo fdesetup enable", `then ${r.next.replace(/^.* then runs (.*) there, or opens the url$/, "$1")}`), "", `Or on the dashboard: ${r.url}`].join("\n");
  if (r.status === "needs_human" && r.blocked_by) return [...needed(`Disk encryption is off on this machine. ${ENCRYPTION_WHY}`), "", `More: ${r.next.replace(/^.*\((https:[^)]+)\).*$/, "$1")}`].join("\n");
  if (r.status === "needs_human" && !r.next.startsWith("a person runs ")) return [...needed("A person approves marking it Trusted in the dashboard, within 10 minutes:", r.url)].join("\n");
  if (r.status === "needs_human") return [...needed("A person marks a machine Trusted, at a terminal or on the dashboard:", r.next.replace(/^a person runs (.*) in a terminal, or opens the url$/, "$1"), r.url)].join("\n");
  const s = r.settings;
  const trust = r.machine.trust ? `, ${r.machine.trust === "trusted" ? "trusted (takes jobs that use secrets)" : "no secrets (takes only jobs that use no secrets)"}` : "";
  const state = `${s.paused ? "Paused" : "Taking jobs"}, ${s.performance ?? "balanced"} performance${s.comfort === "adaptive" ? ", adaptive comfort" : ""}${s.idle_only ? ", only when not in use" : ""}${s.plugged_in_only ? ", only when plugged in" : ""}, ${STAY_AWAKE_WORDS[s.stay_awake ?? "plugged_in"] ?? STAY_AWAKE_WORDS.plugged_in}`;
  const head = `${r.machine.name} is ${r.machine.routing}: ${MEANING[r.machine.routing] ?? r.machine.routing}${trust}`;
  const serves = servesLine(r.repository_filter, r.repositories);
  return [r.status === "updated" ? done(head) : head, `  ${state}`, ...(serves ? [`  ${serves}`] : []), color.dim(r.status === "updated" ? "  The machine picks up the change within 30 seconds." : "  Nothing changed."), "", next(r.next)].join("\n");
}

export function runnerSetCommand(): Command {
  return new Command("set")
    .description("Change a machine's routing and settings: pause, performance mode, comfort, stay awake, only when not in use or plugged in, trusted, repositories")
    .requiredOption("--machine <id|name>", "machine id or name")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .option("--routing <role>", "primary (default), backup (only when no primary can) or off")
    .option("--pause", "stop taking new jobs; running jobs finish")
    .option("--resume", "take jobs again")
    .option("--performance <mode>", "quiet, balanced or max")
    .option("--comfort <mode>", "adaptive eases a running job off before refusing new ones, or off")
    .option("--stay-awake <when>", "hold off idle sleep between jobs: never, plugged_in (on mains power only, the default) or always; closing the lid still sleeps a laptop unless an external display is connected")
    .option("--idle-only <on|off>", "only when not in use: take jobs only while nobody is using the machine")
    .option("--plugged-in-only <on|off>", "take jobs only while plugged in")
    .option("--trusted <on|off>", "on takes jobs that use secrets (a person approves it in the dashboard); off takes only jobs that use no secrets")
    .addOption(new Option("--trust <tier>", "alias for --trusted: trusted or no-secrets").hideHelp())
    .option("--repositories <list>", "personal accounts: serve only these repositories (owner/name, comma separated), or all")
    .option("--add-repository <list>", "personal accounts: also serve these repositories (owner/name, comma separated)")
    .option("--remove-repository <list>", "personal accounts: stop serving these repositories")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerSetOptions) => {
      emit(await runRunnerSet(opts), opts, prettyRunnerSet);
    });
}
