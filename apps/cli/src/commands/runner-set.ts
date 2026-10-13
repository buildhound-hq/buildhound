import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirmPerson } from "../lib/confirm";
import { CliError, emit } from "../output";

export interface RunnerSetOptions {
  machine?: string | undefined;
  org?: string | undefined;
  routing?: string | undefined;
  pause?: boolean | undefined;
  resume?: boolean | undefined;
  performance?: string | undefined;
  idleOnly?: string | boolean | undefined;
  pluggedInOnly?: string | boolean | undefined;
  trust?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface MachineSettings {
  paused: boolean;
  idle_only: boolean;
  plugged_in_only: boolean;
  performance?: string;
  changed_at?: string;
}

export interface RunnerSetResult {
  status: "updated" | "unchanged";
  machine: { id: string; name: string; routing: string; trust?: string };
  settings: MachineSettings;
  owner: string;
  failover: Record<string, unknown>;
  next: string;
}

/** Marking a machine trusted needs a person at a terminal (ADR-023); an agent gets this instead. */
export interface RunnerSetNeedsHuman {
  status: "needs_human";
  reason: "trust_needs_a_person";
  url: string;
  next: string;
}

const ROUTINGS = ["primary", "backup", "off"] as const;
const MODES = ["quiet", "balanced", "max"] as const;
const TRUSTS = ["trusted", "burst"] as const;
const TRUST_DOCS = "https://buildhound.sh/docs/trusted-machines";
type Listed = { machines?: Array<{ id?: unknown; name?: unknown }> };
type Patched = { machine: { id: string; name: string; routing: string }; policy: MachineSettings; changed: boolean; failover: Record<string, unknown> };

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
    "buildhound runner set --machine <id|name> --org <login> [--routing primary|backup|off] [--pause | --resume] [--performance quiet|balanced|max] [--idle-only on|off] [--plugged-in-only on|off] [--trust trusted|burst]";
  if (!opts.org || !opts.machine) throw new CliError("USAGE", "--machine and --org are required", usage, EXIT.usage);
  if (opts.routing !== undefined && !(ROUTINGS as readonly string[]).includes(opts.routing)) {
    throw new CliError("USAGE", `--routing must be primary, backup or off, got "${opts.routing}"`, usage, EXIT.usage);
  }
  if (opts.performance !== undefined && !(MODES as readonly string[]).includes(opts.performance)) {
    throw new CliError("USAGE", `--performance must be quiet, balanced or max, got "${opts.performance}"`, usage, EXIT.usage);
  }
  if (opts.pause && opts.resume) throw new CliError("USAGE", "--pause and --resume cannot be used together", usage, EXIT.usage);
  if (opts.trust !== undefined && !(TRUSTS as readonly string[]).includes(opts.trust)) {
    throw new CliError("USAGE", `--trust must be trusted or burst, got "${opts.trust}"`, usage, EXIT.usage);
  }
  const body: Record<string, unknown> = {};
  if (opts.routing !== undefined) body.routing = opts.routing;
  if (opts.pause) body.paused = true;
  if (opts.resume) body.paused = false;
  if (opts.performance !== undefined) body.performance = opts.performance;
  const idle = onOff(opts.idleOnly, "--idle-only", usage);
  if (idle !== undefined) body.idle_only = idle;
  const plugged = onOff(opts.pluggedInOnly, "--plugged-in-only", usage);
  if (plugged !== undefined) body.plugged_in_only = plugged;
  if (opts.trust !== undefined) body.trust = opts.trust;
  if (Object.keys(body).length === 0) {
    throw new CliError("USAGE", "nothing to change: pass --routing, --pause, --resume, --performance, --idle-only, --plugged-in-only or --trust", usage, EXIT.usage);
  }
  // A trusted machine receives jobs that carry secrets: only a person may mark one (CLAUDE.md rule 19).
  // Marking one burst is always allowed, since it only takes jobs away.
  if (opts.trust === "trusted") {
    const command = `buildhound runner set --machine ${opts.machine} --org ${opts.org} --trust trusted`;
    const ok = await confirmPerson(
      `${opts.machine} will take jobs that use secrets, deployment environments and cloud logins. Mark it trusted only if it is a dedicated machine you control, with full-disk encryption on.`,
      opts.machine,
      command,
    );
    if (!ok) return { status: "needs_human", reason: "trust_needs_a_person", url: TRUST_DOCS, next: `a person runs this in a terminal: ${command}` };
  }

  const flags = Object.entries({ routing: opts.routing, performance: opts.performance, "idle-only": opts.idleOnly, "plugged-in-only": opts.pluggedInOnly, trust: opts.trust })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` --${k} ${String(v === true ? "on" : v === false ? "off" : v)}`)
    .join("");
  const base = `buildhound runner set --machine ${opts.machine} --org ${opts.org}${opts.pause ? " --pause" : ""}${opts.resume ? " --resume" : ""}${flags}`;
  const api = ApiClient.forCommand(opts, base);
  const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(opts.org)}`, undefined, base);
  const found = (list.machines ?? []).find((m) => m.id === opts.machine || m.name === opts.machine);
  if (!found || typeof found.id !== "string") throw new CliError("NOT_FOUND", `no machine named ${opts.machine} in ${opts.org}`, `buildhound runner status --org ${opts.org}`, EXIT.usage);
  const r = await api.expect<Patched>("PATCH", `/v1/machines/${encodeURIComponent(found.id)}`, body, base);
  return {
    status: r.changed ? "updated" : "unchanged",
    machine: r.machine,
    settings: r.policy,
    owner: opts.org,
    failover: r.failover,
    next: `buildhound runner status --org ${opts.org}`,
  };
}

const MEANING: Record<string, string> = {
  primary: "takes jobs whenever it can",
  backup: "takes jobs only when no primary can",
  off: "stays connected and visible but takes no jobs",
};

export function prettyRunnerSet(r: RunnerSetResult | RunnerSetNeedsHuman): string {
  if (r.status === "needs_human") return [`A person needs to do this, at a terminal (${r.reason}):`, `  ${r.next.replace(/^a person runs this in a terminal: /, "")}`, "", `More: ${r.url}`].join("\n");
  const s = r.settings;
  const lines = [
    `${r.machine.name} is ${r.machine.routing}: ${MEANING[r.machine.routing] ?? r.machine.routing}${r.machine.trust ? `, ${r.machine.trust === "trusted" ? "trusted (takes jobs with secrets)" : "burst (no jobs with secrets)"}` : ""}`,
    `${s.paused ? "Paused" : "Taking jobs"}, ${s.performance ?? "balanced"} performance${s.idle_only ? ", only when idle" : ""}${s.plugged_in_only ? ", only when plugged in" : ""}`,
  ];
  if (r.status === "updated") lines.push("The machine picks up the change within 30 seconds.");
  else lines.push("Nothing changed.");
  return [...lines, "", `next: ${r.next}`].join("\n");
}

export function runnerSetCommand(): Command {
  return new Command("set")
    .description("Change a machine's routing and settings: pause, performance mode, only when idle or plugged in")
    .requiredOption("--machine <id|name>", "machine id or name")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .option("--routing <role>", "primary (default), backup (only when no primary can) or off")
    .option("--pause", "stop taking new jobs; running jobs finish")
    .option("--resume", "take jobs again")
    .option("--performance <mode>", "quiet, balanced or max")
    .option("--idle-only <on|off>", "take jobs only while nobody is using the machine")
    .option("--plugged-in-only <on|off>", "take jobs only while plugged in")
    .option("--trust <tier>", "trusted (jobs with secrets; a person must confirm at a terminal) or burst")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerSetOptions) => {
      emit(await runRunnerSet(opts), opts, prettyRunnerSet);
    });
}
