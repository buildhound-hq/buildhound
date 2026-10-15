import { attribute } from "@buildhound/core";
import type { History, JobRecord, RunRecord, StepRecord } from "@buildhound/core";
import { GitHubApiError } from "./client";
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
  /** Clock in epoch milliseconds for the shortened window; defaults to Date.now. */
  now?: () => number;
  onProgress?: (progress: HistoryProgress) => void;
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
  history: History;
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

  report({ stage: "repository", done: 0, total: 1 });
  const repository = options.repository ?? (await client.getRepository(owner, repo));
  report({ stage: "repository", done: 1, total: 1 });

  const workflowList = await client.listWorkflows(owner, repo);
  report({ stage: "workflows", done: 0, total: workflowList.length });
  let workflowsDone = 0;
  const workflowFiles = await pool(workflowList, concurrency, async (workflow) => {
    try {
      const file = await client.getWorkflowContent(
        owner,
        repo,
        workflow.path,
        options.ref ?? repository.defaultBranch,
      );
      return { id: workflow.id, path: workflow.path, name: workflow.name, content: file.content };
    } catch (error) {
      // Workflows listed by GitHub but absent from the default branch (deleted files, or the
      // dynamic/ pages workflow) have nothing for the static rules to read; skip them.
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    } finally {
      workflowsDone++;
      report({ stage: "workflows", done: workflowsDone, total: workflowList.length });
    }
  });
  const workflows = workflowFiles.filter((file): file is WorkflowFile => file !== null);

  report({ stage: "runs", done: 0, total: null });
  const rawRuns = await client.listRuns(owner, repo, {
    sinceDays: days,
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
  });
  const runs = rawRuns.map(toRunRecord);
  report({ stage: "runs", done: runs.length, total: runs.length });

  // Runs still in progress are kept in the history but their jobs are not fetched yet: the job
  // timings would be incomplete and the completed webhook brings them later.
  const completedRuns = rawRuns.filter((run) => run.status === "completed");
  report({ stage: "jobs", done: 0, total: completedRuns.length });
  let runsDone = 0;
  const jobsPerRun = await pool(completedRuns, concurrency, async (run) => {
    const jobs = await client.listJobs(owner, repo, run.id);
    runsDone++;
    report({ stage: "jobs", done: runsDone, total: completedRuns.length });
    return jobs.map(toJobRecord);
  });
  const jobs = jobsPerRun.flat();

  return { repository, workflows, history: { days: windowDays(days, runs, options.maxRuns, (options.now ?? Date.now)()), runs, jobs } };
}

/**
 * The window the runs stand for: `days`, or, when `maxRuns` cut the list short, the whole days from the
 * oldest run kept to now, at least one. Runs per month scale by 30 over this.
 */
function windowDays(days: number, runs: RunRecord[], maxRuns: number | undefined, nowMs: number): number {
  if (maxRuns === undefined || runs.length < maxRuns || runs.length === 0) return days;
  const oldest = Math.min(...runs.map((r) => r.createdAt.getTime()));
  const span = (nowMs - oldest) / 86_400_000;
  return Math.min(days, Math.max(1, Math.ceil(span)));
}
