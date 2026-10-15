import { attribute } from "@buildhound/core";
import type { History, JobRecord, RunRecord, StepRecord } from "@buildhound/core";
import { GitHubApiError, UnreadableFileError } from "./client";
import type { GitHubClient, GitHubJob, GitHubRepository, GitHubRun } from "./client";

// Backfill stage 1 for one repository (ARCHITECTURE.md): workflows and their files, runs for the
// window, jobs per completed run. Jobs cost one request per run, so they go through a small pool.

export interface HistoryProgress {
  stage: "repository" | "workflows" | "runs" | "jobs";
  done: number;
  /** Null while the total is not yet known. */
  total: number | null;
}

export interface FetchHistoryOptions {
  client: GitHubClient;
  owner: string;
  repo: string;
  /** Window in days, default 30 (stage 1 of the backfill). */
  days?: number;
  /** Parallel job fetches, default 5. */
  concurrency?: number;
  /** The repository when the caller already read it; saves one request. */
  repository?: GitHubRepository;
  /** Commit to read workflow files at; the default branch when absent. */
  ref?: string;
  /**
   * Keep only the newest `maxRuns` runs, and fetch jobs for those alone, so a busy repository costs a bounded
   * number of requests. When the cap cuts the window short, `history.days` is the span the runs cover.
   */
  maxRuns?: number;
  /** Read at most this many workflow files, in GitHub's order; the rest are listed in `skipped`. */
  maxWorkflows?: number;
  /** Read at most this many jobs per run (one request per 100). */
  maxJobsPerRun?: number;
  /**
   * Checked before each request after the repository: true stops reading. Workflow files not yet read are listed in
   * `skipped`, and the history keeps only the newest runs whose jobs were all read, with the window shortened to them.
   */
  shouldStop?: () => boolean;
  /** Clock in epoch milliseconds for the shortened window; defaults to Date.now. */
  now?: () => number;
  onProgress?: (progress: HistoryProgress) => void;
}

/** A workflow GitHub lists that was not read, and why. */
export interface SkippedWorkflow {
  path: string;
  reason: string;
}

export interface WorkflowFile {
  id: number;
  path: string;
  name: string;
  content: string;
}

export interface HistoryResult {
  repository: GitHubRepository;
  workflows: WorkflowFile[];
  /** Workflow files that could not be read (a directory, a symlink, over 1 MB, an error) or were left by a limit. */
  skipped: SkippedWorkflow[];
  history: History;
  /** True when `maxRuns` cut the run list short. */
  capped: boolean;
  /** True when `shouldStop` ended the reading early. */
  partial: boolean;
}

/** Workflow files live under `.github/workflows/`; GitHub also lists `dynamic/...` workflows and, rarely, an empty path. */
function isWorkflowFile(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole seconds between two timestamps, 0 when either is missing (CLAUDE.md: seconds as integers). */
function durationSeconds(start: string | null | undefined, end: string | null | undefined): number {
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
}

export function toRunRecord(run: GitHubRun): RunRecord {
  const actorLogin = run.actor?.login ?? null;
  const { kind, agentName } = attribute({
    actorLogin,
    headBranch: run.head_branch,
    event: run.event,
  });
  const headFullName = run.head_repository?.full_name ?? null;
  return {
    id: run.id,
    workflowPath: run.path,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    actorLogin,
    actorKind: kind,
    agentName,
    createdAt: toDate(run.created_at) ?? new Date(0),
    runStartedAt: toDate(run.run_started_at),
    conclusion: run.conclusion,
    isFork: headFullName !== null && headFullName !== run.repository.full_name,
    isDraft: run.pull_requests?.[0]?.draft ?? false,
  };
}

export function toJobRecord(job: GitHubJob): JobRecord {
  const steps: StepRecord[] = (job.steps ?? []).map((step) => ({
    name: step.name,
    durationSeconds: durationSeconds(step.started_at, step.completed_at),
    conclusion: step.conclusion,
  }));
  return {
    id: job.id,
    runId: job.run_id,
    name: job.name,
    labels: job.labels ?? [],
    queuedAt: toDate(job.created_at),
    startedAt: toDate(job.started_at),
    completedAt: toDate(job.completed_at),
    conclusion: job.conclusion,
    steps,
  };
}

export async function fetchHistory(options: FetchHistoryOptions): Promise<HistoryResult> {
  const { client, owner, repo } = options;
  const days = options.days ?? 30;
  const concurrency = options.concurrency ?? 5;
  const report = options.onProgress ?? (() => {});
  const shouldStop = options.shouldStop ?? (() => false);
  let partial = false;
  const stop = (): boolean => {
    if (!partial && shouldStop()) partial = true;
    return partial;
  };

  report({ stage: "repository", done: 0, total: 1 });
  const repository = options.repository ?? (await client.getRepository(owner, repo));
  report({ stage: "repository", done: 1, total: 1 });

  const skipped: SkippedWorkflow[] = [];
  const listed = stop() ? [] : await client.listWorkflows(owner, repo);
  // Only files under .github/workflows/ can be read at a ref: `dynamic/...` workflows (Pages, Dependabot) have no
  // file, and GitHub sometimes lists a workflow with an empty path, which the Contents API answers with the root.
  const files = listed.filter((w) => isWorkflowFile(w.path));
  for (const w of listed) if (!isWorkflowFile(w.path) && w.path.startsWith(".github/")) skipped.push({ path: w.path, reason: "not a workflow file" });
  const maxWorkflows = options.maxWorkflows ?? Infinity;
  for (const w of files.slice(maxWorkflows)) skipped.push({ path: w.path, reason: `not read: only the first ${maxWorkflows} workflow files are read` });
  const workflowList = files.slice(0, maxWorkflows);
  report({ stage: "workflows", done: 0, total: workflowList.length });
  let workflowsDone = 0;
  const workflowFiles = await pool(workflowList, concurrency, async (workflow): Promise<WorkflowFile | SkippedWorkflow | null> => {
    if (stop()) return { path: workflow.path, reason: "not read: the scan ran out of time" };
    try {
      const file = await client.getWorkflowContent(
        owner,
        repo,
        workflow.path,
        options.ref ?? repository.defaultBranch,
      );
      return { id: workflow.id, path: workflow.path, name: workflow.name, content: file.content };
    } catch (error) {
      // Workflows listed by GitHub but absent from the ref (deleted files) have nothing for the static rules to read.
      if (error instanceof GitHubApiError && error.status === 404) return null;
      // One odd file never fails the scan: a symlink, a submodule, a file over 1 MB or a refused read is noted.
      if (error instanceof UnreadableFileError) return { path: workflow.path, reason: error.reason };
      if (error instanceof GitHubApiError) return { path: workflow.path, reason: `GitHub answered ${error.status}` };
      throw error;
    } finally {
      workflowsDone++;
      report({ stage: "workflows", done: workflowsDone, total: workflowList.length });
    }
  });
  const workflows: WorkflowFile[] = [];
  for (const f of workflowFiles) {
    if (f && "content" in f) workflows.push(f);
    else if (f) skipped.push(f);
  }

  report({ stage: "runs", done: 0, total: null });
  const rawRuns = stop()
    ? []
    : await client.listRuns(owner, repo, {
        sinceDays: days,
        ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
      });
  const capped = options.maxRuns !== undefined && rawRuns.length >= options.maxRuns;
  report({ stage: "runs", done: rawRuns.length, total: rawRuns.length });

  // Runs still in progress are kept in the history but their jobs are not fetched yet: the job
  // timings would be incomplete and the completed webhook brings them later.
  const completedRuns = rawRuns.filter((run) => run.status === "completed");
  report({ stage: "jobs", done: 0, total: completedRuns.length });
  let runsDone = 0;
  const maxJobs = options.maxJobsPerRun;
  const jobsPerRun = await pool(completedRuns, concurrency, async (run) => {
    if (stop()) return null;
    const jobs = await client.listJobs(owner, repo, run.id, maxJobs !== undefined ? { maxJobs } : {});
    runsDone++;
    report({ stage: "jobs", done: runsDone, total: completedRuns.length });
    return jobs.map(toJobRecord);
  });

  // When reading stopped early, keep the newest runs up to the first completed one whose jobs were not read, so
  // every run kept has its jobs and the window covers exactly the runs kept.
  const unread = completedRuns.findIndex((_, i) => jobsPerRun[i] === null);
  const cutAt = unread === -1 ? rawRuns.length : rawRuns.indexOf(completedRuns[unread]!);
  const keptRuns = rawRuns.slice(0, cutAt);
  const runs = keptRuns.map(toRunRecord);
  const jobs = jobsPerRun.slice(0, unread === -1 ? jobsPerRun.length : unread).flatMap((j) => j ?? []);
  const cut = capped || cutAt < rawRuns.length;

  return {
    repository,
    workflows,
    skipped,
    history: { days: windowDays(days, runs, cut, (options.now ?? Date.now)()), runs, jobs },
    capped,
    partial,
  };
}

/**
 * The window the runs stand for: `days`, or, when `maxRuns` or a stop cut the list short, the whole days from the
 * oldest run kept to now, at least one. Runs per month scale by 30 over this.
 */
function windowDays(days: number, runs: RunRecord[], cut: boolean, nowMs: number): number {
  if (!cut || runs.length === 0) return days;
  const oldest = Math.min(...runs.map((r) => r.createdAt.getTime()));
  const span = (nowMs - oldest) / 86_400_000;
  return Math.min(days, Math.max(1, Math.ceil(span)));
}
