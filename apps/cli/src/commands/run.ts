import { Command } from "commander";
import { EXIT, type DispatchResponse, type RerunResponse, type WorkflowsResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { CliError, emit } from "../output";
import { color, done, fields, next, table } from "../lib/style";

// Starting work by hand, as the dashboard's Run workflow and Re-run do (DASHBOARD.md, Jobs): `run` lists a repository's
// workflows that have `on: workflow_dispatch` and starts one through the GitHub App; `rerun` re-runs a finished job
// of the account's. Both start work that GitHub-hosted runs, and bills, when no machine can take it, so both need
// --yes (AGENT_FIRST.md rule 2). Only admins start anything; the control plane checks.

const REPO = /^[\w.-]+\/[\w.-]+$/;
const enc = encodeURIComponent;

interface ApiOpts {
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export interface RunOptions extends ApiOpts {
  repo?: string | undefined;
  workflow?: string | undefined;
  ref?: string | undefined;
  input?: string[] | undefined;
  yes?: boolean | undefined;
}

export type RunListResult = WorkflowsResponse & { mode: "list" };
export type RunResult = RunListResult | DispatchResponse;

/** `--input k=v`, repeatable; the first `=` splits, so a value may hold more. */
export function parseInputs(pairs: string[] | undefined, retry: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) throw new CliError("USAGE", `--input must be name=value, not ${pair}`, `${retry} --input <name>=<value>`, EXIT.usage);
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

/** The command again with every flag given, so `next` repeats it exactly. */
function runCommand(opts: RunOptions): string {
  const parts = [`buildhound run --repo ${opts.repo}`];
  if (opts.workflow) parts.push(`--workflow ${opts.workflow}`);
  if (opts.ref) parts.push(`--ref ${opts.ref}`);
  for (const i of opts.input ?? []) parts.push(`--input ${/\s/.test(i) ? JSON.stringify(i) : i}`);
  return parts.join(" ");
}

export async function runRun(opts: RunOptions): Promise<RunResult> {
  if (!opts.repo || !REPO.test(opts.repo)) throw new CliError("USAGE", "pass --repo <owner/name>: the repository whose workflow to run", "buildhound run --repo <owner/name>", EXIT.usage);
  const owner = opts.repo.split("/")[0]!;
  const base = runCommand(opts);
  if (!opts.workflow) {
    if (opts.ref || opts.input?.length) throw new CliError("USAGE", "pass --workflow with --ref or --input", `buildhound run --repo ${opts.repo}`, EXIT.usage);
    const api = ApiClient.forCommand(opts, base);
    const body = await api.expect<WorkflowsResponse>("GET", `/v1/accounts/${enc(owner)}/workflows?repository=${enc(opts.repo)}`, undefined, base);
    return { mode: "list", ...body };
  }
  const inputs = parseInputs(opts.input, base);
  await confirm(opts.yes, `Run ${opts.workflow} in ${opts.repo}${opts.ref ? ` on ${opts.ref}` : ""}? Its jobs run on your machines or, when none can take them, on GitHub-hosted runners that GitHub bills.`, base);
  const api = ApiClient.forCommand(opts, `${base} --yes`);
  const request = { repository: opts.repo, workflow: opts.workflow, ...(opts.ref ? { ref: opts.ref } : {}), inputs };
  return api.expect<DispatchResponse>("POST", `/v1/accounts/${enc(owner)}/workflows/dispatch`, request, `${base} --yes`);
}

export function prettyRun(r: RunResult): string {
  if ("mode" in r) {
    const lines: string[] = [];
    if (!r.workflows.length) {
      lines.push(`No workflow in ${r.repository} can be started by hand`, color.dim(`  Add on: workflow_dispatch to one: ${r.docs_url}`));
    } else {
      lines.push(`Workflows you can run in ${r.repository}`, "");
      lines.push(...table(["WORKFLOW", "FILE", "INPUTS"], r.workflows.map((w) => [w.name, w.path.replace(/^\.github\/workflows\//, ""), w.inputs.map((i) => `${i.name}${i.required && i.default === null ? "*" : ""}`).join(", ")])));
      if (r.workflows.some((w) => w.inputs.some((i) => i.required && i.default === null))) lines.push("", color.dim("* required"));
    }
    if (!r.can_run) lines.push("", color.dim(`Only admins of ${r.repository.split("/")[0]} can start them.`));
    lines.push("", next(r.next));
    return lines.join("\n");
  }
  return [
    done(r.status === "already_dispatched" ? `${r.workflow.name} was already started on ${r.ref} a moment ago` : `Started ${r.workflow.name} on ${r.ref} in ${r.repository}`),
    color.dim("  Its jobs show in buildhound jobs once a machine takes them; GitHub lists the run first."),
    "",
    ...fields([["Runs", r.runs_url]]),
    "",
    next(r.next),
  ].join("\n");
}

export interface RerunOptions extends ApiOpts {
  org?: string | undefined;
  job?: string | undefined;
  failed?: boolean | undefined;
  yes?: boolean | undefined;
}

export async function runRerun(opts: RerunOptions): Promise<RerunResponse> {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user whose machine ran the job", "buildhound rerun --org <login> --job <id> --yes", EXIT.usage);
  if (!opts.job) throw new CliError("USAGE", "pass --job <id>: the job id from buildhound jobs", `buildhound jobs --org ${opts.org} --result failure`, EXIT.usage);
  const base = `buildhound rerun --org ${opts.org} --job ${opts.job}${opts.failed ? " --failed" : ""}`;
  await confirm(opts.yes, `Re-run ${opts.failed ? "every failed job of this job's run" : `job ${opts.job}`}? It runs on your machines or, when none can take it, on GitHub-hosted runners that GitHub bills.`, base);
  const api = ApiClient.forCommand(opts, `${base} --yes`);
  return api.expect<RerunResponse>("POST", `/v1/accounts/${enc(opts.org)}/jobs/${enc(opts.job)}/rerun`, opts.failed ? { failed: true } : {}, `${base} --yes`);
}

export function prettyRerun(r: RerunResponse): string {
  return [
    done(r.scope === "failed_jobs" ? `Re-run requested for the failed jobs of run ${r.run_id} in ${r.repository}` : `Re-run requested for ${r.job.name ?? "the job"} in ${r.repository}`),
    "",
    ...fields([["Run", r.run_url]]),
    "",
    next(r.next),
  ].join("\n");
}

const api = (cmd: Command) => cmd.option("--api-url <url>", "control plane URL").option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`").option("--json", "JSON output");
const collect = (value: string, previous: string[] = []) => [...previous, value];

export function runWorkflowCommand(): Command {
  return api(
    new Command("run")
      .description("List a repository's workflows you can start by hand, or start one through the Buildhound GitHub App")
      .option("--repo <owner/name>", "the repository")
      .option("--workflow <file|id|name>", "the workflow to start, such as release.yml; without it, lists them")
      .option("--ref <branch|tag>", "the branch or tag to run on (default: the default branch)")
      .option("--input <name=value>", "a workflow_dispatch input; repeat for more", collect)
      .option("--yes", "start it without asking"),
  ).action(async (opts: RunOptions) => {
    emit(await runRun(opts), opts, prettyRun);
  });
}

export function rerunCommand(): Command {
  return api(
    new Command("rerun")
      .description("Re-run a finished job your machines ran, or every failed job of its run, through the Buildhound GitHub App")
      .option("--org <login>", "GitHub organisation or user")
      .option("--job <id>", "the job id from buildhound jobs")
      .option("--failed", "re-run every failed or cancelled job of the job's run instead")
      .option("--yes", "re-run without asking"),
  ).action(async (opts: RerunOptions) => {
    emit(await runRerun(opts), opts, prettyRerun);
  });
}
