import { Command } from "commander";
import { DEFAULT_HARDWARE_CENTS, payback, type Finding } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { actionRefResolver } from "../lib/action-refs";
import { audit, resolveSource, selectRules } from "../lib/audit";
import type { AuditedWorkflow } from "../lib/audit";
import { confirm } from "../lib/confirm";
import { withDefaultTokenPermission } from "../lib/routing";
import { CliError, emit, wantsJson } from "../output";
import { prettyFix, runScanFix } from "./scan-fix";
import type { ScanFixOptions } from "./scan-fix";
import { count, done, failed, money, next, table } from "../lib/style";
import { findToken } from "../lib/token";

export type Severity = "high" | "medium" | "low";
const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface ScanOptions {
  repo?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
  rules?: string | undefined;
  failOn?: string | undefined;
  days?: string | number | undefined;
  offline?: boolean | undefined;
  /** false (`--no-resolve`) skips looking up action tags on GitHub, so R17 findings come without a pinning diff. */
  resolve?: boolean | undefined;
}

export interface ScanJob {
  id: string;
  name: string | null;
  runs_on: string[];
  provider: string;
  os: string;
  runs_per_month: number;
  minutes_per_run: number;
  minutes_per_month: number;
  cents_per_month: number;
  basis: "history" | "default";
}

export interface ScanWorkflow {
  path: string;
  name: string | null;
  events: string[];
  jobs: ScanJob[];
  estimate: { runs_per_month: number; runs_by_event: Record<string, number>; minutes_per_month: number; cents_per_month: number };
  findings: number;
}

export interface ScanResult {
  repo: string;
  path: string;
  history_days: number | null;
  rules: string[];
  workflows: ScanWorkflow[];
  findings: Finding[];
  totals: { minutes_per_month: number; cents_per_month: number; findings: number; saving_cents_per_month: number };
  /**
   * Repository-level case for a machine the team already has: GitHub-hosted macOS and Linux spend that would move,
   * less the Team fee per machine, as `monthly_saving_cents` (zero or below: no saving at this spend). No hardware
   * is priced (2026-10-15); `hardware_cents` and `payback_months` are deprecated, kept for agents that read them.
   */
  payback: { hosted_cents_per_month: number; macos_cents_per_month: number; machine_fee_cents: number; hardware_cents: number; machines_needed: number; monthly_saving_cents: number; payback_months: number | null };
  assumptions: string[];
  fail_on: Severity | null;
  failed: boolean;
  next: string;
}

export function parseSeverity(v: string | undefined, next: string): Severity | null {
  if (v === undefined) return null;
  if (v === "high" || v === "medium" || v === "low") return v;
  throw new CliError("USAGE", `--fail-on must be high, medium or low, got "${v}"`, next, EXIT.usage);
}

export function parseDays(v: string | number | undefined, next: string): number {
  if (v === undefined) return 30;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new CliError("USAGE", `--days must be a whole number from 1 to 90, got "${v}"`, next, EXIT.usage);
  return n;
}

function toScanWorkflow(w: AuditedWorkflow): ScanWorkflow {
  return {
    path: w.path,
    name: w.model.name,
    events: w.model.events,
    jobs: w.estimate.jobs.map((j) => ({
      id: j.jobId,
      name: w.model.jobs.find((m) => m.id === j.jobId)?.name ?? null,
      runs_on: w.model.jobs.find((m) => m.id === j.jobId)?.runsOn ?? [],
      provider: j.provider,
      os: j.os,
      runs_per_month: j.runsPerMonth,
      minutes_per_run: j.minutesPerRun,
      minutes_per_month: j.minutesPerMonth,
      cents_per_month: j.centsPerMonth,
      basis: j.basis,
    })),
    estimate: { runs_per_month: w.estimate.runsPerMonth, runs_by_event: w.estimate.runsByEvent, minutes_per_month: w.estimate.minutesPerMonth, cents_per_month: w.estimate.centsPerMonth },
    findings: w.findings.length,
  };
}

/** The scan as a function so it can be tested in-process with the GitHub module mocked. */
export async function runScan(path: string, opts: ScanOptions): Promise<ScanResult> {
  const next = `buildhound scan ${path}${opts.repo ? ` --repo ${opts.repo}` : ""}`;
  const days = parseDays(opts.days, next);
  const only = opts.rules ? opts.rules.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const rules = selectRules(only, next);
  const src = await withDefaultTokenPermission(await resolveSource({ path, repo: opts.repo, token: opts.token, days, next, offline: opts.offline }), rules, opts.token);
  const failOn = parseSeverity(opts.failOn, next) ?? src.config.check.failOnSeverity;
  const pinning = !opts.offline && opts.resolve !== false && rules.some((r) => r.meta.id === "R17") && !src.config.rules.disabledRules?.includes("R17");
  const resolveActionRef = pinning ? await actionRefResolver(src.workflows, { token: findToken(opts.token) }) : undefined;
  const a = await audit(src, rules, resolveActionRef);
  const findings = [...a.findings].sort((x, y) => y.estimate.centsPerMonth - x.estimate.centsPerMonth || x.ruleId.localeCompare(y.ruleId));
  const workflows = a.workflows.map(toScanWorkflow);
  const failed = failOn !== null && findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
  return {
    repo: src.repo,
    path,
    history_days: src.history ? src.history.days : null,
    rules: a.rules,
    workflows,
    findings,
    totals: {
      minutes_per_month: workflows.reduce((n, w) => n + w.estimate.minutes_per_month, 0),
      cents_per_month: workflows.reduce((n, w) => n + w.estimate.cents_per_month, 0),
      findings: findings.length,
      saving_cents_per_month: findings.reduce((n, f) => n + f.estimate.centsPerMonth, 0),
    },
    payback: repoPayback(workflows),
    assumptions: src.note ? [src.note, ...a.assumptions] : a.assumptions,
    fail_on: failOn,
    failed,
    next: opts.repo || src.history ? `buildhound route ${path} --repo ${opts.repo ?? src.repo}` : `buildhound scan ${path} --repo ${src.repo === "local/repo" ? "<owner/name>" : src.repo} --token $(gh auth token)`,
  };
}

/** Team billed monthly; the saving never uses the cheaper annual price, so none is overstated (BILLING.md). */
const TEAM_MONTHLY_CENTS = 2400;

function repoPayback(workflows: ScanWorkflow[]): ScanResult["payback"] {
  const jobs = workflows.flatMap((w) => w.jobs).filter((j) => j.provider === "github" && (j.os === "macos" || j.os === "linux"));
  const hosted = jobs.reduce((n, j) => n + j.cents_per_month, 0);
  const macos = jobs.filter((j) => j.os === "macos").reduce((n, j) => n + j.cents_per_month, 0);
  const p = payback({ hostedCentsPerMonth: hosted, machineFeeCents: TEAM_MONTHLY_CENTS, peakConcurrency: 1 });
  return { hosted_cents_per_month: hosted, macos_cents_per_month: macos, machine_fee_cents: TEAM_MONTHLY_CENTS, hardware_cents: DEFAULT_HARDWARE_CENTS, machines_needed: p.machinesNeeded, monthly_saving_cents: p.monthlySavingCents, payback_months: p.paybackMonths };
}

/** Whole dollars when the cents are round: "$24", "$65.40". */
const fee = (cents: number): string => (cents % 100 === 0 ? `$${cents / 100}` : money(cents));

/**
 * The monthly saving on machines the team already has, after the plan: nothing is bought, so there is no payback
 * period (the founder, 2026-10-15). A Mac when every moving job is macOS, otherwise a machine.
 */
export function ownedSavingLine(p: Pick<ScanResult["payback"], "hosted_cents_per_month" | "macos_cents_per_month" | "machine_fee_cents" | "machines_needed" | "monthly_saving_cents">, plan = "Team"): string {
  if (p.hosted_cents_per_month <= 0) return "No macOS or Linux jobs here run on GitHub-hosted, so a machine you already have would add speed, not savings.";
  const kind = p.macos_cents_per_month >= p.hosted_cents_per_month ? "Mac" : "machine";
  const yours = p.machines_needed === 1 ? `a ${kind} you already have` : `${p.machines_needed} ${kind}s you already have`;
  const price = `${plan} at ${fee(p.machine_fee_cents)} a ${p.machines_needed === 1 ? "month" : "machine a month"}`;
  if (p.monthly_saving_cents <= 0) return `At ${money(p.hosted_cents_per_month)} a month on GitHub-hosted, ${price} costs more than these jobs, so ${yours} would add speed, not savings.`;
  return `${yours.charAt(0).toUpperCase()}${yours.slice(1)} would save ${money(p.monthly_saving_cents)} a month on these jobs, after ${price}.`;
}

const shortPath = (p: string): string => p.replace(/^\.github\/workflows\//, "");

export function prettyScan(r: ScanResult): string {
  const source = r.history_days ? `priced from the last ${r.history_days} days of runs` : "a static scan with no run history";
  const lines = [`Found ${count(r.findings.length, "finding")} in ${count(r.workflows.length, "workflow")} for ${r.repo}, ${source}`];
  if (r.findings.length) {
    const rows = r.findings.map((f) => [`${f.ruleId} ${f.title}`, shortPath(f.workflowPath), f.jobName ?? "", money(f.estimate.centsPerMonth), `${Math.round(f.estimate.confidence * 100)}%`, f.severity]);
    lines.push("", ...table(["RULE", "WORKFLOW", "JOB", "$/MONTH", "CONFIDENCE", "SEVERITY"], rows, { right: [3, 4] }));
  }
  lines.push("", `${count(r.workflows.length, "workflow")} use ${r.totals.minutes_per_month} minutes, ${money(r.totals.cents_per_month)} a month on their current runners. The findings could save ${money(r.totals.saving_cents_per_month)} a month.`);
  lines.push(ownedSavingLine(r.payback));
  if (r.assumptions.length) lines.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  if (r.fail_on) lines.push("", r.failed ? failed(`Findings at ${r.fail_on} severity or above, so this exits 1`) : done(`No findings at ${r.fail_on} severity or above`));
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function scanCommand(): Command {
  return new Command("scan")
    .description("Scan workflow files for a CI report: findings on wasted CI spend, each with a fix, priced from run history when the repository and a GitHub login are found (or --repo is given); --fix opens the fixes as pull requests")
    .argument("[path]", "directory containing .github/workflows", ".")
    .option("--repo <owner/name>", "fetch the last --days of runs from GitHub and run dynamic rules too")
    .option("--token <token>", "GitHub token for --repo; else GITHUB_TOKEN, else `gh auth token`")
    .option("--rules <ids>", "comma-separated rule ids to run, for example R01,R03")
    .option("--fail-on <severity>", "exit 1 when a finding at or above this severity exists: high, medium or low")
    .option("--days <n>", "days of run history to fetch", "30")
    .option("--offline", "workflow files only: no run history, no network")
    .option("--no-resolve", "do not look up action tags on GitHub to pin them (R17 findings come without a diff)")
    .option("--fix", "open the CI report's fixes as pull requests on GitHub, one per rule; plans only, until --yes")
    .option("--rule <id>", "with --fix: a rule to open a pull request for, repeatable (--rule R03 --rule R06)", (v: string, acc: string[] = []) => [...acc, v])
    .option("--one-pr", "with --fix: one pull request for every fix instead of one per rule")
    .option("--dry-run", "with --fix: print the branches, files and pull request bodies without writing to GitHub")
    .option("--yes", "with --fix: open the pull requests without asking")
    .option("--json", "JSON output")
    .action(async (path: string, opts: ScanFixOptions & { fix?: boolean }) => {
      if (opts.fix) return scanFix(path, opts);
      const stray = (["rule", "onePr", "dryRun", "yes"] as const).find((k) => opts[k] !== undefined);
      if (stray) throw new CliError("USAGE", `--${stray.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} only works with --fix`, `buildhound scan${path === "." ? "" : ` ${path}`} --fix`, EXIT.usage);
      const r = await runScan(path, opts);
      emit(r, opts, prettyScan);
      if (r.failed) process.exitCode = EXIT.findings;
    });
}

/**
 * `scan --fix` (AGENT_FIRST.md rule 2): without --yes and without a terminal it returns the plan with `next` set to
 * the same command with --yes; in a terminal it shows the plan and asks once before opening anything.
 */
async function scanFix(path: string, opts: ScanFixOptions): Promise<void> {
  const interactive = !opts.yes && !opts.dryRun && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !wantsJson(opts);
  if (!interactive) return emit(await runScanFix(path, opts), opts, prettyFix);
  const plan = await runScanFix(path, { ...opts, yes: false });
  const opening = plan.pull_requests.filter((p) => p.status === "planned");
  if (!opening.length) return emit(plan, opts, prettyFix);
  process.stdout.write(prettyFix(plan, false) + "\n\n");
  await confirm(false, `Open ${opening.length === 1 ? "this pull request" : `these ${opening.length} pull requests`} on ${plan.repo}?`, plan.next.replace(/ --yes$/, ""));
  emit(await runScanFix(path, { ...opts, yes: true }), opts, prettyFix);
}
