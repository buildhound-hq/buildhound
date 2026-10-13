import { Command } from "commander";
import { existsSync } from "node:fs";
import http from "node:http";
import { EXIT, type NeedsPlanView } from "@buildhound/shared";
import { agentSocketPath, readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";

export interface RunnerStatusOptions {
  org?: string | undefined;
  local?: boolean | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface MachineRow {
  id: string;
  name: string;
  status: string;
  labels: string[];
  capacity: number;
  running_jobs: number;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  image_id: string | null;
  agent_version: string | null;
  isolation?: string;
  [extra: string]: unknown;
}

export interface FailoverEntry {
  active_label: string | null;
  mode: string;
  reason: string;
  [extra: string]: unknown;
}

export interface RemoteStatus {
  owner: string;
  machines: MachineRow[];
  failover: Record<string, FailoverEntry>;
  /** Private repositories routed to GitHub-hosted until a subscription or trial is active (ADR-025). */
  needs_plan?: NeedsPlanView;
  next: string;
}

export interface LocalStatus {
  local: true;
  socket: string;
  machine_id: string | null;
  agent: Record<string, unknown>;
  next: string;
}

export type RunnerStatusResult = RemoteStatus | LocalStatus;

type ListResponse = { machines?: unknown[]; failover?: Record<string, FailoverEntry>; needs_plan?: unknown };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);

/** The hold as the control plane sends it, or nothing when the shape is not one we know. */
function toNeedsPlan(v: unknown): NeedsPlanView | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const plan = o.plan === "team" ? "team" : o.plan === "personal" ? "personal" : null;
  if (!plan || !Array.isArray(o.repositories)) return undefined;
  return { plan, repositories: o.repositories.filter((r): r is string => typeof r === "string"), next: str(o.next) ?? `buildhound billing checkout --plan ${plan} --json` };
}

function toRow(m: Record<string, unknown>, now: number): MachineRow {
  const hb = str(m.last_heartbeat_at);
  const age = hb ? Math.max(0, Math.round((now - Date.parse(hb)) / 1000)) : null;
  return {
    ...m,
    id: String(m.id ?? ""),
    name: String(m.name ?? ""),
    status: String(m.status ?? "unknown"),
    labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
    capacity: int(m.capacity),
    running_jobs: int(m.running_jobs),
    last_heartbeat_at: hb,
    heartbeat_age_seconds: Number.isFinite(age) ? age : null,
    image_id: str(m.image_id),
    agent_version: str(m.agent_version),
  };
}

export async function runRemoteStatus(owner: string, opts: RunnerStatusOptions): Promise<RemoteStatus> {
  const next = `buildhound runner status --org ${owner}`;
  const api = ApiClient.forCommand(opts, next);
  const body = await api.expect<ListResponse>("GET", `/v1/machines?owner=${encodeURIComponent(owner)}`, undefined, next);
  const now = Date.now();
  const machines = (Array.isArray(body.machines) ? body.machines : []).filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null).map((m) => toRow(m, now));
  const needsPlan = toNeedsPlan(body.needs_plan);
  return { owner, machines, failover: body.failover ?? {}, ...(needsPlan ? { needs_plan: needsPlan } : {}), next: machines.length ? `buildhound route --repo <owner/name>` : `buildhound runner add --org ${owner} --label macos --yes` };
}

/** GET /status on the agent's Unix socket; the AgentStatus shape is the agent's and is passed through. */
export function readLocalStatus(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/status", method: "GET", headers: { accept: "application/json" }, timeout: 5000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(text) as unknown;
          if (res.statusCode && res.statusCode >= 400) reject(new Error(`agent answered HTTP ${res.statusCode}`));
          else resolve((typeof json === "object" && json !== null ? json : { value: json }) as Record<string, unknown>);
        } catch {
          reject(new Error(`agent answered with something that is not JSON: ${text.slice(0, 80)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("agent did not answer in 5 seconds")));
    req.on("error", reject);
    req.end();
  });
}

export async function runLocalStatus(): Promise<LocalStatus> {
  const config = readAgentConfig();
  const socket = agentSocketPath();
  const next = config ? `buildhound runner status --org ${config.owner}` : "buildhound runner add --org <login> --label macos --yes";
  if (!existsSync(socket)) throw new CliError("AGENT_NOT_RUNNING", config ? `no agent socket at ${socket}; the agent is not running` : `this machine is not connected (no ${socket})`, next, EXIT.usage);
  let agent: Record<string, unknown>;
  try {
    agent = await readLocalStatus(socket);
  } catch (e) {
    throw new CliError("AGENT_NOT_RUNNING", `${socket}: ${e instanceof Error ? e.message : String(e)}`, next, EXIT.usage);
  }
  return { local: true, socket, machine_id: config?.machine_id ?? null, agent, next };
}

export async function runRunnerStatus(opts: RunnerStatusOptions): Promise<RunnerStatusResult> {
  if (opts.org) return runRemoteStatus(opts.org, opts);
  if (opts.local || readAgentConfig()) return runLocalStatus();
  throw new CliError("USAGE", "pass --org <login> to list an account's machines, or --local to ask the agent on this machine", "buildhound runner status --org <login>", EXIT.usage);
}

const ago = (s: number | null): string => (s === null ? "never" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)];
}

export function prettyRunnerStatus(r: RunnerStatusResult): string {
  const lines: string[] = [];
  if ("local" in r) {
    const a = r.agent;
    lines.push(`agent on this machine (${r.socket})`);
    for (const [k, v] of Object.entries(a)) lines.push(`  ${k.padEnd(20)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    lines.push("", `next: ${r.next}`);
    return lines.join("\n");
  }
  lines.push(`${r.owner}: ${r.machines.length} machine${r.machines.length === 1 ? "" : "s"}`);
  if (r.machines.length) {
    lines.push("", ...table(["MACHINE", "STATUS", "HEARTBEAT", "JOBS", "LABELS", "IMAGE", "AGENT"], r.machines.map((m) => [m.name, m.status, ago(m.heartbeat_age_seconds), `${m.running_jobs}/${m.capacity}`, m.labels.join(","), m.image_id ?? "-", m.agent_version ?? "-"])));
  }
  const fo = Object.entries(r.failover);
  if (fo.length) {
    lines.push("", "failover (new jobs route to the healthy side):", ...table(["LABEL", "ACTIVE", "MODE", "REASON"], fo.map(([label, f]) => [label, f.active_label ?? "github-hosted", f.mode, f.reason])));
  }
  if (r.needs_plan) {
    const n = r.needs_plan.repositories.length;
    lines.push("", `needs_plan: ${n} private ${n === 1 ? "repository routes" : "repositories route"} to GitHub-hosted until a ${r.needs_plan.plan === "team" ? "Team" : "Personal"} subscription is active`);
    if (n) lines.push(`  ${r.needs_plan.repositories.join(", ")}`);
    lines.push(`  next: ${r.needs_plan.next}`);
  }
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function runnerStatusCommand(): Command {
  return new Command("status")
    .description("Machines, heartbeats, running jobs and the failover map for an account; --local asks the agent on this machine")
    .option("--org <login>", "list the account's machines from the control plane")
    .option("--local", "read the local agent's status over its Unix socket")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerStatusOptions) => {
      emit(await runRunnerStatus(opts), opts, prettyRunnerStatus);
    });
}
