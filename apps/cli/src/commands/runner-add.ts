import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import type { NeedsHuman } from "@buildhound/shared";
import { agentVersion, installAgentBinary, locateAgentBinary } from "../lib/agent-binary";
import { agentHome, agentLogPath, readAgentConfig, writeAgentConfig, writeDefaultPolicy } from "../lib/agent-home";
import type { AgentConfig, ScaleSet } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { defaultCapacity, detectHost, labelsFor } from "../lib/host";
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
  repositories?: string | undefined;
  vmCpus?: string | number | undefined;
  vmMemoryMib?: string | number | undefined;
  macosAtOnce?: string | number | undefined;
  vmNetwork?: string | undefined;
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
  capacity: number | "auto";
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

/** `--repositories owner/a,owner/b`: the repositories this machine serves on a personal account. */
function parseRepositories(v: string, next: string): string[] {
  const list = v.split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of list) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new CliError("USAGE", `--repositories takes owner/name entries separated by commas, got "${r}"`, next, EXIT.usage);
  }
  return list;
}

/**
 * VM sizes are worked out by the agent from the machine it runs on (speed first). --vm-cpus,
 * --vm-memory-mib and --macos-at-once pin them; a pin already in agent.json is kept, and `auto`
 * removes it so the agent decides again.
 */
function vmSettings(existing: AgentConfig["vm"], opts: RunnerAddOptions, next: string): { vm?: NonNullable<AgentConfig["vm"]> } {
  const vm = { ...(existing ?? {}) };
  if (opts.vmCpus === "auto") delete vm.cpus;
  else if (opts.vmCpus !== undefined) {
    const n = Number(opts.vmCpus);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new CliError("USAGE", `--vm-cpus must be a whole number from 1 to 64, got "${opts.vmCpus}"`, next, EXIT.usage);
    vm.cpus = n;
  }
  if (opts.vmMemoryMib === "auto") delete vm.memory_mib;
  else if (opts.vmMemoryMib !== undefined) {
    const n = Number(opts.vmMemoryMib);
    if (!Number.isInteger(n) || n < 2048 || n > 262144) throw new CliError("USAGE", `--vm-memory-mib must be a whole number from 2048 to 262144, got "${opts.vmMemoryMib}"`, next, EXIT.usage);
    vm.memory_mib = n;
  }
  // Job VMs on the agent's own network, which reaches the internet and nothing on the host's networks
  // (B07.4), by default; `nat` opts out, for CI that must reach an internal service.
  if (opts.vmNetwork === "isolated" || opts.vmNetwork === "auto") delete vm.network;
  else if (opts.vmNetwork === "nat") vm.network = "nat";
  else if (opts.vmNetwork !== undefined) throw new CliError("USAGE", `--vm-network must be isolated or nat, got "${opts.vmNetwork}"`, next, EXIT.usage);
  if (opts.macosAtOnce === "auto") delete vm.macos_at_once;
  else if (opts.macosAtOnce !== undefined) {
    const n = Number(opts.macosAtOnce);
    if (n !== 1 && n !== 2) throw new CliError("USAGE", `--macos-at-once must be 1, 2 or auto (Apple allows two macOS VMs per Mac), got "${opts.macosAtOnce}"`, next, EXIT.usage);
    vm.macos_at_once = n;
  }
  return Object.keys(vm).length > 0 ? { vm } : {};
}

/**
 * Jobs at once: a number pins it, `auto` leaves it to the agent, which plans it from the machine's
 * memory (one macOS job, then as many 4 GB Linux jobs as fit; laptops one at a time). Without the
 * flag an existing pin in agent.json is kept and a new machine is automatic.
 */
function parseCapacity(v: string | number | undefined, existing: number | undefined, next: string): number | undefined {
  if (v === undefined) return existing;
  if (v === "auto") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new CliError("USAGE", `--capacity must be auto or a whole number from 1 to 64, got "${v}"`, next, EXIT.usage);
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
  // Checked before anything else happens; resolved against agent.json once it has been read.
  const pinnedCapacity = parseCapacity(opts.capacity, undefined, base);
  steps.push({ step: "detect_host", status: "done", detail: `${host.os} ${host.arch}, ${host.cpu_cores} cores, ${host.memory_gb} GB, hostname ${host.hostname}` });

  await confirm(opts.yes, `Connect ${name} to ${opts.org} as a ${label} runner?`, base);

  const source = await locateAgentBinary(opts.agentBinary, host, base);
  const version = agentVersion(source.path);
  const api = ApiClient.forCommand(opts, base);

  const existing = readAgentConfig();
  const capacity = opts.capacity === undefined ? existing?.capacity : pinnedCapacity;
  // The control plane gets an estimate until the agent's first heartbeat reports what it planned.
  const r = await api.request<RegisterResponse>(
    "POST",
    "/v1/machines",
    { owner: opts.org, name, os: host.os, arch: host.arch, cpu_cores: host.cpu_cores, memory_gb: host.memory_gb, labels, capacity: capacity ?? defaultCapacity(host), isolation: "vm", agent_version: version },
    `${base} --yes`,
  );
  if (r.kind === "needs_human") {
    steps.push({ step: "register", status: "needs_human", detail: r.body.reason });
    return { ...r.body, next: r.body.next || `${base} --yes`, steps };
  }
  const reg = r.body;
  if (!reg?.machine?.id || !reg.machine_token) throw new CliError("API_ERROR", "the control plane answered without a machine id and token", `${base} --yes`, EXIT.network);
  steps.push({ step: "register", status: r.status === 200 ? "skipped" : "done", detail: r.status === 200 ? `already registered as ${reg.machine.name} (${reg.machine.id})` : `registered as ${reg.machine.name} (${reg.machine.id})` });

  // The allow-list, VM size and dogfood flag are this host's own settings, not part of one registration:
  // they are kept when the machine registers again, even under a new id (for example a new control plane).
  const repositories = opts.repositories !== undefined ? parseRepositories(opts.repositories, base) : existing?.repositories;
  const config: AgentConfig = {
    machine_id: reg.machine.id,
    machine_name: reg.machine.name,
    machine_token: reg.machine_token,
    api_url: api.baseUrl,
    owner: opts.org,
    scale_sets: reg.scale_sets ?? [],
    os: host.os,
    arch: host.arch,
    ...(capacity !== undefined ? { capacity } : {}),
    dogfood_host_mode: Boolean(opts.dogfoodHostMode) || Boolean(existing?.dogfood_host_mode),
    ...(repositories && repositories.length > 0 ? { repositories } : {}),
    ...vmSettings(existing?.vm, opts, base),
  };
  const configPath = `${agentHome()}/agent.json`;
  const changed = writeAgentConfig(config);
  steps.push({ step: "write_config", status: changed ? "done" : "skipped", detail: changed ? `${configPath} written (mode 0600)${existing && existing.machine_id !== config.machine_id ? `, replaced ${existing.machine_id}` : ""}` : `${configPath} unchanged` });
  const policy = writeDefaultPolicy(host.has_battery);
  steps.push({ step: "write_policy", status: policy.written ? "done" : "skipped", detail: policy.written ? (host.has_battery ? "laptop detected: jobs run only when plugged in; change it from the menu bar" : "no restrictions") : "existing policy kept" });

  const installed = installAgentBinary(source);
  steps.push({ step: "install_agent", status: installed.changed ? "done" : "skipped", detail: installed.changed ? `copied from ${source.origin} (${source.path}) to ${installed.path}` : `${installed.path} already installed (${source.origin})` });

  const service = installService({ os: host.os, binary: installed.path, home: agentHome(), logPath: agentLogPath(), restart: changed || installed.changed }, exec);
  steps.push({ step: "install_service", status: service.status, detail: service.detail });

  return {
    status: "ready",
    machine: reg.machine.name,
    machine_id: reg.machine.id,
    owner: opts.org,
    label,
    scale_sets: reg.scale_sets ?? [],
    capacity: config.capacity ?? "auto",
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
    .option("--repositories <list>", "personal accounts: only these repositories, as owner/name separated by commas; kept on later runs")
    .option("--capacity <n>", "jobs at once, or auto (the default): one macOS job and as many 4 GB Linux jobs as memory holds; laptops one at a time")
    .option("--api-url <url>", "control plane URL; else BUILDHOUND_API_URL, API_URL, https://api.buildhound.sh")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--vm-cpus <n>", "pin every guest to this many cores, or auto; by default the agent sizes guests from the machine")
    .option("--vm-memory-mib <n>", "pin every guest to this much memory in MiB, or auto")
    .option("--macos-at-once <n>", "macOS jobs at once, 1 or 2 (Apple's limit), or auto")
    .option("--vm-network <mode>", "isolated (the default: job VMs reach the internet, never your network) or nat")
    .option("--agent-binary <path>", "use this buildhound-agent binary instead of locating or downloading one")
    .option("--yes", "connect without asking; required when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: RunnerAddOptions) => {
      emit(await runRunnerAdd(opts), opts, prettyRunnerAdd);
    });
  cmd.addOption(cmd.createOption("--dogfood-host-mode", "run jobs on the host without a VM (dogfood only)").hideHelp());
  return cmd;
}
