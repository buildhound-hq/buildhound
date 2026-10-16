import { Command } from "commander";
import { existsSync } from "node:fs";
import http from "node:http";
import { EXIT, isTrustedTwin, labelFamily, reasonText as reasonWords, type NeedsPlanView } from "@buildhound/shared";
import { agentSocketPath, readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { servesLine, type RepositoryFilter } from "./runner-set";
import { ago, color, count, fields, needed, next, table } from "../lib/style";
import { imageBuildLine } from "../lib/image-progress";

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
  /** Private repositories routed to GitHub-hosted until a subscription is active (ADR-025). */
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
function toNeedsPlan(v: unknown, owner: string): NeedsPlanView | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const plan = o.plan === "team" ? "team" : o.plan === "personal" ? "personal" : null;
  if (!plan || !Array.isArray(o.repositories)) return undefined;
  const url = str(o.url);
  return { plan, repositories: o.repositories.filter((r): r is string => typeof r === "string"), ...(url ? { url } : {}), next: str(o.next) ?? `buildhound plan --org ${owner}` };
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
  const needsPlan = toNeedsPlan(body.needs_plan, owner);
  return { owner, machines, failover: body.failover ?? {}, ...(needsPlan ? { needs_plan: needsPlan } : {}), next: machines.length ? `buildhound route --repo <owner/name>` : `buildhound runner add --org ${owner} --yes` };
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
  const next = config ? `buildhound runner status --org ${config.owner}` : "buildhound runner add --org <login> --yes";
  // Set up but silent: doctor says why and how to start it again.
  if (!existsSync(socket)) throw new CliError("AGENT_NOT_RUNNING", config ? `no agent socket at ${socket}; the Buildhound agent is not running` : `this machine is not connected (no ${socket})`, config ? "buildhound doctor" : next, EXIT.usage);
  let agent: Record<string, unknown>;
  try {
    agent = await readLocalStatus(socket);
  } catch (e) {
    throw new CliError("AGENT_NOT_RUNNING", `${socket}: ${e instanceof Error ? e.message : String(e)}`, "buildhound doctor", EXIT.usage);
  }
  return { local: true, socket, machine_id: config?.machine_id ?? null, agent, next };
}

export async function runRunnerStatus(opts: RunnerStatusOptions): Promise<RunnerStatusResult> {
  if (opts.org) return runRemoteStatus(opts.org, opts);
  if (opts.local || readAgentConfig()) return runLocalStatus();
  throw new CliError("USAGE", "pass --org <login> to list an account's machines, or --local to ask the agent on this machine", "buildhound runner status --org <login>", EXIT.usage);
}

/** Raw machine status as the dashboard words it (docs/BRAND.md, Glossary); JSON keeps the raw value. */
const STATUS_WORDS: Record<string, string> = { online: "online", offline: "offline", paused: "paused", draining: "finishing up", needs_update: "needs update", battery: "on battery" };
export const statusWord = (status: string): string => STATUS_WORDS[status] ?? status.replace(/_/g, " ");

/** The agent's strain code as one plain reason. */
export function strainText(strain: string): string {
  if (strain === "thermal") return "Waiting: this Mac is running hot";
  if (strain === "low_power") return "Waiting: Low Power Mode is on";
  return "Waiting: memory is tight on this Mac";
}

/** buildhound-linux as Linux, buildhound-macos as macOS, buildhound-linux-x64 as Linux x64, buildhound-linux-arm64 as Linux arm64. */
export function labelName(label: string): string {
  // A family's trusted twin carries jobs that use secrets, which only Trusted machines take (ADR-023).
  if (isTrustedTwin(label)) return `${labelName(labelFamily(label))}, Trusted`;
  const rest = label.replace(/^buildhound-/, "");
  const [family, ...more] = rest.split("-");
  const name = family === "macos" ? "macOS" : family === "linux" ? "Linux" : family === "windows" ? "Windows" : family;
  return [name, ...more].join(" ");
}

function routesTo(label: string, active: string | null): string {
  if (active === null) return "GitHub-hosted";
  if (isTrustedTwin(label)) return active === label ? "Trusted machines" : active;
  return active === label || active.startsWith(`${label}-`) ? "Your machines" : active;
}

const reasonText = (reason: string | undefined): string => {
  if (!reason) return "";
  const words = reasonWords(reason);
  return words === reason ? reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : words;
};

/** Where new jobs go per label, shared by `runner status` and `failover`. */
export function routingTable(failover: Record<string, FailoverEntry>): string[] {
  const rows = Object.entries(failover).map(([label, f]) => [labelName(label), routesTo(label, f.active_label), f.mode === "forced_machine" ? "off" : "on", reasonText(f.reason)]);
  const lines = ["Routing", "When your machines are offline or busy, new jobs route to the healthy side."];
  if (!rows.length) return [...lines, "", "No labels yet"];
  return [...lines, "", ...table(["LABEL", "NEW JOBS GO TO", "FALLBACK", "REASON"], rows)];
}

export function prettyRunnerStatus(r: RunnerStatusResult): string {
  const lines: string[] = [];
  if ("local" in r) {
    // One plain reason when the machine takes no new jobs, e.g. "Waiting: memory is tight on this Mac" (B06.4).
    const reason = typeof r.agent.waitingReason === "string" ? r.agent.waitingReason : "";
    const note = typeof r.agent.memoryCapNote === "string" ? r.agent.memoryCapNote : "";
    // The macOS image build's current step, so a person or a coding agent can say it in plain words (B06.2).
    const image = imageBuildLine(r.agent.imageBuild);
    const raw = Object.entries(r.agent).filter(([k]) => k !== "imageBuild");
    lines.push(`Buildhound agent on this machine (${r.socket})`, ...(reason ? ["", reason] : []), ...(note ? ["", note] : []), ...(image ? ["", image] : []), "", ...fields(raw.map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)])), "", next(r.next));
    return lines.join("\n");
  }
  if (!r.machines.length) lines.push(`No machines yet for ${r.owner}`);
  else {
    const heartbeat = (s: number | null) => (s === null ? "never" : ago(Date.now() - s * 1000));
    lines.push(
      `Showing ${count(r.machines.length, "machine")} for ${r.owner}`,
      "",
      ...table(
        ["MACHINE", "STATUS", "TRUST", "JOBS", "HEARTBEAT", "AGENT"],
        r.machines.map((m) => [m.name, statusWord(m.status), m.trust === "trusted" ? "trusted" : "no secrets", `${m.running_jobs}/${m.capacity}`, color.dim(heartbeat(m.heartbeat_age_seconds)), m.agent_version ?? ""]),
      ),
    );
    // A machine that backs off to stay fast says why, in plain words (B06.4).
    for (const m of r.machines) {
      if (typeof m.strain === "string" && m.strain && m.status === "online") lines.push("", `${m.name}: ${strainText(m.strain)}`);
    }
    // On a personal account each machine serves chosen repositories: name them, so a missing one shows.
    const serves = r.machines
      .map((m) => [m.name, servesLine(m.repository_filter as RepositoryFilter | null | undefined, Array.isArray(m.repositories) ? (m.repositories as string[]) : undefined)] as const)
      .filter((x): x is readonly [string, string] => x[1] !== null);
    if (serves.length) lines.push("", ...serves.map(([name, line]) => `${name}: ${line}`));
    const only = r.machines.length === 1 ? r.machines[0]! : null;
    if (only) lines.push("", ...fields([["Disk", only.disk_encrypted === true ? "encrypted" : only.disk_encrypted === false ? "not encrypted" : ""], ["Image", only.image_id ?? ""]]));
  }
  lines.push("", ...routingTable(r.failover));
  if (r.needs_plan) {
    const n = r.needs_plan.repositories.length;
    lines.push("", ...needed(`${count(n, "private repository", "private repositories")} ${n === 1 ? "runs" : "run"} on GitHub-hosted until a ${r.needs_plan.plan === "team" ? "Team" : "Personal"} plan is active`, r.needs_plan.repositories.join(", "), r.needs_plan.next));
  }
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function runnerStatusCommand(): Command {
  return new Command("status")
    .description("Machines, heartbeats, running jobs and the failover map for an account; --local asks the Buildhound agent on this machine")
    .option("--org <login>", "list the account's machines from the control plane")
    .option("--local", "read the local Buildhound agent's status over its Unix socket")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerStatusOptions) => {
      emit(await runRunnerStatus(opts), opts, prettyRunnerStatus);
    });
}
