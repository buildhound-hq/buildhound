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
  /** When a runner picked the job up, null while it waits. */
  startedAt?: string | null;
  /** When the job finished, null until it does. */
  completedAt?: string | null;
  /** The runner that took the job, null while it waits. */
  runnerName?: string | null;
  /** The runner's group: "GitHub Actions" for GitHub-hosted runners; null while it waits. */
  runnerGroupName?: string | null;
  /** The job's steps in GitHub's order, pending ones included: names and timings only, never logs. */
  steps?: RunJobStep[];
  /** The job's page on GitHub. */
  htmlUrl?: string | null;
}

export interface RunJobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** Null for a step that has not started. */
  startedAt: string | null;
  completedAt: string | null;
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
    jobs?: Array<{
      id: number;
      name: string;
      status: string;
      conclusion?: string | null;
      labels?: string[];
      created_at: string;
      started_at?: string | null;
      completed_at?: string | null;
      runner_name?: string | null;
      runner_group_name?: string | null;
      html_url?: string | null;
      steps?: Array<{ number: number; name: string; status: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null }>;
    }>;
  };
  return (page.jobs ?? []).map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? null,
    labels: j.labels ?? [],
    createdAt: j.created_at,
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
    runnerName: j.runner_name ?? null,
    runnerGroupName: j.runner_group_name ?? null,
    ...(j.steps
      ? {
          steps: j.steps.map((st) => ({
            number: st.number,
            name: st.name,
            status: st.status,
            conclusion: st.conclusion ?? null,
            startedAt: st.started_at ?? null,
            completedAt: st.completed_at ?? null,
          })),
        }
      : {}),
    ...(j.html_url ? { htmlUrl: j.html_url } : {}),
  }));
}

/**
 * Runs created on or after `since` (a UTC date), newest first, at most `limit` of them: the seed of hosted queue
 * waits (ARCHITECTURE.md, Queue relief). One request per 100 runs.
 */
export async function listRecentRuns(token: string, r: Repo, since: Date, limit: number, options: GitHubFetchOptions = {}): Promise<RunSummary[]> {
  const client = createGitHubClient({ token, ...options });
  const out: RunSummary[] = [];
  const created = `>=${since.toISOString().slice(0, 10)}`;
  for (let page = 1; out.length < limit; page++) {
    const perPage = Math.min(100, limit);
    const answer = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs`, { params: { created, per_page: perPage, page } })) as {
      workflow_runs?: Array<{ id: number; status: string; created_at: string }>;
    };
    const runs = answer.workflow_runs ?? [];
    for (const run of runs) if (out.length < limit) out.push({ id: run.id, status: run.status, createdAt: run.created_at });
    if (runs.length < perPage) break;
  }
  return out;
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

/**
 * Re-runs every failed or cancelled job of a finished run, with their dependents, as one new attempt.
 * Re-running a second single job fails once the first has started an attempt (seen 2026-10-14).
 */
export async function rerunFailedJobs(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" });
}

export interface RunDetail {
  headSha: string;
  /** The workflow file. */
  path: string;
  /** The event that started the run; for a reusable workflow, its caller's. */
  event: string;
  /** The repository's full name. */
  repository: string;
  /** The head repository's full name, null when GitHub reports none (a pull request whose fork was deleted). */
  headRepository: string | null;
  /** False unless GitHub says the repository is private, so a missing field counts as public. */
  repositoryPrivate: boolean;
}

/** The commit, workflow file and origin of a run. */
export async function getRun(token: string, r: Repo, runId: number, options: GitHubFetchOptions = {}): Promise<RunDetail> {
  const client = createGitHubClient({ token, ...options });
  const run = (await client.request(`/repos/${r.owner}/${r.repo}/actions/runs/${runId}`)) as {
    head_sha: string;
    path: string;
    event?: string;
    repository?: { full_name?: string; private?: boolean } | null;
    head_repository?: { full_name?: string } | null;
  };
  return {
    headSha: run.head_sha,
    // A run of a reusable workflow names it as `path@ref`; the file is the part before the `@`.
    path: run.path.split("@")[0]!,
    event: run.event ?? "",
    repository: run.repository?.full_name ?? `${r.owner}/${r.repo}`,
    headRepository: run.head_repository?.full_name ?? null,
    repositoryPrivate: run.repository?.private === true,
  };
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

// Starting work by hand (the dashboard's Run workflow and Re-run, `buildhound run` and `rerun`): the repository's
// workflows and branches, and a dispatch of one workflow on a ref.

export interface RepositoryWorkflow {
  id: number;
  name: string;
  path: string;
  /** "active", or why GitHub will not run it ("disabled_manually", "disabled_inactivity" and so on). */
  state: string;
}

/** Every workflow GitHub knows in the repository, at most `limit`. Needs Actions read. */
export async function listRepositoryWorkflows(token: string, r: Repo, limit = 200, options: GitHubFetchOptions = {}): Promise<RepositoryWorkflow[]> {
  const client = createGitHubClient({ token, ...options });
  const items = await client.paginate<{ id: number; name: string; path: string; state: string }>(`/repos/${r.owner}/${r.repo}/actions/workflows`, {}, limit);
  return items.slice(0, limit).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
}

export interface RepositorySummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  /** GitHub's id for it; absent from fakes that predate repository icons. */
  id?: number;
  homepage?: string | null;
}

export async function getRepositorySummary(token: string, r: Repo, options: GitHubFetchOptions = {}): Promise<RepositorySummary> {
  const repo = await createGitHubClient({ token, ...options }).getRepository(r.owner, r.repo);
  return { id: repo.id, fullName: repo.fullName, private: repo.private, defaultBranch: repo.defaultBranch, archived: repo.archived, homepage: repo.homepage ?? null };
}

/** Branch names, at most `limit`, in GitHub's order. Needs Contents read. */
export async function listBranchNames(token: string, r: Repo, limit = 100, options: GitHubFetchOptions = {}): Promise<string[]> {
  const client = createGitHubClient({ token, ...options });
  return (await client.paginate<{ name: string }>(`/repos/${r.owner}/${r.repo}/branches`, {}, limit)).slice(0, limit).map((b) => b.name);
}

/**
 * Starts a workflow that has `on: workflow_dispatch` on a branch or tag, with its inputs as strings. GitHub answers
 * 204 and queues the run as the event `workflow_dispatch`; its jobs then route like any other. Needs Actions write.
 */
export async function dispatchWorkflow(token: string, r: Repo, workflowId: number, ref: string, inputs: Record<string, string>, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  await client.request(`/repos/${r.owner}/${r.repo}/actions/workflows/${workflowId}/dispatches`, { method: "POST", body: { ref, inputs } });
}

/**
 * A job's check run annotations (`GET /repos/{o}/{r}/check-runs/{job_id}/annotations`; a job's id is its check run's),
 * first 50: where GitHub says why it cancelled a job ("Canceling since a higher priority waiting request for ... exists",
 * "The run was canceled by @login.", "... has exceeded the maximum execution time of N minutes."). Needs Checks read.
 */
export async function listJobAnnotations(token: string, r: Repo, jobId: number, options: GitHubFetchOptions = {}): Promise<Array<{ message: string; title: string | null; level: string | null }>> {
  const client = createGitHubClient({ token, ...options });
  const list = (await client.request(`/repos/${r.owner}/${r.repo}/check-runs/${jobId}/annotations?per_page=50`)) as Array<{ message?: string | null; title?: string | null; annotation_level?: string | null }>;
  return (Array.isArray(list) ? list : []).map((a) => ({ message: a.message ?? "", title: a.title ?? null, level: a.annotation_level ?? null }));
}

/** Job logs read at most this far: a step's excerpt is cut from them, and a larger log is read only this far. */
export const JOB_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * A job's plain log (`GET /repos/{o}/{r}/actions/jobs/{job_id}/logs`, which redirects to a short-lived download), as
 * text, at most JOB_LOG_MAX_BYTES. GitHub masks the secrets it knows before it writes a log. Needs Actions read.
 */
export async function downloadJobLog(token: string, r: Repo, jobId: number, options: GitHubFetchOptions = {}): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const res = await doFetch(`${base}/repos/${r.owner}/${r.repo}/actions/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "buildhound" },
    redirect: "follow",
  });
  if (!res.ok) throw new GitHubApiError(res.status, `/repos/${r.owner}/${r.repo}/actions/jobs/${jobId}/logs`, `GitHub answered ${res.status} for the job's log`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < JOB_LOG_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, JOB_LOG_MAX_BYTES));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.byteLength - at);
    all.set(c.subarray(0, take), at);
    at += take;
    if (at >= all.byteLength) break;
  }
  return new TextDecoder().decode(all);
}
