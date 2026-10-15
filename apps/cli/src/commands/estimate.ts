import path from "node:path";
import { Command } from "commander";
import { Estimator, loadWorkflow } from "@buildhound/core";
import type { History, NormalisedWorkflow } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { loadConfig } from "../lib/config";
import { readWorkflowFile, resolveUserPath } from "../lib/workflows";
import { CliError, emit } from "../output";
import { money, next, table } from "../lib/style";
import type { ScanJob } from "./scan";

export interface EstimateOptions {
  runsPerMonth?: string | number | undefined;
  json?: boolean | undefined;
}

export interface EstimateResult {
  workflow: string;
  name: string | null;
  events: string[];
  schedules: string[];
  runs_per_month: number;
  runs_by_event: Record<string, number>;
  jobs: ScanJob[];
  minutes_per_month: number;
  cents_per_month: number;
  assumptions: string[];
  next: string;
}

/** The estimator with every event's runs replaced by the --runs-per-month figure. */
class FixedRunsEstimator extends Estimator {
  constructor(overrides: Record<string, number>, isPublic: boolean, private readonly runs: number) {
    super(overrides, isPublic);
  }
  override runsByEvent(model: NormalisedWorkflow, _history: History | null, _workflowPath: string): { byEvent: Record<string, number>; assumptions: string[] } {
    const byEvent: Record<string, number> = {};
    for (const event of model.events) byEvent[event] = this.runs;
    return { byEvent, assumptions: [`every event set to ${this.runs} runs a month by --runs-per-month`] };
  }
}

export function parseRuns(v: string | number | undefined, next: string): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError("USAGE", `--runs-per-month must be a whole number, got "${v}"`, next, EXIT.usage);
  return n;
}

export function runEstimate(file: string, opts: EstimateOptions): EstimateResult {
  const next = `buildhound estimate ${file}`;
  const runs = parseRuns(opts.runsPerMonth, next);
  const w = readWorkflowFile(file);
  const abs = resolveUserPath(file);
  const config = loadConfig(path.dirname(abs));
  let loaded;
  try {
    loaded = loadWorkflow(w.path, w.content);
  } catch (e) {
    throw new CliError("WORKFLOW_INVALID", `${w.path}: ${e instanceof Error ? e.message : String(e)}`, next, EXIT.usage);
  }
  const estimator = runs === null ? new Estimator(config.overrides, false) : new FixedRunsEstimator(config.overrides, false, runs);
  const est = estimator.estimateWorkflow(loaded.model, null, w.path);
  const assumptions = [...est.assumptions, "repository assumed private; GitHub-hosted minutes are free on public repositories", "minutes per run are the defaults from COST_MODEL.md; run `scan --repo` for observed minutes"];
  if (config.path) assumptions.push(`configuration read from ${config.path}`);
  const jobs: ScanJob[] = est.jobs.map((j) => {
    const m = loaded.model.jobs.find((x) => x.id === j.jobId);
    return { id: j.jobId, name: m?.name ?? null, runs_on: m?.runsOn ?? [], provider: j.provider, os: j.os, runs_per_month: j.runsPerMonth, minutes_per_run: j.minutesPerRun, minutes_per_month: j.minutesPerMonth, cents_per_month: j.centsPerMonth, basis: j.basis };
  });
  const root = abs.split(path.sep).includes(".github") ? abs.split(`${path.sep}.github${path.sep}`)[0]! : path.dirname(abs);
  return {
    workflow: w.path,
    name: loaded.model.name,
    events: loaded.model.events,
    schedules: loaded.model.schedules,
    runs_per_month: est.runsPerMonth,
    runs_by_event: est.runsByEvent,
    jobs,
    minutes_per_month: est.minutesPerMonth,
    cents_per_month: est.centsPerMonth,
    assumptions,
    next: `buildhound scan ${path.relative(process.cwd(), root) || "."}`,
  };
}

export function prettyEstimate(r: EstimateResult): string {
  const lines = [`${r.workflow}${r.name ? ` (${r.name})` : ""}: ${r.runs_per_month} runs a month from ${r.events.join(", ") || "no events"}`];
  if (r.jobs.length) {
    const rows = r.jobs.map((j) => [j.name ?? j.id, j.runs_on.join(", "), String(j.minutes_per_run), String(j.runs_per_month), String(j.minutes_per_month), money(j.cents_per_month)]);
    lines.push("", ...table(["JOB", "RUNS ON", "MIN/RUN", "RUNS", "MIN/MONTH", "$/MONTH"], rows, { right: [2, 3, 4, 5] }));
  }
  lines.push("", `${r.minutes_per_month} minutes, ${money(r.cents_per_month)} a month`);
  if (r.assumptions.length) lines.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function estimateCommand(): Command {
  return new Command("estimate")
    .description("Monthly cost of one workflow file, with the assumptions listed")
    .argument("<workflow-file>", "path to a workflow YAML file")
    .option("--runs-per-month <n>", "override the runs per month for every event")
    .option("--json", "JSON output")
    .action((file: string, opts: EstimateOptions) => {
      emit(runEstimate(file, opts), opts, prettyEstimate);
    });
}
