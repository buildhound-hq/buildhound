import { Command } from "commander";
import { EXIT, reasonText, type JobItem, type JobResponse, type JobsResponse, type OverviewResponse, type SavingsResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { ago, color, count, duration, fields, monthName, money, needed, next, resultSymbol, table } from "../lib/style";
import { labelName, statusWord } from "./runner-status";

// Read commands over the endpoints the dashboard uses (B03): jobs, one job, the month's overview and
// savings. What a person sees follows their role on GitHub; a member sees only repositories they can read.

interface ReadOptions {
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface JobsOptions extends ReadOptions {
  repository?: string | undefined;
  machine?: string | undefined;
  label?: string | undefined;
  result?: string | undefined;
  limit?: string | undefined;
  before?: string | undefined;
  /** Comma separated, each filter (Q-Filters board): machine, github_hosted or all (the default). */
  ranOn?: string | undefined;
  /** running, failed, succeeded, cancelled. */
  status?: string | undefined;
  workflow?: string | undefined;
  /** macos, linux, windows. */
  os?: string | undefined;
  /** Counts per value of each filter, as the dashboard's Filter menu shows them. */
  facets?: boolean | undefined;
}

const ALLOWED: Record<string, readonly string[]> = {
  "ran-on": ["machine", "github_hosted", "all"],
  status: ["running", "failed", "succeeded", "cancelled", "skipped"],
  os: ["macos", "linux", "windows"],
};

/** A comma separated flag, each value checked against what the API takes, so a typo fails here with the choices. */
function checkList(owner: string, flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((v) => v.trim()).filter(Boolean);
  const bad = values.filter((v) => !ALLOWED[flag]!.includes(v));
  if (bad.length) throw new CliError("USAGE", `--${flag} takes ${ALLOWED[flag]!.join(", ")}, comma separated; got ${bad.join(", ")}`, `buildhound jobs --org ${owner} --${flag} ${ALLOWED[flag]![0]}`, EXIT.usage);
  return values.join(",");
}

function requireOrg(opts: ReadOptions, command: string): string {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user whose machines ran the jobs", `buildhound ${command} --org <login>`, EXIT.usage);
  return opts.org;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type JobsResult = JobsResponse & { owner: string; next: string };

export async function runJobs(opts: JobsOptions): Promise<JobsResult> {
  const owner = requireOrg(opts, "jobs");
  const next = `buildhound jobs --org ${owner}`;
  const ranOn = checkList(owner, "ran-on", opts.ranOn);
  const status = checkList(owner, "status", opts.status);
  const os = checkList(owner, "os", opts.os);
  const api = ApiClient.forCommand(opts, next);
  const params = { repository: opts.repository, machine: opts.machine, workflow: opts.workflow, label: opts.label, result: opts.result, status, ran_on: ranOn, os, limit: opts.limit, before: opts.before, facets: opts.facets ? "1" : undefined };
  const body = await api.expect<JobsResponse>(
    "GET",
    `/v1/accounts/${encodeURIComponent(owner)}/jobs${query(params)}`,
    undefined,
    next,
  );
  // The next page keeps the filters.
  const flags = Object.entries({ repository: opts.repository, machine: opts.machine, workflow: opts.workflow, label: opts.label, result: opts.result, status, "ran-on": ranOn, os, limit: opts.limit })
    .filter(([, v]) => v)
    .map(([k, v]) => ` --${k} ${v}`)
    .join("");
  const more = body.next_before ? `buildhound jobs --org ${owner}${flags} --before ${body.next_before}` : null;
  const first = body.jobs[0];
  return { ...body, owner, next: more ?? (first ? `buildhound job ${first.id} --org ${owner}` : `buildhound runner status --org ${owner}`) };
}

export type JobResult = JobResponse & { owner: string; next: string };

export async function runJob(id: string, opts: ReadOptions): Promise<JobResult> {
  const owner = requireOrg(opts, `job ${id}`);
  const next = `buildhound jobs --org ${owner}`;
  const api = ApiClient.forCommand(opts, next);
  const body = await api.expect<JobResponse>("GET", `/v1/accounts/${encodeURIComponent(owner)}/jobs/${encodeURIComponent(id)}`, undefined, next);
  return { ...body, owner, next: body.job.run_url ? `open ${body.job.run_url}` : next };
}

export type OverviewResult = OverviewResponse & { owner: string; next: string };

export async function runOverview(opts: ReadOptions & { month?: string | undefined }): Promise<OverviewResult> {
  const owner = requireOrg(opts, "overview");
  const next = `buildhound overview --org ${owner}`;
  const api = ApiClient.forCommand(opts, next);
  const body = await api.expect<OverviewResponse>("GET", `/v1/accounts/${encodeURIComponent(owner)}/overview${query({ month: opts.month })}`, undefined, next);
  return { ...body, owner, next: body.attention[0]?.next ?? `buildhound jobs --org ${owner}` };
}

export type SavingsResult = SavingsResponse & { owner: string; next: string };

export async function runSavings(opts: ReadOptions & { months?: string | undefined }): Promise<SavingsResult> {
  const owner = requireOrg(opts, "savings");
  const next = `buildhound savings --org ${owner}`;
  const api = ApiClient.forCommand(opts, next);
  const body = await api.expect<SavingsResponse>("GET", `/v1/accounts/${encodeURIComponent(owner)}/savings${query({ months: opts.months })}`, undefined, next);
  return { ...body, owner, next: `buildhound jobs --org ${owner}` };
}

const result = (j: JobItem): string => (j.status === "running" ? "running" : (j.conclusion ?? ""));

/**
 * The job table `jobs` and `overview` share: symbol first, times right-aligned, age relative and dimmed. A job that ran on
 * GitHub-hosted says why in a last column, in the words of the one table (why-hosted.ts).
 */
export function jobTable(jobs: JobItem[]): string[] {
  const why = jobs.some((j) => j.hosted_reason || j.cancel_reason);
  const rows = jobs.map((j) => [
    resultSymbol(result(j)),
    j.name ?? "",
    j.repository ?? "",
    j.machine.name,
    duration(j.wait_seconds),
    j.status === "running" ? "" : duration(j.duration_seconds),
    money(j.hosted_equivalent_cents),
    color.dim(ago(j.started_at ?? j.queued_at)),
    ...(why ? [j.cancel_reason?.summary ?? j.hosted_reason?.summary ?? ""] : []),
  ]);
  return table(["", "JOB", "REPOSITORY", "MACHINE", "WAITED", "TOOK", "ON GITHUB", "AGE", ...(why ? ["WHY"] : [])], rows, { right: [4, 5, 6] });
}

const FACET_NAMES: Array<[keyof NonNullable<JobsResponse["facets"]>, string]> = [["status", "Status"], ["ran_on", "Ran on"], ["machine", "Machine"], ["repository", "Repository"], ["workflow", "Workflow"], ["os", "OS"]];

/** `--facets`: each filter's values with their counts, the way the dashboard's Filter menu lists them. */
function facetLines(facets: NonNullable<JobsResponse["facets"]>): string[] {
  const word = (k: string, v: string) => (k === "ran_on" ? (v === "github_hosted" ? "GitHub-hosted" : "Your machines") : v === "" ? "not known" : v);
  return fields(FACET_NAMES.map(([k, name]) => [name, Object.entries(facets[k]).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${word(k, v)} ${n}`).join(", ")]));
}

export function prettyJobs(r: JobsResult): string {
  const scope = r.role === "member" ? " in repositories you can read" : "";
  const counts = r.facets ? ["", ...facetLines(r.facets)] : [];
  if (!r.jobs.length) return [`No jobs yet for ${r.owner}${scope}`, ...counts, "", next(r.next)].join("\n");
  return [`Showing ${count(r.jobs.length, "recent job")} for ${r.owner}${scope}`, "", ...jobTable(r.jobs), ...counts, "", next(r.next)].join("\n");
}

export function prettyJob(r: JobResult): string {
  const j = r.job;
  const open = r.next.startsWith("open ") ? r.next.slice(5) : null;
  const lines = [
    `${resultSymbol(result(j))} ${color.bold(j.name ?? "Job")}`,
    "",
    ...fields([
      ["Repository", j.repository ?? ""],
      ["Run", j.run_id === null ? "" : String(j.run_id)],
      ["Ran on", `${j.machine.name} (${labelName(j.label)})`],
      ["Started", ago(j.started_at)],
      ["Waited", duration(j.wait_seconds)],
      ["Took", j.status === "running" ? "still running" : duration(j.duration_seconds)],
      ["GitHub would charge", money(j.hosted_equivalent_cents)],
    ]),
  ];
  // Ran on GitHub-hosted: why, then the fix or that it comes back on its own (W-WhyHosted, "Job page").
  if (j.hosted_reason) lines.push("", `Ran on GitHub-hosted. ${j.hosted_reason.job}`, j.hosted_reason.who === "automatic" ? "Comes back on its own." : j.hosted_reason.fix);
  // Cancelled: why, Buildhound's re-run first, then what GitHub said (cancel_reason).
  if (j.cancel_reason) lines.push("", `Cancelled. ${j.cancel_reason.summary}.`, ...(j.cancel_reason.who === "you" ? [j.cancel_reason.fix] : []));
  if (r.reruns.length) {
    lines.push("", "Re-runs", "", ...table(["WHEN", "JOB", "WHY", "WENT TO"], r.reruns.map((x) => [color.dim(ago(x.rerun_at)), x.job_name, reasonText(x.reason), x.routed_to === "hosted" ? "GitHub-hosted" : "Your machines"])));
  }
  if (j.run_url) lines.push("", `Logs: ${j.run_url}`);
  lines.push("", next(open && open === j.run_url ? `buildhound jobs --org ${r.owner}` : r.next));
  return lines.join("\n");
}

export function prettyOverview(r: OverviewResult): string {
  const lines = [
    color.bold(`${r.owner}, ${monthName(r.period.start)}`),
    "",
    ...fields([
      ["Jobs on your machines", String(r.jobs_on_machines)],
      ["Minutes", String(r.machine_minutes)],
      ["GitHub would have charged", money(r.hosted_equivalent_cents)],
      ["Ran on GitHub-hosted", String(r.fell_back)],
    ]),
  ];
  if (r.machines.length) lines.push("", ...table(["MACHINE", "STATUS", "TRUST", "RUNNING"], r.machines.map((m) => [m.name, statusWord(m.status), m.trust === "trusted" ? "trusted" : "no secrets", String(m.running_jobs)]), { right: [3] }));
  // Jobs that wait for the machines with Fall back to GitHub-hosted off while one is online: status, said once per state.
  for (const w of r.waits ?? []) if (!w.act) lines.push("", w.title, color.dim(w.text));
  if (r.recent_jobs.length) lines.push("", "Recent jobs", "", ...jobTable(r.recent_jobs));
  // A waiting item names the cause in `detail` and says what happens in `why` (servers from 2026-10-19).
  for (const a of r.attention) lines.push("", ...needed(a.detail, ...(a.kind === "waiting_for_machine" && a.why ? [a.why] : []), a.next));
  lines.push("", next(r.next));
  return lines.join("\n");
}

const SAVINGS_NOTE = "Each job's minutes, rounded up, at GitHub's price for the runner it would have used. Your plan's flat fee is not subtracted.";

export function prettySavings(r: SavingsResult): string {
  const first = r.months.findIndex((m) => m.jobs > 0);
  if (first < 0) return [`No jobs on ${r.owner}'s machines yet`, "", next(r.next)].join("\n");
  const months = r.months.slice(first);
  const shown = new Set(months.map((m) => m.month));
  const lines = [
    `What the jobs on ${r.owner}'s machines would have cost on GitHub-hosted`,
    "",
    ...table(["MONTH", "JOBS", "MINUTES", "ON GITHUB"], months.map((m) => [monthName(m.month), String(m.jobs), String(m.minutes), money(m.hosted_equivalent_cents)]), { right: [1, 2, 3] }),
  ];
  if (r.machines.length) {
    const sum = (ms: SavingsResponse["months"], k: "jobs" | "minutes" | "hosted_equivalent_cents") => ms.filter((x) => shown.has(x.month)).reduce((n, x) => n + x[k], 0);
    lines.push("", ...table(["MACHINE", "JOBS", "MINUTES", "ON GITHUB"], r.machines.map((m) => [m.name, String(sum(m.months, "jobs")), String(sum(m.months, "minutes")), money(sum(m.months, "hosted_equivalent_cents"))]), { right: [1, 2, 3] }));
  }
  lines.push("", SAVINGS_NOTE, "", next(r.next));
  return lines.join("\n");
}

const common = (cmd: Command) => cmd.option("--org <login>", "GitHub organisation or user").option("--api-url <url>", "control plane URL").option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`").option("--json", "JSON output");

export function jobsCommand(): Command {
  return common(
    new Command("jobs")
      .description("Jobs on your machines and on GitHub-hosted, newest first, with wait and run time, and why a job meant for your machines ran on GitHub-hosted")
      .option("--repository <owner/name,...>", "only these repositories")
      .option("--machine <name|id,...>", "only these machines; github-hosted for jobs that ran there")
      .option("--label <label>", "only this label, such as buildhound-macos")
      .option("--result <result>", "success, failure, cancelled, or running"),
  )
    .option("--status <status,...>", "running, failed, succeeded, cancelled")
    .option("--ran-on <where,...>", "machine, github_hosted or all (default); jobs meant for your machines that ran on GitHub-hosted say why")
    .option("--workflow <name,...>", "only these workflows, such as ci")
    .option("--os <os,...>", "macos, linux, windows")
    .option("--facets", "also count jobs per value of each filter")
    .option("--limit <n>", "jobs per page, up to 200 (default 50)")
    .option("--before <time>", "the next page: the next_before value of the previous one")
    .action(async (opts: JobsOptions) => {
      emit(await runJobs(opts), opts, prettyJobs);
    });
}

export function jobCommand(): Command {
  return common(new Command("job").description("One job's story: waiting, where it ran, re-runs and its cost against GitHub-hosted").argument("<id>", "the job id from buildhound jobs")).action(async (id: string, opts: ReadOptions) => {
    emit(await runJob(id, opts), opts, prettyJob);
  });
}

export function overviewCommand(): Command {
  return common(new Command("overview").description("This month at a glance: jobs on your machines, their hosted cost, fallbacks, machines and what needs you"))
    .option("--month <YYYY-MM>", "another month, UTC")
    .action(async (opts: ReadOptions & { month?: string }) => {
      emit(await runOverview(opts), opts, prettyOverview);
    });
}

export function savingsCommand(): Command {
  return common(new Command("savings").description("Month by month, what the jobs on your machines would have cost on GitHub-hosted, with the calculation"))
    .option("--months <n>", "how many months back, up to 24 (default 6)")
    .action(async (opts: ReadOptions & { months?: string }) => {
      emit(await runSavings(opts), opts, prettySavings);
    });
}
