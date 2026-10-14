import { Command } from "commander";
import { EXIT, type JobItem, type JobResponse, type JobsResponse, type OverviewResponse, type SavingsResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";

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

const dollars = (cents: number | null): string => (cents === null ? "-" : `$${(cents / 100).toFixed(2)}`);
const secs = (s: number | null): string => (s === null ? "-" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)];
}

const jobRow = (j: JobItem): string[] => [j.started_at?.slice(0, 16).replace("T", " ") ?? "-", j.repository ?? "-", j.name ?? "-", j.machine.name, j.status === "running" ? "running" : (j.conclusion ?? "-"), secs(j.wait_seconds), secs(j.duration_seconds), dollars(j.hosted_equivalent_cents)];
const JOB_HEAD = ["STARTED (UTC)", "REPOSITORY", "JOB", "MACHINE", "RESULT", "WAIT", "TIME", "ON HOSTED"];

export function prettyJobs(r: JobsResult): string {
  const lines = [`${r.owner}: ${r.jobs.length} job${r.jobs.length === 1 ? "" : "s"}${r.role === "member" ? " in repositories you can read" : ""}`];
  if (r.jobs.length) lines.push("", ...table(JOB_HEAD, r.jobs.map(jobRow)));
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function prettyJob(r: JobResult): string {
  const j = r.job;
  const lines = [
    `${j.repository ?? "unknown repository"}: ${j.name ?? "job"} on ${j.machine.name}`,
    `  status      ${j.status === "running" ? "running" : (j.conclusion ?? "-")}`,
    `  label       ${j.label}`,
    `  queued      ${j.queued_at ?? "-"}`,
    `  started     ${j.started_at ?? "-"} (waited ${secs(j.wait_seconds)})`,
    `  finished    ${j.completed_at ?? "-"} (ran ${secs(j.duration_seconds)})`,
    `  on hosted   ${dollars(j.hosted_equivalent_cents)}`,
  ];
  if (r.calculation) lines.push(`  how         ${r.calculation}`);
  if (r.reruns.length) {
    lines.push("", "re-runs:");
    for (const x of r.reruns) lines.push(`  ${x.rerun_at.slice(0, 16).replace("T", " ")}  ${x.job_name}: ${x.reason}, routed to ${x.routed_to === "hosted" ? "GitHub-hosted" : "a machine"}`);
  }
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function prettyOverview(r: OverviewResult): string {
  const lines = [
    `${r.owner}, ${r.period.start.slice(0, 7)}`,
    `  jobs on your machines  ${r.jobs_on_machines} (${r.machine_minutes} min)`,
    `  same jobs on hosted    ${dollars(r.hosted_equivalent_cents)}`,
    `  fell back to hosted    ${r.fell_back}`,
  ];
  if (r.machines.length) lines.push("", ...table(["MACHINE", "STATUS", "RUNNING", "TRUST"], r.machines.map((m) => [m.name, m.status, String(m.running_jobs), m.trust])));
  if (r.recent_jobs.length) lines.push("", "recent jobs:", ...table(JOB_HEAD, r.recent_jobs.map(jobRow)));
  if (r.attention.length) {
    lines.push("", "needs you:");
    for (const a of r.attention) lines.push(`  ! ${a.detail}`, `    ${a.next}`);
  }
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function prettySavings(r: SavingsResult): string {
  const lines = [`${r.owner}: what the jobs on your machines would have cost on GitHub-hosted`, "", ...table(["MONTH", "JOBS", "MINUTES", "ON HOSTED"], r.months.map((m) => [m.month, String(m.jobs), String(m.minutes), dollars(m.hosted_equivalent_cents)]))];
  if (r.machines.length > 1) {
    lines.push("", ...table(["MACHINE", "JOBS", "ON HOSTED"], r.machines.map((m) => [m.name, String(m.months.reduce((n, x) => n + x.jobs, 0)), dollars(m.months.reduce((n, x) => n + x.hosted_equivalent_cents, 0))])));
  }
  lines.push("", r.calculation, "", `next: ${r.next}`);
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
