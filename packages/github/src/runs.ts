import { createGitHubClient, GitHubApiError } from "./client";
import type { GitHubFetchOptions } from "./app-auth";

// Workflow runs and jobs, for the control plane's rescue of jobs GitHub stopped offering to a
// connected machine: find them, cancel their run once nothing else in it is running, re-run them.

export interface RunSummary {
  id: number;
  status: string;
  createdAt: string;
}

export interface RunJob {
  id: number;
  name: string;
  status: string;
  labels: string[];
  createdAt: string;
}

type Repo = { owner: string; repo: string };

/** Runs that can still hold a waiting job: queued, and in progress (one job running, another waiting). */
export async function listActiveRuns(token: string, r: Repo, options: GitHubFetchOptions = {}): Promise<RunSummary[]> {
  const client = createGitHubClient({ token, ...options });
  const out: RunSummary[] = [];
  for (const status of ["queued", "in_progress"]) {
    const page = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs?status=${status}&per_page=30`)) as {
      workflow_runs?: Array<{ id: number; status: string; created_at: string }>;
    };
    for (const run of page.workflow_runs ?? []) out.push({ id: run.id, status: run.status, createdAt: run.created_at });
  }
  return out;
}

export async function getRunStatus(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<string> {
  const client = createGitHubClient({ token, ...options });
  const run = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}`)) as { status: string };
  return run.status;
}

/** The latest attempt's jobs. */
export async function listRunJobs(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<RunJob[]> {
  const client = createGitHubClient({ token, ...options });
  const page = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`)) as {
    jobs?: Array<{ id: number; name: string; status: string; labels?: string[]; created_at: string }>;
  };
  return (page.jobs ?? []).map((j) => ({ id: j.id, name: j.name, status: j.status, labels: j.labels ?? [], createdAt: j.created_at }));
}

/** Cancelling a run that already finished is a success: the goal is "not running". */
export async function cancelRun(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  try {
    await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}/cancel`, { method: "POST" });
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 409) return;
    throw error;
  }
}

/** Re-runs one job of a finished run; GitHub queues it as a new attempt. */
export async function rerunJob(token: string, r: Repo, jobId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  await client.request(`/repos/${r.owner}/${r.repo}/actions/jobs/${jobId}/rerun`, { method: "POST" });
}
