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

/** Whole dollars as the price list writes them ($24), else dollars and cents. */
const usd = (cents: number): string => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : money(cents));

/** Both plans lead with the annual period as a monthly figure, the monthly price beside it (BILLING.md). */
function priceOf(r: PlanResult): { perMachine: string; perMachineCents: number } {
  const perMachineCents = Math.round(r.price_per_machine_annual_cents / 12);
  return { perMachineCents, perMachine: `${usd(perMachineCents)} a machine a month billed annually, or ${usd(r.price_per_machine_cents)} monthly` };
}

/**
 * The connected count (ADR-033). A server from before 2026-10-15 sends only that, priced as it was then; later ones
 * put the bill's count on the "Days with jobs" line below.
 */
function machinesLine(r: PlanResult, perMachineCents: number): string {
  if (r.billable_machines === undefined) return `${count(r.machines, "machine")}, ${usd(r.machines * perMachineCents)} a month`;
  return `${r.machines} connected`;
}

/**
 * What the bill counts, in machine days (BILLING.md, Quantity; one name on every surface, 2026-10-16): the machine
 * days with jobs so far against the connected machines times the days elapsed, never an average. A server from
 * before 2026-10-16 sends only `billable_machines` (machine days over the days); it reads as machines a day.
 */
function daysLine(r: PlanResult): string {
  if (r.billable_machines === undefined) return "";
  if (r.machine_days === undefined || r.days_elapsed === undefined) {
    return `about ${r.billable_machines.toLocaleString("en-US", { maximumFractionDigits: 2 })} machines a day with jobs this month`;
  }
  const possible = Math.max(r.machine_days, r.machines * r.days_elapsed);
  const idle = possible - r.machine_days;
  return `${r.machine_days} of ${possible} machine days so far${idle > 0 ? `, ${idle} idle` : ""}`;
}

const day = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The Paddle subscription behind a paid plan (BILLING.md): period, what was paid for, and the next payment at today's rate. */
function subscriptionLines(r: PlanResult): Array<[string, string]> {
  const s = r.subscription;
  if (!s) return [];
  const status = s.status === "past_due" ? "payment failed, Paddle is retrying" : s.status === "canceled" ? "ended" : s.cancel_at ? `ends ${day(s.cancel_at)}` : `renews ${day(s.period.end)}`;
  return [
    ["Billing", `${s.billing === "annual" ? "annually" : "monthly"}, ${status}`],
    ["Paid for", `${count(s.quantity, "machine")} this period, ${day(s.period.start)} to ${day(s.period.end)}`],
    ["Next payment", s.next_bill_estimate_cents === null ? "" : `about ${money(s.next_bill_estimate_cents)} before tax: the next period in advance, settled against this period's machine days with jobs`],
    ["Credit", s.credit_cents > 0 ? `${money(s.credit_cents)} to come off later payments` : ""],
    ["Manage", `${r.checkout_url ?? `https://app.buildhound.sh/${r.owner}/settings/billing`} (card, invoices, cancel)`],
  ];
}

export function prettyPlan(r: PlanResult): string {
  const name = r.effective === "enterprise" ? "Enterprise" : r.plan === "team" ? "Team" : "Personal";
  // Without a subscription the account is on Free (docs/BRAND.md, Glossary); JSON keeps `effective: "none"`.
  const free = r.effective === "none";
  const status = free ? "" : "Active";
  const price = priceOf(r);
  return [
    ...fields([
      ["Plan", free ? "Free" : name],
      ["Status", status],
      ["Price", free ? `${name}, ${price.perMachine}` : price.perMachine],
      ["Machines", machinesLine(r, price.perMachineCents)],
      ["Days with jobs", daysLine(r)],
      ["Estimate", r.estimated_cents === null || r.estimated_cents === undefined || r.subscription ? "" : `about ${usd(r.estimated_cents)} for the month at these machine days, before tax`],
      ...subscriptionLines(r),
      ["Counted", r.billable_machines === undefined ? "" : "you pay only for machine days with jobs: a machine counts on each UTC day it ran a job, however many it ran"],
      ["Refund", r.effective === "none" ? "the first payment, on request within 30 days" : ""],
      ["Without a plan", r.effective === "none" ? `public repositories only, on up to ${count(r.free_machine_limit, "machine")}` : ""],
    ]),
    "",
    next(r.next),
  ].join("\n");
}

export type AuditResult = AuditResponse & { owner: string; next: string };

/** The audit log's filters (2026-10-18, the Audit board): words, and comma separated values for the rest. */
export interface AuditOptions extends ReadOptions {
  before?: string | undefined;
  search?: string | undefined;
  action?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  source?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  facets?: boolean | undefined;
  fold?: boolean | undefined;
  format?: string | undefined;
}

const AUDIT_ACTIONS = ["settings", "repositories", "trust", "routing", "fallback", "machine_added", "machine_removed", "billing", "other"];

function auditQuery(o: AuditOptions, owner: string, extra: Record<string, string | undefined> = {}): string {
  for (const a of (o.action ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!AUDIT_ACTIONS.includes(a)) throw new CliError("USAGE", `--action takes ${AUDIT_ACTIONS.join(", ")}, comma separated; got ${a}`, `buildhound audit-log --org ${owner} --action settings`, EXIT.usage);
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ q: o.search, action: o.action, machine: o.machine, actor: o.actor, source: o.source, from: o.from, to: o.to, facets: o.facets ? "1" : undefined, fold: o.fold ? "1" : undefined, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function runAudit(opts: AuditOptions): Promise<AuditResult> {
  const owner = requireOrg(opts, "audit-log");
  const next = `buildhound audit-log --org ${owner}`;
  const body = await ApiClient.forCommand(opts, next).expect<AuditResponse>("GET", `/v1/accounts/${enc(owner)}/audit${auditQuery(opts, owner, { before: opts.before })}`, undefined, next);
  const flags = Object.entries({ search: opts.search, action: opts.action, machine: opts.machine, actor: opts.actor, source: opts.source, from: opts.from, to: opts.to })
    .filter(([, v]) => v)
    .map(([k, v]) => ` --${k} ${/\s/.test(v!) ? JSON.stringify(v) : v}`)
    .join("");
  return { ...body, owner, next: body.next_before ? `buildhound audit-log --org ${owner}${flags}${opts.fold ? " --fold" : ""} --before ${body.next_before}` : `buildhound runner status --org ${owner}` };
}

/** `--format csv`: the filtered events as the dashboard's Export CSV gives them, written as they come. */
export async function runAuditCsv(opts: AuditOptions): Promise<string> {
  const owner = requireOrg(opts, "audit-log");
  const next = `buildhound audit-log --org ${owner} --format csv`;
  return ApiClient.forCommand(opts, next).getText(`/v1/accounts/${enc(owner)}/audit${auditQuery(opts, owner, { format: "csv" })}`, next);
}

export function prettyAudit(r: AuditResult): string {
  if (!r.events.length) return [`No changes yet for ${r.owner}`, "", next(r.next)].join("\n");
  const lines = [`Showing ${count(r.events.length, "change")} for ${r.owner}`, ""];
  for (const e of r.events) {
    lines.push(`${e.actor} ${e.summary ?? `${e.action} ${e.target}`}  ${color.dim(`${e.source}, ${ago(e.created_at)}`)}`);
    for (const ch of e.changes ?? []) lines.push(color.dim(`  ${ch.field}: ${ch.from ?? "not recorded"} to ${ch.to ?? "not recorded"}`));
  }
  if (r.facets) {
    const line = (name: string, f: Record<string, number>) => [name, Object.entries(f).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ")] as [string, string];
    lines.push("", ...fields([line("Action", r.facets.action), line("Machine", r.facets.machine), line("Person", r.facets.actor), line("Source", r.facets.source)]));
  }
  return [...lines, "", next(r.next)].join("\n");
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
  return common(new Command("plan").description("The account's plan, price per machine, and the machine days with jobs this period (you pay only for those, never per minute)")).action(async (opts: ReadOptions) => {
    emit(await runPlan(opts), opts, prettyPlan);
  });
}

export function auditCommand(): Command {
  return common(new Command("audit-log").alias("audit").description("The audit log: every admin change to machines, routing and defaults, newest first, each saying what changed (admins)"))
    .option("--search <words>", "words in the person, the machine or repository, or the change itself")
    .option("--action <groups>", "settings, repositories, trust, routing, fallback, machine_added, machine_removed, billing or other, comma separated")
    .option("--machine <names>", "only changes to these machines, comma separated")
    .option("--actor <logins>", "only changes by these people, comma separated")
    .option("--source <sources>", "dashboard, cli, mcp or menu_bar, comma separated")
    .option("--from <date>", "from this date or time (UTC)")
    .option("--to <date>", "up to this date (the whole day) or time (UTC)")
    .option("--facets", "also count changes per value of each filter")
    .option("--fold", "fold the same change to several machines within a minute into one line")
    .option("--format <format>", "json (the default without a terminal) or csv, the export")
    .option("--before <time>", "the next page: the next_before value of the previous one")
    .action(async (opts: AuditOptions) => {
      if (opts.format === "csv") {
        process.stdout.write(await runAuditCsv(opts));
        return;
      }
      if (opts.format !== undefined && opts.format !== "json") throw new CliError("USAGE", `--format is json or csv, got ${opts.format}`, "buildhound audit-log --org <login> --format csv", EXIT.usage);
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
