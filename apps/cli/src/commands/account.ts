import { Command } from "commander";
import { EXIT, type AuditResponse, type PlanResponse, type RepositoriesResponse, type SettingsResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";

// The dashboard's account pages as commands (DASHBOARD.md; AGENT_FIRST.md): repositories and their routing
// state, the plan, the audit log, and the account's defaults. What a person sees follows their GitHub role.

interface ReadOptions {
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

function requireOrg(opts: ReadOptions, command: string): string {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user", `buildhound ${command} --org <login>`, EXIT.usage);
  return opts.org;
}

const enc = encodeURIComponent;

export type ReposResult = RepositoriesResponse & { owner: string; next: string };

export async function runRepos(opts: ReadOptions): Promise<ReposResult> {
  const owner = requireOrg(opts, "repos");
  const next = `buildhound repos --org ${owner}`;
  const body = await ApiClient.forCommand(opts, next).expect<RepositoriesResponse>("GET", `/v1/accounts/${enc(owner)}/repositories`, undefined, next);
  const first = body.repositories.find((r) => r.state === "not_routed" && !r.archived);
  return { ...body, owner, next: first ? `buildhound route --repo ${first.full_name} --apply` : `buildhound jobs --org ${owner}` };
}

export function prettyRepos(r: ReposResult): string {
  const rows = r.repositories.filter((x) => !x.archived).map((x) => [x.full_name, x.state === "routed" ? "your Macs" : x.state === "needs_plan" ? "needs a plan" : "not set up", String(x.jobs)]);
  return [...table(["REPOSITORY", "ROUTING", "JOBS (30 DAYS)"], rows), "", `next: ${r.next}`].join("\n");
}

export type PlanResult = PlanResponse & { owner: string; next: string };

export async function runPlan(opts: ReadOptions): Promise<PlanResult> {
  const owner = requireOrg(opts, "plan");
  const next = `buildhound plan --org ${owner}`;
  const body = await ApiClient.forCommand(opts, next).expect<PlanResponse>("GET", `/v1/accounts/${enc(owner)}/plan`, undefined, next);
  return { ...body, owner, next: body.effective === "none" ? body.checkout_next : `buildhound savings --org ${owner}` };
}

export function prettyPlan(r: PlanResult): string {
  const name = r.plan === "team" ? "Team" : "Personal";
  const state = r.effective === "none" ? (r.trial_ends_at ? "trial ended" : "no plan") : r.valid_until ? "active" : `trial until ${r.trial_ends_at?.slice(0, 10) ?? "?"}`;
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  return [`${r.owner}: ${name}, ${state}`, `${r.machines} machine${r.machines === 1 ? "" : "s"} at ${dollars(r.price_per_machine_cents)} a month = ${dollars(r.machines * r.price_per_machine_cents)}`, "", `next: ${r.next}`].join("\n");
}

export type AuditResult = AuditResponse & { owner: string; next: string };

export async function runAudit(opts: ReadOptions & { before?: string | undefined }): Promise<AuditResult> {
  const owner = requireOrg(opts, "audit");
  const next = `buildhound audit --org ${owner}`;
  const q = opts.before ? `?before=${enc(opts.before)}` : "";
  const body = await ApiClient.forCommand(opts, next).expect<AuditResponse>("GET", `/v1/accounts/${enc(owner)}/audit${q}`, undefined, next);
  return { ...body, owner, next: body.next_before ? `buildhound audit --org ${owner} --before ${body.next_before}` : `buildhound runner status --org ${owner}` };
}

export function prettyAudit(r: AuditResult): string {
  const rows = r.events.map((e) => [e.created_at.slice(0, 16).replace("T", " "), e.actor, e.action, e.target, e.source]);
  return [...table(["WHEN (UTC)", "WHO", "ACTION", "TARGET", "FROM"], rows), "", `next: ${r.next}`].join("\n");
}

export type SettingsResult = SettingsResponse & { owner: string; changed: boolean; next: string };

const PERFORMANCE = ["quiet", "balanced", "max"] as const;

/** Reads the account's defaults, or sets them with --performance. Reversible and idempotent: no confirmation. */
export async function runSettings(opts: ReadOptions & { performance?: string | undefined }): Promise<SettingsResult> {
  const owner = requireOrg(opts, "settings");
  const next = `buildhound settings --org ${owner}`;
  const api = ApiClient.forCommand(opts, next);
  const path = `/v1/accounts/${enc(owner)}/settings`;
  if (opts.performance === undefined) {
    const body = await api.expect<SettingsResponse>("GET", path, undefined, next);
    return { ...body, owner, changed: false, next: `buildhound settings --org ${owner} --performance <quiet|balanced|max>` };
  }
  if (!(PERFORMANCE as readonly string[]).includes(opts.performance)) {
    throw new CliError("USAGE", "--performance is quiet, balanced or max", `buildhound settings --org ${owner} --performance balanced`, EXIT.usage);
  }
  const before = await api.expect<SettingsResponse>("GET", path, undefined, next);
  const body = await api.expect<SettingsResponse>("PUT", path, { performance: opts.performance }, next);
  return { ...body, owner, changed: before.defaults.performance !== body.defaults.performance, next: `buildhound runner status --org ${owner}` };
}

export function prettySettings(r: SettingsResult): string {
  return [`${r.owner}: new machines start at ${r.defaults.performance ?? "balanced"} performance${r.changed ? " (changed)" : ""}`, "", `next: ${r.next}`].join("\n");
}

function table(head: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["nothing yet"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(head), ...rows.map(line)];
}

const common = (cmd: Command) => cmd.option("--org <login>", "GitHub organisation or user").option("--api-url <url>", "control plane URL").option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`").option("--json", "JSON output");

export function reposCommand(): Command {
  return common(new Command("repos").description("Repositories the GitHub App can see, whether each routes to your machines, and its jobs in the last 30 days")).action(async (opts: ReadOptions) => {
    emit(await runRepos(opts), opts, prettyRepos);
  });
}

export function planCommand(): Command {
  return common(new Command("plan").description("The account's plan, trial, machines and monthly price per machine")).action(async (opts: ReadOptions) => {
    emit(await runPlan(opts), opts, prettyPlan);
  });
}

export function auditCommand(): Command {
  return common(new Command("audit").description("Every admin change to machines, routing and defaults, newest first (admins)"))
    .option("--before <time>", "the next page: the next_before value of the previous one")
    .action(async (opts: ReadOptions & { before?: string }) => {
      emit(await runAudit(opts), opts, prettyAudit);
    });
}

export function settingsCommand(): Command {
  return common(new Command("settings").description("The account's defaults for new machines; set them with --performance (admins)"))
    .option("--performance <mode>", "quiet, balanced or max: what a newly connected machine starts with")
    .action(async (opts: ReadOptions & { performance?: string }) => {
      emit(await runSettings(opts), opts, prettySettings);
    });
}
