import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import type { NeedsHuman } from "@buildhound/shared";
import { agentVersion, installAgentBinary, locateAgentBinary } from "../lib/agent-binary";
import { agentHome, agentLogPath, hasPoolConsent, readAgentConfig, setLocalPolicy, setPoolConsent, writeAgentConfig, writeDefaultPolicy } from "../lib/agent-home";
import type { AgentConfig, ScaleSet } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { confirm, confirmPerson } from "../lib/confirm";
import { defaultCapacity, detectHost, labelsFor } from "../lib/host";
import type { HostInfo } from "../lib/host";
import { installService } from "../lib/service";
import type { ServiceExecutor } from "../lib/service";
import { CliError, emit } from "../output";
import { imageBuildAction } from "./image";
import { offerMacImage, withMacImage, type MacImageState } from "../lib/image-offer";
import { color, done, needed, next } from "../lib/style";

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
  shareAvailability?: string | undefined;
}

export interface AddStep {
  step: "detect_host" | "vm_network" | "register" | "write_config" | "write_policy" | "install_agent" | "install_service" | "pool_consent";
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
  /** On a Mac serving macOS jobs: whether its macOS image is built (B06.2). While it is missing, next is the build and then the step after it. */
  macos_image?: MacImageState;
  then?: string;
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

/** The guest settings the flags ask for: a value pins one, `auto` removes the pin; a flag not given leaves agent.json's. */
interface VmFlags {
  cpus?: number | "auto";
  memory_mib?: number | "auto";
  network?: "nat" | "isolated";
  macos_at_once?: number | "auto";
}

/**
 * VM sizes are worked out by the agent from the machine it runs on (speed first). --vm-cpus,
 * --vm-memory-mib and --macos-at-once pin them; a pin already in agent.json is kept, and `auto`
 * removes it so the agent decides again.
 */
function parseVmFlags(opts: RunnerAddOptions, next: string): VmFlags {
  const flags: VmFlags = {};
  if (opts.vmCpus === "auto") flags.cpus = "auto";
  else if (opts.vmCpus !== undefined) {
    const n = Number(opts.vmCpus);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new CliError("USAGE", `--vm-cpus must be a whole number from 1 to 64, got "${opts.vmCpus}"`, next, EXIT.usage);
    flags.cpus = n;
  }
  if (opts.vmMemoryMib === "auto") flags.memory_mib = "auto";
  else if (opts.vmMemoryMib !== undefined) {
    const n = Number(opts.vmMemoryMib);
    if (!Number.isInteger(n) || n < 2048 || n > 262144) throw new CliError("USAGE", `--vm-memory-mib must be a whole number from 2048 to 262144, got "${opts.vmMemoryMib}"`, next, EXIT.usage);
    flags.memory_mib = n;
  }
  // Job VMs on the agent's own network, which reaches the internet and nothing on the host's networks
  // (B07.4), by default; `nat` opts out, for CI that must reach an internal service.
  if (opts.vmNetwork === "isolated" || opts.vmNetwork === "auto") flags.network = "isolated";
  else if (opts.vmNetwork === "nat") flags.network = "nat";
  else if (opts.vmNetwork !== undefined) throw new CliError("USAGE", `--vm-network must be isolated or nat, got "${opts.vmNetwork}"`, next, EXIT.usage);
  if (opts.macosAtOnce === "auto") flags.macos_at_once = "auto";
  else if (opts.macosAtOnce !== undefined) {
    const n = Number(opts.macosAtOnce);
    if (n !== 1 && n !== 2) throw new CliError("USAGE", `--macos-at-once must be 1, 2 or auto (Apple allows two macOS VMs per Mac), got "${opts.macosAtOnce}"`, next, EXIT.usage);
    flags.macos_at_once = n;
  }
  return flags;
}

function vmSettings(existing: AgentConfig["vm"], flags: VmFlags): { vm?: NonNullable<AgentConfig["vm"]> } {
  const vm = { ...(existing ?? {}) };
  if (flags.cpus === "auto") delete vm.cpus;
  else if (flags.cpus !== undefined) vm.cpus = flags.cpus;
  if (flags.memory_mib === "auto") delete vm.memory_mib;
  else if (flags.memory_mib !== undefined) vm.memory_mib = flags.memory_mib;
  if (flags.network === "isolated") delete vm.network;
  else if (flags.network === "nat") vm.network = "nat";
  if (flags.macos_at_once === "auto") delete vm.macos_at_once;
  else if (flags.macos_at_once !== undefined) vm.macos_at_once = flags.macos_at_once;
  return Object.keys(vm).length > 0 ? { vm } : {};
}

/** Measuring when this machine is free is the owner's choice, made on the machine (B07.5). */
function parseShareAvailability(v: string | undefined, next: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v !== "on" && v !== "off") throw new CliError("USAGE", `--share-availability must be on or off, got "${v}"`, next, EXIT.usage);
  return v === "on";
}

/** Where Linux hosts stand: the agent starts job VMs only on a Mac until `B12` (ROADMAP.md). */
export const LINUX_HOSTS_URL = "https://buildhound.sh/docs/machines#linux";

/**
 * Linux hosts come with `B12`: until then the Buildhound agent starts Linux guests only on a Mac, so a Linux host
 * would register and never take a job. Refused before anything is written or registered. The hidden dogfood flag
 * runs jobs on the host itself, so it still connects.
 */
export function refuseLinuxHost(host: Pick<HostInfo, "os">, opts: Pick<RunnerAddOptions, "dogfoodHostMode" | "org">): void {
  if (host.os !== "linux" || opts.dogfoodHostMode) return;
  throw new CliError(
    "NOT_SUPPORTED",
    "Linux hosts are not supported yet: the Buildhound agent runs jobs in VMs on a Mac today, so this machine would connect and never take a job. Linux hosts are coming.",
    `Linux hosts are coming (see ${LINUX_HOSTS_URL}); until then connect a Mac, which takes Linux jobs too: npx buildhound runner add --org ${opts.org ?? "<login>"} --yes`,
    EXIT.usage,
  );
}

/** The docs on job VM network isolation (SECURITY.md, Network isolation). */
export const NETWORK_DOCS = "https://buildhound.sh/docs/security#network";

/**
 * Jobs at once: a number pins it, `auto` leaves it to the agent, which plans it from the machine's
 * memory (one macOS job, then as many 8 GB Linux jobs as fit; laptops one at a time). Without the
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
  if (!opts.org) throw new CliError("USAGE", "--org <login> is required: the GitHub organisation or user that owns the machine", "buildhound runner add --org <login> --yes", EXIT.usage);
  // Without --label a Mac serves macOS and Linux jobs (labelsFor); an explicit --label is honoured as given.
  const base = `buildhound runner add --org ${opts.org}${opts.label !== undefined ? ` --label ${opts.label}` : ""}`;
  const steps: AddStep[] = [];

  const host = detectHost(base);
  refuseLinuxHost(host, opts);
  const labels = labelsFor(opts.label, host, base);
  const label = labels.join(",");
  const name = (opts.name || host.hostname).trim();
  // Checked before anything else happens, so a usage error registers and writes nothing; resolved against
  // agent.json and policy.json once they have been read.
  const pinnedCapacity = parseCapacity(opts.capacity, undefined, base);
  const pinnedRepositories = opts.repositories !== undefined ? parseRepositories(opts.repositories, base) : undefined;
  const vmFlags = parseVmFlags(opts, base);
  const shareAvailability = parseShareAvailability(opts.shareAvailability, base);
  steps.push({ step: "detect_host", status: "done", detail: `${host.os} ${host.arch}, ${host.cpu_cores} cores, ${host.memory_gb} GB, hostname ${host.hostname}` });

  await confirm(opts.yes, `Connect ${name} to ${opts.org} as a ${label} runner?`, base);

  // Turning off job VM network isolation lets a job reach this machine's network: only a person may do that, at a
  // terminal on the machine, and --yes does not count (CLAUDE.md rule 19; SECURITY.md, Consent). Asked before
  // anything is written, and only when it changes something: a machine already on nat registers again as before.
  if (opts.vmNetwork === "nat" && readAgentConfig()?.vm?.network !== "nat") {
    const command = `${base} --vm-network nat --yes`;
    const agreed = await confirmPerson(
      `Job VMs on ${name} will reach your network: your router, other devices, services on this machine and cloud metadata. Turn isolation off only for a dedicated machine whose CI must reach an internal service.`,
      name,
      command,
    );
    if (!agreed) {
      steps.push({ step: "vm_network", status: "needs_human", detail: "a person turns off network isolation at a terminal on this machine; nothing was changed" });
      return { status: "needs_human", reason: "network_isolation_needs_a_person", url: NETWORK_DOCS, next: `a person runs this in a terminal on this machine: ${command}`, steps };
    }
    steps.push({ step: "vm_network", status: "done", detail: "a person turned off network isolation for job VMs on this machine" });
  }

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
    // Paying is the person's step at `url`; afterwards the agent runs this same command again. A member cannot pay for
    // Team (only an admin can), so their next names who acts first.
    const again = `${base} --yes`;
    const after = r.body.reason === "needs_plan" || !r.body.next ? again : r.body.reason === "team_only" ? `ask an admin of ${opts.org} to upgrade to Team at ${r.body.url}, then ${again}` : r.body.next;
    return { ...r.body, next: after, steps };
  }
  const reg = r.body;
  if (!reg?.machine?.id || !reg.machine_token) throw new CliError("API_ERROR", "the control plane answered without a machine id and token", `${base} --yes`, EXIT.network);
  steps.push({ step: "register", status: r.status === 200 ? "skipped" : "done", detail: r.status === 200 ? `already registered as ${reg.machine.name} (${reg.machine.id})` : `registered as ${reg.machine.name} (${reg.machine.id})` });

  // The allow-list, VM size and dogfood flag are this host's own settings, not part of one registration:
  // they are kept when the machine registers again, even under a new id (for example a new control plane).
  const repositories = pinnedRepositories ?? existing?.repositories;
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
    ...vmSettings(existing?.vm, vmFlags),
  };
  const configPath = `${agentHome()}/agent.json`;
  const changed = writeAgentConfig(config);
  steps.push({ step: "write_config", status: changed ? "done" : "skipped", detail: changed ? `${configPath} written (mode 0600)${existing && existing.machine_id !== config.machine_id ? `, replaced ${existing.machine_id}` : ""}` : `${configPath} unchanged` });
  const policy = writeDefaultPolicy(host.has_battery);
  if (shareAvailability !== undefined) setLocalPolicy("share_availability", shareAvailability);
  steps.push({ step: "write_policy", status: policy.written ? "done" : "skipped", detail: policy.written ? (host.has_battery ? "laptop detected: jobs run only when plugged in and not in use; change it from the menu bar" : "no restrictions") : "existing policy kept" });

  const installed = installAgentBinary(source);
  steps.push({ step: "install_agent", status: installed.changed ? "done" : "skipped", detail: installed.changed ? `copied from ${source.origin} (${source.path}) to ${installed.path}` : `${installed.path} already installed (${source.origin})` });

  const service = installService({ os: host.os, binary: installed.path, home: agentHome(), logPath: agentLogPath(), restart: changed || installed.changed }, exec);
  steps.push({ step: "install_service", status: service.status, detail: service.detail });

  // A laptop joins an organisation's pool only by its owner's opt-in, given on the laptop itself: never
  // by an admin or an agent alone (B07.5; SECURITY.md, Consent). The agent waits for it before taking jobs.
  if (host.has_battery && reg.github.scope === "org") {
    if (hasPoolConsent()) {
      steps.push({ step: "pool_consent", status: "skipped", detail: "the owner already opted in on this laptop" });
    } else {
      const command = `${base} --yes`;
      const agreed = await confirmPerson(
        `${name} is a laptop joining ${opts.org}'s Fleet: it will take the organisation's jobs while plugged in and not in use, never jobs that use secrets, in VMs that cannot reach your network. Only you, at this laptop, can agree to that.`,
        name,
        command,
      );
      if (!agreed) {
        steps.push({ step: "pool_consent", status: "needs_human", detail: "the laptop's owner opts in at this laptop; it takes no jobs until then" });
        return { status: "needs_human", reason: "pool_consent_needs_the_owner", url: "https://buildhound.sh/docs/machines#policy", next: `the laptop's owner runs this in a terminal on it: ${command}`, steps };
      }
      setPoolConsent(true);
      steps.push({ step: "pool_consent", status: "done", detail: "the owner opted in on this laptop" });
    }
  }

  return withMacImage({
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
  } as const);
}

const WHY: Record<string, string> = {
  github_app_not_installed: "Install the Buildhound GitHub App on this account, then run the same command again.",
  permissions_update_required: "Approve the GitHub App's updated permissions, then run the same command again.",
  pool_consent_needs_the_owner: "The laptop's owner agrees to join the Fleet, at this laptop.",
  needs_plan: "Without a plan this account connects up to two machines. A person chooses a plan on the billing page, then run the same command again.",
  team_only: "Members connect their own machines when the organisation is on Team. An admin upgrades on the billing page, then run the same command again.",
  network_isolation_needs_a_person: "A person turns off network isolation for job VMs, at a terminal on this machine.",
};

export function prettyRunnerAdd(r: RunnerAddOutput): string {
  if (r.status === "needs_human") {
    const why = WHY[r.reason] ?? `A person needs to finish one step: ${r.reason.replace(/_/g, " ")}.`;
    // "the laptop's owner runs this in a terminal on it: <command>" carries the command to show on its own line.
    const at = r.next.indexOf(": buildhound ");
    const command = at >= 0 ? r.next.slice(at + 2) : null;
    const lines = command ? [...needed(why, command), "", `More: ${r.url}`] : [...needed(why, r.url), "", next(r.next)];
    return lines.join("\n");
  }
  return [done(`${r.machine} is connected to ${r.owner} as ${r.label}`), color.dim(`  Capacity ${r.capacity}, Buildhound agent ${r.agent_version}`), "", next(r.next)].join("\n");
}

export function runnerAddCommand(): Command {
  const cmd = new Command("add")
    .description("Connect this machine as a single-use runner (a Mac, for macOS and Linux jobs; Linux hosts are coming): register, write ~/.buildhound/agent.json, install and start the Buildhound agent")
    .requiredOption("--org <login>", "GitHub organisation or user that owns the machine")
    .option("--label <os>", "what the machine runs: macos, linux, or macos,linux (the default on a Mac)")
    .option("--name <machine>", "machine name; defaults to the hostname")
    .option("--repositories <list>", "personal accounts: only these repositories, as owner/name separated by commas; kept on later runs")
    .option("--capacity <n>", "jobs at once, or auto (the default): one macOS job and as many 8 GB Linux jobs as memory holds; laptops one at a time")
    .option("--api-url <url>", "control plane URL; else BUILDHOUND_API_URL, API_URL, https://api.buildhound.sh")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--vm-cpus <n>", "pin every guest to this many cores, or auto; by default the agent sizes guests from the machine")
    .option("--vm-memory-mib <n>", "pin every guest to this much memory in MiB, or auto")
    .option("--macos-at-once <n>", "macOS jobs at once, 1 or 2 (Apple's limit), or auto")
    .option("--vm-network <mode>", "isolated (the default: job VMs reach the internet, never your network) or nat, which lets them reach your network; nat needs a person to type the machine's name at a terminal")
    .option("--share-availability <on|off>", "count, per weekday hour, the minutes this machine is awake, plugged in and free, and share only those counts")
    .option("--agent-binary <path>", "use this buildhound-agent binary instead of locating or downloading one")
    .option("--yes", "connect without asking; required when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: RunnerAddOptions) => {
      const r = await runRunnerAdd(opts);
      emit(r, opts, prettyRunnerAdd);
      // On a Mac: Linux jobs run now; offer the macOS image build at a terminal (B06.2).
      await offerMacImage(r, opts, () => imageBuildAction({ yes: true }));
    });
  cmd.addOption(cmd.createOption("--dogfood-host-mode", "run jobs on the host without a VM (dogfood only)").hideHelp());
  return cmd;
}
