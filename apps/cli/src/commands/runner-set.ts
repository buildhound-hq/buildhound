import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";

export interface RunnerSetOptions {
  machine?: string | undefined;
  org?: string | undefined;
  routing?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface RunnerSetResult {
  status: "updated" | "unchanged";
  machine: { id: string; name: string; routing: string };
  owner: string;
  failover: Record<string, unknown>;
  next: string;
}

const ROUTINGS = ["primary", "backup", "off"] as const;
type Listed = { machines?: Array<{ id?: unknown; name?: unknown }> };
type Patched = { machine: { id: string; name: string; routing: string }; changed: boolean; failover: Record<string, unknown> };

/** Sets whether a machine takes jobs first, only as a backup, or never. Idempotent; reversible, so no --yes. */
export async function runRunnerSet(opts: RunnerSetOptions): Promise<RunnerSetResult> {
  const usage = "buildhound runner set --machine <id|name> --org <login> --routing primary|backup|off";
  if (!opts.org || !opts.machine || !opts.routing) throw new CliError("USAGE", "--machine, --org and --routing are required", usage, EXIT.usage);
  if (!(ROUTINGS as readonly string[]).includes(opts.routing)) {
    throw new CliError("USAGE", `--routing must be primary, backup or off, got "${opts.routing}"`, usage, EXIT.usage);
  }
  const base = `buildhound runner set --machine ${opts.machine} --org ${opts.org} --routing ${opts.routing}`;
  const api = ApiClient.forCommand(opts, base);
  const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(opts.org)}`, undefined, base);
  const found = (list.machines ?? []).find((m) => m.id === opts.machine || m.name === opts.machine);
  if (!found || typeof found.id !== "string") throw new CliError("NOT_FOUND", `no machine named ${opts.machine} in ${opts.org}`, `buildhound runner status --org ${opts.org}`, EXIT.usage);
  const r = await api.expect<Patched>("PATCH", `/v1/machines/${encodeURIComponent(found.id)}`, { routing: opts.routing }, base);
  return {
    status: r.changed ? "updated" : "unchanged",
    machine: r.machine,
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

export function prettyRunnerSet(r: RunnerSetResult): string {
  return [`${r.machine.name} is ${r.machine.routing}: ${MEANING[r.machine.routing] ?? r.machine.routing}.${r.status === "unchanged" ? " (unchanged)" : ""}`, "", `next: ${r.next}`].join("\n");
}

export function runnerSetCommand(): Command {
  return new Command("set")
    .description("Choose how a machine is routed: primary (default), backup (only when no primary can) or off")
    .requiredOption("--machine <id|name>", "machine id or name")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .requiredOption("--routing <role>", "primary, backup or off")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerSetOptions) => {
      emit(await runRunnerSet(opts), opts, prettyRunnerSet);
    });
}
