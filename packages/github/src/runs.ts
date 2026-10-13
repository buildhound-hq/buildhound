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
  /** success, failure, cancelled and so on once completed; null before. */
  conclusion?: string | null;
  labels: string[];
  createdAt: string;
  /** The runner that took the job, null while it waits. */
  runnerName?: string | null;
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
    jobs?: Array<{ id: number; name: string; status: string; conclusion?: string | null; labels?: string[]; created_at: string; runner_name?: string | null }>;
  };
  return (page.jobs ?? []).map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? null,
    labels: j.labels ?? [],
    createdAt: j.created_at,
    runnerName: j.runner_name ?? null,
  }));
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

/**
 * Cancels a run even when a job's runner cannot answer, such as a job on a machine that went to sleep or
 * lost power: a plain cancel waits for the runner. A run that already finished is a success.
 */
export async function forceCancelRun(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  try {
    await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}/force-cancel`, { method: "POST" });
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

/** The commit and workflow file a run belongs to. */
export async function getRun(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<{ headSha: string; path: string }> {
  const client = createGitHubClient({ token, ...options });
  const run = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}`)) as { head_sha: string; path: string };
  // A run of a reusable workflow names it as `path@ref`; the file is the part before the `@`.
  return { headSha: run.head_sha, path: run.path.split("@")[0]! };
}

/** A file's text at a commit, through the contents API (base64 in the JSON body). */
export async function getFileAtRef(token: string, r: Repo, path: string, ref: string, options: GitHubFetchOptions = {}): Promise<string> {
  const client = createGitHubClient({ token, ...options });
  const file = (await client.request(`/repos/${r.owner}/${r.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`)) as { content?: string; encoding?: string };
  if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error(`${path}@${ref}: not a file`);
  return new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
}

/** The repository's default GITHUB_TOKEN permission for workflows, "read" or "write". Needs Administration read. */
export async function getDefaultWorkflowPermission(token: string, r: Repo, options: GitHubFetchOptions = {}): Promise<"read" | "write"> {
  const client = createGitHubClient({ token, ...options });
  const res = (await client.request(`/repos/${r.owner}/${r.repo}/actions/permissions/workflow`)) as { default_workflow_permissions?: string };
  return res.default_workflow_permissions === "read" ? "read" : "write";
}
