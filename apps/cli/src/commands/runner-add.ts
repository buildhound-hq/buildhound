import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import type { NeedsHuman } from "@buildhound/shared";
import { agentVersion, installAgentBinary, locateAgentBinary } from "../lib/agent-binary";
import { agentHome, agentLogPath, readAgentConfig, writeAgentConfig, writeDefaultPolicy } from "../lib/agent-home";
import type { AgentConfig, ScaleSet } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { defaultCapacity, detectHost, labelsFor, vmSizeFor } from "../lib/host";
import { installService } from "../lib/service";
import type { ServiceExecutor } from "../lib/service";
import { CliError, emit } from "../output";

export interface RunnerAddOptions {
  org?: string | undefined;
  label?: string | undefined;
  name?: string | undefined;
  capacity?: string | number | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
  agentBinary?: string | undefined;
  dogfoodHostMode?: boolean | undefined;
}

export interface AddStep {
  step: "detect_host" | "register" | "write_config" | "write_policy" | "install_agent" | "install_service";
  status: "done" | "skipped" | "needs_human";
  detail: string;
}

export interface RegisterResponse {
  machine: { id: string; name: string; labels: string[]; capacity: number; status: string };
  machine_token: string;
  scale_sets: ScaleSet[];
  github: { scope: "org" | "repo"; owner: string; repositories: string[] };
  next?: string;
}

export interface RunnerAddResult {
  status: "ready";
  machine: string;
  machine_id: string;
  owner: string;
  label: string;
  scale_sets: ScaleSet[];
  capacity: number;
  os: string;
  arch: string;
  agent_version: string;
  github: RegisterResponse["github"];
  service: string;
  config: string;
  steps: AddStep[];
  next: string;
}

export type RunnerAddOutput = RunnerAddResult | (NeedsHuman & { steps: AddStep[] });

function parseCapacity(v: string | number | undefined, fallback: number, next: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new CliError("USAGE", `--capacity must be a whole number from 1 to 64, got "${v}"`, next, EXIT.usage);
  return n;
}

/** Connect this machine. Every step is idempotent and reported; the function is pure apart from the files it documents. */
export async function runRunnerAdd(opts: RunnerAddOptions, exec?: ServiceExecutor): Promise<RunnerAddOutput> {
  if (!opts.org) throw new CliError("USAGE", "--org <login> is required: the GitHub organisation or user that owns the machine", "buildhound runner add --org <login> --label macos --yes", EXIT.usage);
  const base = `buildhound runner add --org ${opts.org} --label ${opts.label ?? "macos"}`;
  const steps: AddStep[] = [];

  const host = detectHost(base);
  const labels = labelsFor(opts.label, host, base);
  const label = labels.join(",");
  const name = (opts.name || host.hostname).trim();
  const capacity = parseCapacity(opts.capacity, defaultCapacity(host), base);
  steps.push({ step: "detect_host", status: "done", detail: `${host.os} ${host.arch}, ${host.cpu_cores} cores, ${host.memory_gb} GB, hostname ${host.hostname}` });

  await confirm(opts.yes, `Connect ${name} to ${opts.org} as a ${label} runner?`, base);

  const source = await locateAgentBinary(opts.agentBinary, host, base);
  const version = agentVersion(source.path);
  const api = ApiClient.forCommand(opts, base);

  const existing = readAgentConfig();
  const r = await api.request<RegisterResponse>(
    "POST",
    "/v1/machines",
    { owner: opts.org, name, os: host.os, arch: host.arch, cpu_cores: host.cpu_cores, memory_gb: host.memory_gb, labels, capacity, isolation: "vm", agent_version: version },
    `${base} --yes`,
  );
  if (r.kind === "needs_human") {
    steps.push({ step: "register", status: "needs_human", detail: r.body.reason });
    return { ...r.body, next: r.body.next || `${base} --yes`, steps };
  }
  const reg = r.body;
  if (!reg?.machine?.id || !reg.machine_token) throw new CliError("API_ERROR", "the control plane answered without a machine id and token", `${base} --yes`, EXIT.network);
  steps.push({ step: "register", status: r.status === 200 ? "skipped" : "done", detail: r.status === 200 ? `already registered as ${reg.machine.name} (${reg.machine.id})` : `registered as ${reg.machine.name} (${reg.machine.id})` });

  const sameMachine = existing?.machine_id === reg.machine.id;
  const config: AgentConfig = {
    machine_id: reg.machine.id,
    machine_name: reg.machine.name,
    machine_token: reg.machine_token,
    api_url: api.baseUrl,
    owner: opts.org,
    scale_sets: reg.scale_sets ?? [],
    os: host.os,
    arch: host.arch,
    capacity: opts.capacity !== undefined ? capacity : (reg.machine.capacity ?? capacity),
    dogfood_host_mode: Boolean(opts.dogfoodHostMode) || Boolean(sameMachine && existing?.dogfood_host_mode),
    ...(sameMachine && existing?.repositories ? { repositories: existing.repositories } : {}),
    vm: sameMachine && existing?.vm ? existing.vm : vmSizeFor(host),
  };
  const configPath = `${agentHome()}/agent.json`;
  const changed = writeAgentConfig(config);
  steps.push({ step: "write_config", status: changed ? "done" : "skipped", detail: changed ? `${configPath} written (mode 0600)${existing && existing.machine_id !== config.machine_id ? `, replaced ${existing.machine_id}` : ""}` : `${configPath} unchanged` });
  const policy = writeDefaultPolicy(host.has_battery);
  steps.push({ step: "write_policy", status: policy.written ? "done" : "skipped", detail: policy.written ? (host.has_battery ? "laptop detected: jobs run only when plugged in; change it from the menu bar" : "no restrictions") : "existing policy kept" });

  const installed = installAgentBinary(source);
  steps.push({ step: "install_agent", status: installed.changed ? "done" : "skipped", detail: installed.changed ? `copied from ${source.origin} (${source.path}) to ${installed.path}` : `${installed.path} already installed (${source.origin})` });

  const service = installService({ os: host.os, binary: installed.path, home: agentHome(), logPath: agentLogPath() }, exec);
  steps.push({ step: "install_service", status: service.status, detail: service.detail });

  return {
    status: "ready",
    machine: reg.machine.name,
    machine_id: reg.machine.id,
    owner: opts.org,
    label,
    scale_sets: reg.scale_sets ?? [],
    capacity: config.capacity,
    os: host.os,
    arch: host.arch,
    agent_version: version,
    github: reg.github,
    service: service.detail,
    config: configPath,
    steps,
    next: reg.next || `buildhound runner status --org ${opts.org}`,
  };
}

export function prettyRunnerAdd(r: RunnerAddOutput): string {
  const lines: string[] = [];
  if (r.status === "needs_human") {
    lines.push(`A person needs to finish one step (${r.reason}):`, `  ${r.url}`, "", `then run: ${r.next}`);
    return lines.join("\n");
  }
  lines.push(`${r.machine} is connected to ${r.owner} as ${r.label} (capacity ${r.capacity}, agent ${r.agent_version})`);
  for (const s of r.steps) lines.push(`  ${s.status.padEnd(7)} ${s.step.padEnd(16)} ${s.detail}`);
  lines.push(`  scale sets: ${r.scale_sets.map((s) => s.name).join(", ") || "none"}`, "", `next: ${r.next}`);
  return lines.join("\n");
}

export function runnerAddCommand(): Command {
  const cmd = new Command("add")
    .description("Connect this machine as a single-use runner: register, write ~/.buildhound/agent.json, install and start the agent")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .requiredOption("--label <os>", "what the machine runs: macos, linux, or macos,linux on a Mac")
    .option("--name <machine>", "machine name; defaults to the hostname")
    .option("--capacity <n>", "jobs at once; default 1 on laptops, Linux and Macs under 16 GB, else 2")
    .option("--api-url <url>", "control plane URL; else BUILDHOUND_API_URL, API_URL, https://api.buildhound.sh")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--agent-binary <path>", "use this buildhound-agent binary instead of locating or downloading one")
    .option("--yes", "connect without asking; required when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: RunnerAddOptions) => {
      emit(await runRunnerAdd(opts), opts, prettyRunnerAdd);
    });
  cmd.addOption(cmd.createOption("--dogfood-host-mode", "run jobs on the host without a VM (dogfood only)").hideHelp());
  return cmd;
}
