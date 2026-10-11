import { Command } from "commander";
import { payback, type Finding } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { audit, resolveSource, selectRules } from "../lib/audit";
import type { AuditedWorkflow } from "../lib/audit";
import { CliError, emit } from "../output";

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
  /** Repository-level case for a connected machine: GitHub-hosted spend that would move, Team fee, machines, payback month. */
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
  const src = await resolveSource({ path, repo: opts.repo, token: opts.token, days, next, offline: opts.offline });
  const failOn = parseSeverity(opts.failOn, next) ?? src.config.check.failOnSeverity;
  const a = await audit(src, rules);
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

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function repoPayback(workflows: ScanWorkflow[]): ScanResult["payback"] {
  const jobs = workflows.flatMap((w) => w.jobs).filter((j) => j.provider === "github" && (j.os === "macos" || j.os === "linux"));
  const hosted = jobs.reduce((n, j) => n + j.cents_per_month, 0);
  const macos = jobs.filter((j) => j.os === "macos").reduce((n, j) => n + j.cents_per_month, 0);
  const p = payback({ hostedCentsPerMonth: hosted, machineFeeCents: 2000, peakConcurrency: 1 });
  return { hosted_cents_per_month: hosted, macos_cents_per_month: macos, machine_fee_cents: 2000, hardware_cents: 89900, machines_needed: p.machinesNeeded, monthly_saving_cents: p.monthlySavingCents, payback_months: p.paybackMonths };
}

export function prettyScan(r: ScanResult): string {
  const lines: string[] = [];
  lines.push(`${r.repo}: ${r.workflows.length} workflow${r.workflows.length === 1 ? "" : "s"}, ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}${r.history_days ? ` (last ${r.history_days} days of runs)` : " (static scan, no run history)"}`);
  if (r.findings.length) {
    const rows = r.findings.map((f) => [f.ruleId, f.workflowPath, f.jobName ?? "-", usd(f.estimate.centsPerMonth), `${Math.round(f.estimate.confidence * 100)}%`, f.severity]);
    const head = ["RULE", "WORKFLOW", "JOB", "$/MONTH", "CONF", "SEVERITY"];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
    const fmt = (row: string[]) => row.map((c, i) => (i === 3 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ");
    lines.push("", fmt(head), ...rows.map(fmt));
  }
  lines.push("", `Totals: ${r.totals.minutes_per_month} minutes, ${usd(r.totals.cents_per_month)} a month on current runners; findings could save ${usd(r.totals.saving_cents_per_month)} a month`);
  const pb = r.payback;
  lines.push(pb.payback_months === null ? `A connected machine would not pay for itself at this spend (${usd(pb.hosted_cents_per_month)} a month GitHub-hosted).` : `A $${(pb.hardware_cents / 100).toFixed(0)} Mac mini on Team ($20 a month) would save ${usd(pb.monthly_saving_cents)} a month and pay for itself in month ${pb.payback_months}.`);
  if (r.assumptions.length) lines.push("", "Assumptions:", ...r.assumptions.map((a) => `  - ${a}`));
  if (r.fail_on) lines.push("", `--fail-on ${r.fail_on}: ${r.failed ? "failed" : "passed"}`);
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function scanCommand(): Command {
  return new Command("scan")
    .description("Audit workflow files for wasted CI spend, priced from run history when the repository and a GitHub login are found (or --repo is given)")
    .argument("[path]", "directory containing .github/workflows", ".")
    .option("--repo <owner/name>", "fetch the last --days of runs from GitHub and run dynamic rules too")
    .option("--token <token>", "GitHub token for --repo; else GITHUB_TOKEN, else `gh auth token`")
    .option("--rules <ids>", "comma-separated rule ids to run, for example R01,R03")
    .option("--fail-on <severity>", "exit 1 when a finding at or above this severity exists: high, medium or low")
    .option("--days <n>", "days of run history to fetch", "30")
    .option("--offline", "workflow files only: no run history, no network")
    .option("--json", "JSON output")
    .action(async (path: string, opts: ScanOptions) => {
      const r = await runScan(path, opts);
      emit(r, opts, prettyScan);
      if (r.failed) process.exitCode = EXIT.findings;
    });
}
