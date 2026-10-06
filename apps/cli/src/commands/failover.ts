import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import type { FailoverEntry } from "./runner-status";
import { CliError, emit } from "../output";

export interface FailoverOptions {
  org?: string | undefined;
  label?: string | undefined;
  set?: string | undefined;
  reason?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export interface FailoverResult {
  owner: string;
  changed: { label: string; mode: string; reason: string } | null;
  failover: Record<string, FailoverEntry>;
  next: string;
}

const MODES = ["auto", "forced_machine", "forced_hosted"] as const;
type Mode = (typeof MODES)[number];

type FailoverBody = { failover?: Record<string, FailoverEntry> } & Record<string, unknown>;

function entries(body: FailoverBody | Record<string, FailoverEntry>): Record<string, FailoverEntry> {
  const fo = (body as FailoverBody).failover;
  if (fo && typeof fo === "object") return fo;
  const out: Record<string, FailoverEntry> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "object" && v !== null && "mode" in v) out[k] = v as FailoverEntry;
  return out;
}

export async function runFailover(opts: FailoverOptions): Promise<FailoverResult> {
  if (!opts.org) throw new CliError("USAGE", "--org <login> is required", "buildhound failover --org <login>", EXIT.usage);
  const label = opts.label ?? "buildhound-macos";
  const base = `buildhound failover --org ${opts.org}`;
  const api = ApiClient.forCommand(opts, base);
  let changed: FailoverResult["changed"] = null;
  if (opts.set !== undefined) {
    const mode = MODES.find((m) => m === opts.set) as Mode | undefined;
    const setCmd = `${base} --label ${label} --set ${opts.set}`;
    if (!mode) throw new CliError("USAGE", `--set must be auto, forced_machine or forced_hosted, got "${opts.set}"`, `${base} --label ${label} --set auto --yes`, EXIT.usage);
    await confirm(opts.yes, `Set failover for ${label} in ${opts.org} to ${mode}? New jobs route to the ${mode === "forced_hosted" ? "GitHub-hosted" : mode === "forced_machine" ? "machine" : "healthy"} side.`, setCmd);
    const reason = opts.reason ?? "manual";
    await api.expect<unknown>("POST", "/v1/failover", { owner: opts.org, label, mode, reason }, `${setCmd} --yes`);
    changed = { label, mode, reason };
  }
  const body = await api.expect<FailoverBody>("GET", `/v1/failover?owner=${encodeURIComponent(opts.org)}`, undefined, base);
  return { owner: opts.org, changed, failover: entries(body ?? {}), next: changed ? `buildhound runner status --org ${opts.org}` : `${base} --label ${label} --set auto --yes` };
}

export function prettyFailover(r: FailoverResult): string {
  const lines: string[] = [];
  if (r.changed) lines.push(`${r.changed.label}: mode set to ${r.changed.mode} (${r.changed.reason})`, "");
  lines.push(`${r.owner}: failover state (new jobs route to the healthy side)`);
  const rows = Object.entries(r.failover);
  if (!rows.length) lines.push("  no labels yet");
  for (const [label, f] of rows) lines.push(`  ${label.padEnd(22)} active ${f.active_label ?? "github-hosted"}  mode ${f.mode}  reason ${f.reason}`);
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function failoverCommand(): Command {
  return new Command("failover")
    .description("Inspect the failover state per label, or override it with --set (needs --yes)")
    .requiredOption("--org <login>", "GitHub organisation or user")
    .option("--label <label>", "label family to change with --set", "buildhound-macos")
    .option("--set <mode>", "auto, forced_machine or forced_hosted")
    .option("--reason <text>", "why the override was made", "manual")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--yes", "change routing without asking; required with --set when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: FailoverOptions) => {
      emit(await runFailover(opts), opts, prettyFailover);
    });
}
