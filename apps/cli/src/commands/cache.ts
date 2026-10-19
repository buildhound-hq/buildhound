import { Command } from "commander";
import { EXIT, type ClearCachesResponse, type MachineCachesResponse, type ResetCachesResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { gb } from "../lib/doctor/context";
import { CliError, emit } from "../output";
import { ago, color, count, done, next, table } from "../lib/style";

// The package caches on an account's machines (B08; RUNNERS.md, Package caches on a Mac): `cache list` reads
// what each machine's heartbeat last reported, `cache clear` asks the machines to drop them, and `cache reset` asks
// for the clean slate: every cache, the tool cache and whatever else the cache directory holds. All go through the
// control plane, so they work from anywhere; a clear or reset reaches a machine on its next heartbeat.

export interface CacheOptions {
  org?: string | undefined;
  machine?: string | undefined;
  repository?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

const enc = encodeURIComponent;
/** As `gb`, with a cache of a few files still showing as something. */
const size = (bytes: number): string => (bytes > 0 && bytes < 2 ** 20 ? "under 1 MB" : gb(bytes));
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

/** The scope flags as they were given, so every `next` repeats them. */
function scope(opts: CacheOptions): string {
  return [`--org ${opts.org}`, opts.machine ? `--machine ${opts.machine}` : "", opts.repository ? `--repository ${opts.repository}` : ""].filter(Boolean).join(" ");
}

function checkUsage(opts: CacheOptions, command: "list" | "clear" | "reset"): string {
  const example = `buildhound cache ${command} --org <login>${command === "list" ? "" : " --yes"}`;
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user that owns the machines", example, EXIT.usage);
  if (opts.repository !== undefined && !REPOSITORY.test(opts.repository)) throw new CliError("USAGE", `--repository must be owner/name, not ${opts.repository}`, `buildhound cache ${command} --org ${opts.org} --repository <owner/name>`, EXIT.usage);
  return opts.org;
}

type Listed = { machines?: Array<{ id?: unknown; name?: unknown }> };

/** The account's machines, or the one `--machine` names by id or name. */
export async function machinesOf(api: ApiClient, org: string, machine: string | undefined, retry: string): Promise<Array<{ id: string; name: string }>> {
  const list = await api.expect<Listed>("GET", `/v1/machines?owner=${enc(org)}`, undefined, retry);
  const all = (list.machines ?? []).flatMap((m) => (typeof m.id === "string" ? [{ id: m.id, name: typeof m.name === "string" ? m.name : m.id }] : []));
  if (machine) {
    const found = all.filter((m) => m.id === machine || m.name === machine);
    if (!found.length) throw new CliError("NOT_FOUND", `no machine named ${machine} in ${org}`, `buildhound runner status --org ${org}`, EXIT.usage);
    return found;
  }
  if (!all.length) throw new CliError("NOT_FOUND", `no machines are connected to ${org}`, `buildhound runner add --org ${org}`, EXIT.usage);
  return all;
}

export type MachineCaches = Omit<MachineCachesResponse, "next">;

export interface CacheListResult {
  owner: string;
  repository: string | null;
  machines: MachineCaches[];
  /** Every listed machine's caches together, over the machines that reported. */
  bytes: number;
  next: string;
}

export async function runCacheList(opts: CacheOptions): Promise<CacheListResult> {
  const owner = checkUsage(opts, "list");
  const retry = `buildhound cache list ${scope(opts)}`;
  const api = ApiClient.forCommand(opts, retry);
  const machines: MachineCaches[] = [];
  for (const m of await machinesOf(api, owner, opts.machine, retry)) {
    const c = await api.expect<MachineCachesResponse>("GET", `/v1/machines/${enc(m.id)}/caches`, undefined, retry);
    // The agent keeps repository names in lower case.
    const repositories = opts.repository ? c.repositories.filter((r) => r.repository.toLowerCase() === opts.repository!.toLowerCase()) : c.repositories;
    machines.push({ machine: c.machine, reported_at: c.reported_at, bytes: c.bytes, limit_bytes: c.limit_bytes, repositories, pending_clear: c.pending_clear });
  }
  const bytes = machines.reduce((n, m) => n + (opts.repository ? m.repositories.reduce((s, r) => s + r.bytes, 0) : (m.bytes ?? 0)), 0);
  const anything = machines.some((m) => m.repositories.length > 0);
  return { owner, repository: opts.repository ?? null, machines, bytes, next: anything ? `buildhound cache clear ${scope(opts)} --yes` : `buildhound runner status --org ${owner}` };
}

export function prettyCacheList(r: CacheListResult): string {
  const out: string[] = [];
  for (const m of r.machines) {
    if (out.length) out.push("");
    if (m.reported_at === null) {
      out.push(`${m.machine.name}  ${color.dim("No cache sizes reported yet. They come with Buildhound agent 0.1.35.")}`);
      continue;
    }
    const of = m.limit_bytes ? ` of ${gb(m.limit_bytes)}` : "";
    out.push(`${m.machine.name}  ${size(m.bytes ?? 0)}${of}  ${color.dim(`reported ${ago(m.reported_at)}`)}`);
    if (m.pending_clear?.reset) out.push(color.dim(`  Reset requested ${ago(m.pending_clear.requested_at)}. It applies within 30 seconds.`));
    else if (m.pending_clear) out.push(color.dim(`  Clear requested ${ago(m.pending_clear.requested_at)} for ${m.pending_clear.repository ?? "every repository"}. It applies within 30 seconds.`));
    if (!m.repositories.length) {
      out.push(color.dim(r.repository ? `  No cache for ${r.repository}.` : "  No caches yet."));
      continue;
    }
    out.push("", ...table(["REPOSITORY", "SIZE", "LAST USED"], m.repositories.map((x) => [x.repository, size(x.bytes), x.in_use ? "in use" : ago(x.last_used_at)]), { right: [1] }));
  }
  return [`Package caches on ${count(r.machines.length, "machine")} for ${r.owner}`, "", ...out, "", next(r.next)].join("\n");
}

export interface CacheClearResult {
  status: "requested";
  owner: string;
  /** The repository asked for, or null for every repository. */
  repository: string | null;
  machines: Array<{ id: string; name: string; requested_at: string }>;
  next: string;
}

export async function runCacheClear(opts: CacheOptions): Promise<CacheClearResult> {
  const owner = checkUsage(opts, "clear");
  const base = `buildhound cache clear ${scope(opts)}`;
  const what = opts.repository ? `${opts.repository}'s package caches` : "every repository's package caches";
  await confirm(opts.yes, `Clear ${what} on ${opts.machine ?? `every machine of ${owner}`}? Jobs download those packages again next time.`, base);
  const api = ApiClient.forCommand(opts, `${base} --yes`);
  const machines: CacheClearResult["machines"] = [];
  for (const m of await machinesOf(api, owner, opts.machine, `${base} --yes`)) {
    const r = await api.expect<ClearCachesResponse>("POST", `/v1/machines/${enc(m.id)}/caches/clear`, opts.repository ? { repository: opts.repository } : {}, `${base} --yes`);
    machines.push({ id: r.machine.id, name: r.machine.name, requested_at: r.requested_at });
  }
  return { status: "requested", owner, repository: opts.repository ?? null, machines, next: `buildhound cache list ${scope(opts)}` };
}

export function prettyCacheClear(r: CacheClearResult): string {
  const what = r.repository ? `${r.repository}'s caches` : "every repository's caches";
  return [
    done(`Clear requested for ${what} on ${r.machines.map((m) => m.name).join(", ")}`),
    color.dim("  Each machine clears on its next check-in, within 30 seconds. A cache a running job uses goes when that job ends."),
    "",
    next(r.next),
  ].join("\n");
}

export interface CacheResetResult {
  status: "requested";
  owner: string;
  machines: Array<{ id: string; name: string; requested_at: string }>;
  next: string;
}

/**
 * The clean slate for when a machine's caches are in a bad state: every repository's caches, the tool cache and
 * anything else in the machine's cache directory go, so every job starts cold once. `cache clear --repository` drops
 * one repository's instead.
 */
export async function runCacheReset(opts: CacheOptions): Promise<CacheResetResult> {
  const owner = checkUsage(opts, "reset");
  const base = `buildhound cache reset ${scope(opts)}`;
  await confirm(opts.yes, `Reset the caches on ${opts.machine ?? `every machine of ${owner}`}? Every repository's package caches and the tool cache go, and the next jobs download everything again.`, base);
  const api = ApiClient.forCommand(opts, `${base} --yes`);
  const machines: CacheResetResult["machines"] = [];
  for (const m of await machinesOf(api, owner, opts.machine, `${base} --yes`)) {
    const r = await api.expect<ResetCachesResponse>("POST", `/v1/machines/${enc(m.id)}/caches/reset`, undefined, `${base} --yes`);
    machines.push({ id: r.machine.id, name: r.machine.name, requested_at: r.requested_at });
  }
  return { status: "requested", owner, machines, next: `buildhound cache list ${scope(opts)}` };
}

export function prettyCacheReset(r: CacheResetResult): string {
  return [
    done(`Reset requested on ${r.machines.map((m) => m.name).join(", ")}`),
    color.dim("  Each machine resets on its next check-in, within 30 seconds. A cache a running job uses goes when that job ends."),
    "",
    next(r.next),
  ].join("\n");
}

function common(cmd: Command): Command {
  return cmd
    .option("--org <login>", "GitHub organisation or user that owns the machines")
    .option("--machine <id|name>", "only this machine; default every machine of the account")
    .option("--repository <owner/name>", "only this repository's caches; default every repository")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output");
}

export function cacheCommand(): Command {
  const cache = new Command("cache").description("See, clear and reset the package caches on your machines");
  cache.addCommand(
    common(new Command("list").alias("status").description("What the package caches take on each machine, as its last check-in reported")).action(async (opts: CacheOptions) => {
      emit(await runCacheList(opts), opts, prettyCacheList);
    }),
  );
  cache.addCommand(
    common(new Command("clear").description("Clear the package caches on your machines; jobs download those packages again next time"))
      .option("--yes", "clear without asking; required when there is no TTY")
      .action(async (opts: CacheOptions) => {
        emit(await runCacheClear(opts), opts, prettyCacheClear);
      }),
  );
  cache.addCommand(
    new Command("reset")
      .description("Start the caches over on your machines: every repository's, the tool cache and anything else in the cache folder")
      .option("--org <login>", "GitHub organisation or user that owns the machines")
      .option("--machine <id|name>", "only this machine; default every machine of the account")
      .option("--api-url <url>", "control plane URL")
      .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
      .option("--json", "JSON output")
      .option("--yes", "reset without asking; required when there is no TTY")
      .action(async (opts: CacheOptions) => {
        emit(await runCacheReset(opts), opts, prettyCacheReset);
      }),
  );
  return cache;
}
