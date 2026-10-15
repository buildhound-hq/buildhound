import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { labelName, routingTable, type FailoverEntry } from "./runner-status";
import { CliError, emit } from "../output";
import { done, next } from "../lib/style";

export interface FailoverOptions {
  org?: string | undefined;
  label?: string | undefined;
  set?: string | undefined;
  fallback?: string | undefined;
  reason?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export interface FailoverResult {
  owner: string;
  changed: Array<{ label: string; mode: string; reason: string }> | null;
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

/** "Fall back to GitHub-hosted" (ADR-021): on is the auto mode, off is forced_machine. */
const FALLBACK: Record<string, Mode> = { on: "auto", off: "forced_machine" };
const DEFAULT_LABELS = ["buildhound-macos", "buildhound-linux"];

export async function runFailover(opts: FailoverOptions): Promise<FailoverResult> {
  if (!opts.org) throw new CliError("USAGE", "--org <login> is required", "buildhound failover --org <login>", EXIT.usage);
  const base = `buildhound failover --org ${opts.org}`;
  if (opts.set !== undefined && opts.fallback !== undefined) {
    throw new CliError("USAGE", "use --set or --fallback, not both", `${base} --fallback on --yes`, EXIT.usage);
  }
  const api = ApiClient.forCommand(opts, base);
  let changed: FailoverResult["changed"] = null;
  if (opts.set !== undefined) {
    const label = opts.label ?? "buildhound-macos";
    const mode = MODES.find((m) => m === opts.set) as Mode | undefined;
    const setCmd = `${base} --label ${label} --set ${opts.set}`;
    if (!mode) throw new CliError("USAGE", `--set must be auto, forced_machine or forced_hosted, got "${opts.set}"`, `${base} --label ${label} --set auto --yes`, EXIT.usage);
    await confirm(opts.yes, `Set failover for ${label} in ${opts.org} to ${mode}? New jobs route to the ${mode === "forced_hosted" ? "GitHub-hosted" : mode === "forced_machine" ? "machine" : "healthy"} side.`, setCmd);
    const reason = opts.reason ?? "manual";
    await api.expect<unknown>("POST", "/v1/failover", { owner: opts.org, label, mode, reason }, `${setCmd} --yes`);
    changed = [{ label, mode, reason }];
  }
  if (opts.fallback !== undefined) {
    const mode = FALLBACK[opts.fallback];
    const cmd = `${base}${opts.label ? ` --label ${opts.label}` : ""} --fallback ${opts.fallback}`;
    if (!mode) throw new CliError("USAGE", `--fallback must be on or off, got "${opts.fallback}"`, `${base} --fallback on --yes`, EXIT.usage);
    // Without --label: every label this account routes, so the setting covers Linux and macOS jobs alike.
    let labels = opts.label ? [opts.label] : [];
    if (!labels.length) {
      const now = await api.expect<FailoverBody>("GET", `/v1/failover?owner=${encodeURIComponent(opts.org)}`, undefined, base);
      labels = Object.keys(entries(now ?? {}));
      if (!labels.length) labels = DEFAULT_LABELS;
    }
    const what =
      mode === "forced_machine"
        ? "Jobs will wait for your machines and never run on GitHub-hosted, even when none can take them."
        : "When no machine can take a job, new jobs route to the healthy side, GitHub-hosted.";
    await confirm(opts.yes, `Turn ${opts.fallback} falling back to GitHub-hosted for ${labels.join(", ")} in ${opts.org}? ${what}`, cmd);
    const reason = opts.reason ?? `fallback ${opts.fallback}`;
    changed = [];
    for (const label of labels) {
      await api.expect<unknown>("POST", "/v1/failover", { owner: opts.org, label, mode, reason }, `${cmd} --yes`);
      changed.push({ label, mode, reason });
    }
  }
  const label = opts.label ?? "buildhound-macos";
  const body = await api.expect<FailoverBody>("GET", `/v1/failover?owner=${encodeURIComponent(opts.org)}`, undefined, base);
  return { owner: opts.org, changed, failover: entries(body ?? {}), next: changed ? `buildhound runner status --org ${opts.org}` : `${base} --label ${label} --set auto --yes` };
}

const MODE_TEXT: Record<string, string> = { auto: "fall back to GitHub-hosted on", forced_machine: "fall back to GitHub-hosted off, jobs always wait for your machines", forced_hosted: "always GitHub-hosted" };

export function prettyFailover(r: FailoverResult): string {
  const lines: string[] = [];
  for (const c of r.changed ?? []) lines.push(done(`${labelName(c.label)}: ${MODE_TEXT[c.mode] ?? c.mode}`));
  if (r.changed?.length) lines.push("");
  lines.push(...routingTable(r.failover), "", next(r.next));
  return lines.join("\n");
}

export function failoverCommand(): Command {
  return new Command("failover")
    .description("Inspect routing per label; turn falling back to GitHub-hosted on or off with --fallback, or override with --set (both need --yes)")
    .requiredOption("--org <login>", "GitHub organisation or user")
    .option("--label <label>", "label family to change; --set defaults to buildhound-macos, --fallback to every label")
    .option("--fallback <on|off>", "fall back to GitHub-hosted when no machine can take a job (on, the default) or never (off: jobs always wait for your machines)")
    .option("--set <mode>", "auto, forced_machine or forced_hosted")
    .option("--reason <text>", "why the change was made")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--yes", "change routing without asking; required with --set when there is no TTY")
    .option("--json", "JSON output")
    .action(async (opts: FailoverOptions) => {
      emit(await runFailover(opts), opts, prettyFailover);
    });
}
