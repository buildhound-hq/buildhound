import { Command } from "commander";
import { EXIT, type AuditResponse, type PlanResponse, type RepositoriesResponse, type SettingsResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { ago, color, count, done, fields, money, next, table } from "../lib/style";

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
  return { ...body, owner, next: first ? `buildhound route --repo ${first.full_name}` : `buildhound jobs --org ${owner}` };
}

const ROUTING = { routed: "Your machines", needs_plan: "Needs a plan", not_routed: "Not set up" } as const;

export function prettyRepos(r: ReposResult): string {
  const repos = r.repositories.filter((x) => !x.archived);
  if (!repos.length) return [`No repositories yet for ${r.owner}`, "", next(r.next)].join("\n");
  const rows = repos.map((x) => [x.full_name, ROUTING[x.state], String(x.jobs), color.dim(ago(x.last_job_at))]);
  return [`Showing ${count(repos.length, "repository", "repositories")} for ${r.owner}`, "", ...table(["REPOSITORY", "ROUTING", "JOBS (30 DAYS)", "LAST JOB"], rows, { right: [2] }), "", next(r.next)].join("\n");
}

export type PlanResult = PlanResponse & { owner: string; next: string };

export async function runPlan(opts: ReadOptions): Promise<PlanResult> {
  const owner = requireOrg(opts, "plan");
  const next = `buildhound plan --org ${owner}`;
  const body = await ApiClient.forCommand(opts, next).expect<PlanResponse>("GET", `/v1/accounts/${enc(owner)}/plan`, undefined, next);
  return { ...body, owner, next: body.effective === "none" ? body.checkout_next : `buildhound savings --org ${owner}` };
}

/** Trials started before 2026-10-15 run to their end; no new trials (ADR-031). */
function trialLeft(endsAt: string, now = Date.now()): string {
  const days = Math.floor((Date.parse(endsAt) - now) / 86_400_000);
  return days >= 1 ? `Trial, ${count(days, "day")} left` : "Trial, ends today";
}

/** Whole dollars as the price list writes them ($24), else dollars and cents. */
const usd = (cents: number): string => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : money(cents));

/** Both plans lead with the annual period as a monthly figure, the monthly price beside it (BILLING.md). */
function priceOf(r: PlanResult): { perMachine: string; perMachineCents: number } {
  const perMachineCents = Math.round(r.price_per_machine_annual_cents / 12);
  return { perMachineCents, perMachine: `${usd(perMachineCents)} a machine a month billed annually, or ${usd(r.price_per_machine_cents)} monthly` };
}

/**
 * Machines that ran a job each UTC day, averaged over the month so far, beside the connected count (ADR-033).
 * A server from before 2026-10-15 sends only the connected count, priced as it was then.
 */
function machinesLine(r: PlanResult, perMachineCents: number): string {
  if (r.billable_machines === undefined) return `${count(r.machines, "machine")}, ${usd(r.machines * perMachineCents)} a month`;
  const average = r.billable_machines.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${average} ran jobs this month on average (${r.machines} connected)`;
}

export function prettyPlan(r: PlanResult): string {
  const name = r.effective === "enterprise" ? "Enterprise" : r.plan === "team" ? "Team" : "Personal";
  // Without a subscription the account is on Free (docs/BRAND.md, Glossary); JSON keeps `effective: "none"`.
  const free = r.effective === "none";
  const status = free ? "" : r.valid_until || !r.trial_ends_at ? "Active" : trialLeft(r.trial_ends_at);
  const price = priceOf(r);
  return [
    ...fields([
      ["Plan", free ? "Free" : name],
      ["Status", status],
      ["Price", free ? `${name}, ${price.perMachine}` : price.perMachine],
      ["Machines", machinesLine(r, price.perMachineCents)],
      ["Estimate", r.estimated_cents === null || r.estimated_cents === undefined ? "" : `about ${usd(r.estimated_cents)} for the month at this rate, before tax`],
      ["Counted", r.billable_machines === undefined ? "" : "a machine counts only on days it ran a job"],
      ["Refund", r.effective === "none" ? "the first payment, on request within 30 days" : ""],
      ["Without a plan", r.effective === "none" ? `public repositories only, on up to ${count(r.free_machine_limit, "machine")}` : ""],
    ]),
    "",
    next(r.next),
  ].join("\n");
}

export type AuditResult = AuditResponse & { owner: string; next: string };

export async function runAudit(opts: ReadOptions & { before?: string | undefined }): Promise<AuditResult> {
  const owner = requireOrg(opts, "audit-log");
  const next = `buildhound audit-log --org ${owner}`;
  const q = opts.before ? `?before=${enc(opts.before)}` : "";
  const body = await ApiClient.forCommand(opts, next).expect<AuditResponse>("GET", `/v1/accounts/${enc(owner)}/audit${q}`, undefined, next);
  return { ...body, owner, next: body.next_before ? `buildhound audit-log --org ${owner} --before ${body.next_before}` : `buildhound runner status --org ${owner}` };
}

export function prettyAudit(r: AuditResult): string {
  if (!r.events.length) return [`No changes yet for ${r.owner}`, "", next(r.next)].join("\n");
  const rows = r.events.map((e) => [color.dim(ago(e.created_at)), e.actor, e.action, e.target, e.source]);
  return [`Showing ${count(r.events.length, "change")} for ${r.owner}`, "", ...table(["WHEN", "WHO", "ACTION", "TARGET", "FROM"], rows), "", next(r.next)].join("\n");
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
  const line = `New machines in ${r.owner} start at ${r.defaults.performance ?? "balanced"} performance`;
  return [r.changed ? done(line) : line, "", next(r.next)].join("\n");
}

const common = (cmd: Command) => cmd.option("--org <login>", "GitHub organisation or user").option("--api-url <url>", "control plane URL").option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`").option("--json", "JSON output");

export function reposCommand(): Command {
  return common(new Command("repos").description("Repositories the GitHub App can see, whether each routes to your machines, and its jobs in the last 30 days")).action(async (opts: ReadOptions) => {
    emit(await runRepos(opts), opts, prettyRepos);
  });
}

export function planCommand(): Command {
  return common(new Command("plan").description("The account's plan, price per machine, and the machines that ran jobs this month (a machine counts only on days it ran a job)")).action(async (opts: ReadOptions) => {
    emit(await runPlan(opts), opts, prettyPlan);
  });
}

export function auditCommand(): Command {
  return common(new Command("audit-log").alias("audit").description("The audit log: every admin change to machines, routing and defaults, newest first (admins)"))
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
