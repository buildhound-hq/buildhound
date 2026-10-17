import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";

/** Where a Linux host's system service keeps everything: agent.json, the images, the job VMs (B12). */
export const LINUX_HOST_HOME = "/var/lib/buildhound";

/**
 * The agent's directory: BUILDHOUND_AGENT_HOME in tests; on a Linux host /var/lib/buildhound, the system service's
 * home, when running as root or once an agent is set up there; ~/.buildhound otherwise. Never the user's wider home.
 */
export function agentHome(): string {
  if (process.env.BUILDHOUND_AGENT_HOME) return process.env.BUILDHOUND_AGENT_HOME;
  if (platform() === "linux" && ((typeof process.getuid === "function" && process.getuid() === 0) || existsSync(path.join(LINUX_HOST_HOME, "agent.json")))) return LINUX_HOST_HOME;
  return path.join(homedir(), ".buildhound");
}

export const agentConfigPath = (): string => path.join(agentHome(), "agent.json");
export const agentSocketPath = (): string => path.join(agentHome(), "agent.sock");
export const agentBinDir = (): string => path.join(agentHome(), "bin");
export const installedAgentPath = (): string => path.join(agentBinDir(), "buildhound-agent");
export const agentLogPath = (): string => path.join(agentHome(), "agent.log");

export interface ScaleSet {
  label: string;
  name: string;
  runner_group: string;
}

/** What `runner add` writes and the Go agent reads. Mode 0600: it carries the machine token (CONTROL_PLANE_API.md). */
export interface AgentConfig {
  machine_id: string;
  machine_name: string;
  machine_token: string;
  api_url: string;
  owner: string;
  scale_sets: ScaleSet[];
  os: "macos" | "linux";
  arch: "arm64" | "x64";
  /** Jobs at once; absent lets the agent plan it from the machine's memory. */
  capacity?: number;
  dogfood_host_mode: boolean;
  /** `container` on a Linux host without KVM that runs jobs in Sysbox containers; absent means `vm`. */
  isolation?: "vm" | "container";
  /** Set by hand or by a later command; kept when `runner add` runs again for the same machine. */
  repositories?: string[];
  vm?: { cpus?: number; memory_mib?: number; macos_at_once?: number; network?: string; helper?: string; linux_image_dir?: string };
}

export function readAgentConfig(): AgentConfig | null {
  const file = agentConfigPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as AgentConfig;
  } catch (e) {
    throw new CliError("AGENT_CONFIG_INVALID", `${file}: ${e instanceof Error ? e.message : String(e)}`, `remove ${file} and run buildhound runner add again`, EXIT.usage);
  }
}

/** Returns true when the file changed. The directory is 0700 and the file 0600 before any token lands in it. */
export function writeAgentConfig(config: AgentConfig): boolean {
  const file = agentConfigPath();
  const text = JSON.stringify(config, null, 2) + "\n";
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && readFileSync(file, "utf8") === text) {
    chmodSync(file, 0o600);
    return false;
  }
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}

export const agentPolicyPath = (): string => path.join(agentHome(), "policy.json");

/**
 * Write the starting policy only when none exists, so a user's own choice from the menu bar is never overwritten.
 * Laptops start with "only when plugged in" and "only when idle" (B06.4), so CI never drains the battery or slows
 * the person at the laptop; everything else starts unrestricted. An existing machine keeps its saved policy.
 */
export function writeDefaultPolicy(onLaptop: boolean): { written: boolean; policy: { paused: boolean; idle_only: boolean; plugged_in_only: boolean } } {
  const policy = { paused: false, idle_only: onLaptop, plugged_in_only: onLaptop };
  const p = agentPolicyPath();
  if (existsSync(p)) return { written: false, policy: JSON.parse(readFileSync(p, "utf8")) };
  mkdirSync(agentHome(), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
  return { written: true, policy };
}

/**
 * Records the owner's opt-in, given on this laptop, to an organisation's pool (B07.5; SECURITY.md,
 * Consent). Only this command, run by a person at the laptop, and the menu bar write it.
 */
export function setPoolConsent(consent: boolean): void {
  setLocalPolicy("pool_consent", consent);
}

/** Sets one of the settings only the machine's owner may change, in policy.json on this machine. */
export function setLocalPolicy(key: "pool_consent" | "share_availability", value: boolean): void {
  const p = agentPolicyPath();
  const current = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
  mkdirSync(agentHome(), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ ...current, [key]: value }, null, 2) + "\n", { mode: 0o600 });
}

/** Whether this laptop's owner already opted in to an organisation's pool. */
export function hasPoolConsent(): boolean {
  const p = agentPolicyPath();
  return existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { pool_consent?: unknown }).pool_consent === true;
}
