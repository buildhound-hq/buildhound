import { Command } from "commander";
import { EXIT, type RoutingFamily, type RoutingStatusResponse } from "@buildhound/shared";
import { readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { ago, color, needed, next } from "../lib/style";

// `buildhound status`: per kind of job, where new jobs go now and why, in the words of the one table
// (packages/shared/src/why-hosted.ts; the canvas's W-WhyHosted board). The same JSON as the MCP tool `routing_status`.

export interface StatusOptions {
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export type StatusResult = RoutingStatusResponse & { next: string };

/** The step to take first: a family that needs a person, then the trust banner, then any family on GitHub-hosted. */
function firstNext(r: RoutingStatusResponse): string {
  const you = r.families.find((f) => f.who === "you" && f.where === "github_hosted") ?? r.families.find((f) => f.who === "you");
  if (you) return you.next;
  if (r.trust_banner.show) return r.trust_banner.next;
  const hosted = r.families.find((f) => f.where === "github_hosted" && f.who !== "nobody");
  if (hosted) return hosted.next;
  return r.families.length ? `buildhound jobs --org ${r.owner}` : `buildhound runner add --org ${r.owner} --yes`;
}

export async function runStatus(opts: StatusOptions): Promise<StatusResult> {
  // The account comes from --org, or from this machine's own Buildhound agent when it is connected.
  const owner = opts.org ?? readAgentConfig()?.owner;
  if (!owner) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user whose routing to show", "buildhound status --org <login>", EXIT.usage);
  const retry = `buildhound status --org ${owner}`;
  const api = ApiClient.forCommand(opts, retry);
  const body = await api.expect<RoutingStatusResponse>("GET", `/v1/accounts/${encodeURIComponent(owner)}/routing`, undefined, retry);
  return { ...body, next: firstNext(body) };
}

const COLUMN = 13;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

/** "Your 2 Macs, 1 busy": the machines that take the family's jobs, and how many are busy. */
function machinesLine(f: RoutingFamily): string {
  const taking = f.machines.filter((m) => m.why === "free" || m.why === "busy");
  const busy = taking.filter((m) => m.why === "busy").length;
  const macs = f.machines.length > 0 && f.machines.every((m) => m.os === "macos");
  const noun = taking.length === 1 ? (macs ? "Mac" : "machine") : macs ? "Macs" : "machines";
  if (taking.length === 0) return f.summary;
  return `Your ${taking.length === 1 ? "" : `${taking.length} `}${noun}${busy ? `, ${busy} busy` : ""}`;
}

/** The family's lines from the board: where, why, each machine's why, then "Comes back on its own" or the fix. */
export function familyLines(f: RoutingFamily): string[] {
  const head = (text: string) => `${pad(f.name, COLUMN)}${text}`;
  const indent = (text: string) => `${" ".repeat(COLUMN)}${text}`;
  if (f.reason === "not_served") return [head(`GitHub-hosted, ${f.summary.charAt(0).toLowerCase()}${f.summary.slice(1)}`)];
  const lines: string[] = [];
  if (f.where === "machines") {
    lines.push(head(machinesLine(f)));
    if (f.reason !== "machine_online" && f.reason !== "manual") lines.push(indent(f.summary), indent(f.who === "automatic" ? "Comes back on its own" : f.fix));
  } else {
    lines.push(head(f.who === "automatic" ? "GitHub-hosted for now" : "GitHub-hosted"), indent(f.summary));
    const width = Math.max(0, ...f.machines.map((m) => m.name.length)) + 2;
    for (const m of f.machines) lines.push(indent(`${pad(m.name, width)}${m.why === "offline" && m.since ? `offline, last seen ${ago(m.since)}` : m.phrase}`));
    lines.push(indent(f.who === "automatic" ? "Comes back on its own" : f.fix));
  }
  // Jobs that use secrets go elsewhere while the family itself runs on the machines: say so once.
  if (f.where === "machines" && f.secrets && f.secrets.where === "github_hosted") lines.push(indent(color.dim(`Jobs with secrets run on GitHub-hosted. ${f.secrets.fix}`)));
  return lines;
}

export function prettyStatus(r: StatusResult): string {
  if (!r.families.length) return [`No machines yet for ${r.owner}, so every job runs on GitHub-hosted`, "", next(r.next)].join("\n");
  const blocks = r.families.map((f) => familyLines(f).join("\n"));
  const lines = [blocks.join("\n\n")];
  if (r.trust_banner.show) lines.push("", ...needed(r.trust_banner.summary, r.trust_banner.fix));
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function statusCommand(): Command {
  return new Command("status")
    .description("Where new jobs go now for each kind of job, and why: your machines or GitHub-hosted, each machine's reason, and the fix")
    .option("--org <login>", "GitHub organisation or user; else the account this machine is connected to")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: StatusOptions) => {
      emit(await runStatus(opts), opts, prettyStatus);
    });
}
