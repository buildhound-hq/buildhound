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
  const api = ApiClient.forCommand(opts, next);
  const body = await api.expect<JobsResponse>(
    "GET",
    `/v1/accounts/${encodeURIComponent(owner)}/jobs${query({ repository: opts.repository, machine: opts.machine, label: opts.label, result: opts.result, limit: opts.limit, before: opts.before })}`,
    undefined,
    next,
  );
  const more = body.next_before ? `buildhound jobs --org ${owner} --before ${body.next_before}` : null;
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

/** The job table `jobs` and `overview` share: symbol first, times right-aligned, age relative and dimmed. */
export function jobTable(jobs: JobItem[]): string[] {
  const rows = jobs.map((j) => [resultSymbol(result(j)), j.name ?? "", j.repository ?? "", j.machine.name, duration(j.wait_seconds), j.status === "running" ? "" : duration(j.duration_seconds), money(j.hosted_equivalent_cents), color.dim(ago(j.started_at ?? j.queued_at))]);
  return table(["", "JOB", "REPOSITORY", "MACHINE", "WAITED", "TOOK", "ON GITHUB", "AGE"], rows, { right: [4, 5, 6] });
}

export function prettyJobs(r: JobsResult): string {
  const scope = r.role === "member" ? " in repositories you can read" : "";
  if (!r.jobs.length) return [`No jobs yet for ${r.owner}${scope}`, "", next(r.next)].join("\n");
  return [`Showing ${count(r.jobs.length, "recent job")} for ${r.owner}${scope}`, "", ...jobTable(r.jobs), "", next(r.next)].join("\n");
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
      ["Ran on GitHub", String(r.fell_back)],
    ]),
  ];
  if (r.machines.length) lines.push("", ...table(["MACHINE", "STATUS", "TRUST", "RUNNING"], r.machines.map((m) => [m.name, statusWord(m.status), m.trust === "trusted" ? "trusted" : "no secrets", String(m.running_jobs)]), { right: [3] }));
  if (r.recent_jobs.length) lines.push("", "Recent jobs", "", ...jobTable(r.recent_jobs));
  for (const a of r.attention) lines.push("", ...needed(a.detail, a.next));
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
    `What the jobs on ${r.owner}'s machines would have cost on GitHub`,
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
      .description("Jobs your machines ran, newest first, with wait, run time and what GitHub-hosted would have cost")
      .option("--repository <owner/name>", "only this repository")
      .option("--machine <name|id>", "only this machine")
      .option("--label <label>", "only this label, such as buildhound-macos")
      .option("--result <result>", "success, failure, cancelled, or running"),
  )
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
