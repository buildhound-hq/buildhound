import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { removeService } from "../lib/service";
import type { ServiceExecutor } from "../lib/service";
import { CliError, emit } from "../output";
import { color, done, next } from "../lib/style";

export interface RunnerRemoveOptions {
  machine?: string | undefined;
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export interface RunnerRemoveResult {
  status: "removed";
  machine: { id: string; name: string };
  owner: string;
  local: boolean;
  service: string;
  config_kept: string | null;
  deleted_after: string;
  next: string;
}

type Listed = { machines?: Array<{ id?: unknown; name?: unknown }> };

export async function runRunnerRemove(opts: RunnerRemoveOptions, exec?: ServiceExecutor): Promise<RunnerRemoveResult> {
  if (!opts.org || !opts.machine) throw new CliError("USAGE", "--machine <id|name> and --org <login> are required", "buildhound runner remove --machine <id|name> --org <login> --yes", EXIT.usage);
  const base = `buildhound runner remove --machine ${opts.machine} --org ${opts.org}`;
  await confirm(opts.yes, `Remove ${opts.machine} from ${opts.org}? New jobs route to the healthy side; the registration is kept 48 hours.`, base);
  const api = ApiClient.forCommand(opts, base);
  const list = await api.expect<Listed>("GET", `/v1/machines?owner=${encodeURIComponent(opts.org)}`, undefined, `${base} --yes`);
  const found = (list.machines ?? []).find((m) => m.id === opts.machine || m.name === opts.machine);
  if (!found || typeof found.id !== "string") throw new CliError("NOT_FOUND", `no machine named ${opts.machine} in ${opts.org}`, `buildhound runner status --org ${opts.org}`, EXIT.usage);
  const id = found.id;
  const name = typeof found.name === "string" ? found.name : id;
  await api.expect<unknown>("DELETE", `/v1/machines/${encodeURIComponent(id)}`, undefined, `${base} --yes`);

  const config = readAgentConfig();
  const local = config?.machine_id === id;
  let service = "not this machine";
  if (local && config) service = removeService(config.os, exec).detail;
  const deletedAfter = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  return {
    status: "removed",
    machine: { id, name },
    owner: opts.org,
    local,
    service,
    config_kept: local ? `${process.env.BUILDHOUND_AGENT_HOME || "~/.buildhound"}/agent.json` : null,
    deleted_after: deletedAfter,
    next: `buildhound runner status --org ${opts.org}`,
  };
}

export function prettyRunnerRemove(r: RunnerRemoveResult): string {
  return [
    done(`${r.machine.name} removed from ${r.owner}; new jobs route to the healthy side`),
    color.dim(`  The registration is deleted after ${r.deleted_after.slice(0, 16).replace("T", " ")} UTC. Service: ${r.service}.${r.config_kept ? ` Kept ${r.config_kept}.` : ""}`),
    "",
    next(r.next),
  ].join("\n");
}

export function runnerRemoveCommand(): Command {
  return new Command("remove")
    .description("Deregister a machine (kept 48 hours) and stop the local agent when it is this machine")
    .requiredOption("--machine <id|name>", "machine id or name")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--yes", "remove without asking; required when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: RunnerRemoveOptions) => {
      emit(await runRunnerRemove(opts), opts, prettyRunnerRemove);
    });
}
