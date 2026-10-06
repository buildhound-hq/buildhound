import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";

/** The agent's directory: BUILDHOUND_AGENT_HOME in tests, ~/.buildhound otherwise. Never the user's wider home. */
export function agentHome(): string {
  return process.env.BUILDHOUND_AGENT_HOME || path.join(homedir(), ".buildhound");
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
  capacity: number;
  dogfood_host_mode: boolean;
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
