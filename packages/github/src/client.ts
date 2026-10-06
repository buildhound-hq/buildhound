import type { RepositoryInfo } from "@buildhound/core";

// Portable GitHub REST client: Fetch API only, no Node modules, so it runs on Vercel Functions,
// Cloudflare Workers and in the CLI alike (ARCHITECTURE.md, Portability). Works with a plain token
// now and an installation token later; the caller owns the token lifecycle.

const DEFAULT_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** GITHUB_APP.md, Rate limits: under 200 remaining, sleep until reset. */
export const RATE_LIMIT_PAUSE_THRESHOLD = 200;
const MAX_RETRIES = 3;
const PER_PAGE = 100;

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  params?: QueryParams;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
}

export interface RateLimitState {
  /** Requests left in the current window, null until the first response. */
  remaining: number | null;
  /** Unix epoch seconds at which the window resets, null until the first response. */
  reset: number | null;
}

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Injectable so tests never wait. Defaults to a setTimeout-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch milliseconds, for date filters and reset arithmetic. */
  now?: () => number;
}

export interface GitHubRepository extends RepositoryInfo {
  id: number;
  archived: boolean;
}

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GitHubActor {
  login: string;
}

export interface GitHubRun {
  id: number;
  name: string | null;
  path: string;
  workflow_id: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string | null;
  created_at: string;
  run_started_at?: string | null;
  actor?: GitHubActor | null;
  triggering_actor?: GitHubActor | null;
  repository: { full_name: string };
  head_repository: { full_name: string } | null;
  pull_requests: Array<{ number?: number; draft?: boolean }> | null;
}

export interface GitHubStep {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GitHubJob {
  id: number;
  run_id: number;
  name: string;
  labels: string[];
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: GitHubStep[];
}

export interface GitHubClient {
  /** Latest rate-limit headers seen on any response. */
  readonly rateLimit: RateLimitState;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Follows Link rel="next" with per_page=100 and concatenates the items of every page. */
  paginate<T>(path: string, params?: QueryParams): Promise<T[]>;
  getRepository(owner: string, repo: string): Promise<GitHubRepository>;
  listWorkflows(owner: string, repo: string): Promise<GitHubWorkflow[]>;
  getWorkflowContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ path: string; content: string }>;
  listRuns(owner: string, repo: string, options: { sinceDays: number }): Promise<GitHubRun[]>;
  listJobs(owner: string, repo: string, runId: number): Promise<GitHubJob[]>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(`GitHub ${status} on ${url}: ${message}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.url = url;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(baseUrl: string, path: string, params: QueryParams | undefined): string {
  const url = new URL(/^https?:\/\//.test(path) ? path : `${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  return match?.[1] ?? null;
}

function headerInt(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Items of a list response: either a bare array or the first array-valued field of an envelope such as { total_count, workflows }. */
function extractItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

/** Decode a base64 payload from the Contents API, which wraps lines with newlines, into UTF-8 text. */
export function decodeBase64Utf8(payload: string): string {
  const binary = atob(payload.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** YYYY-MM-DD in UTC for a moment `days` before `nowMs`. */
export function sinceDate(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const token = options.token;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const rateLimit: RateLimitState = { remaining: null, reset: null };
  let pausedForReset: number | null = null;

  function recordRateLimit(response: Response): void {
    const remaining = headerInt(response, "x-ratelimit-remaining");
    const reset = headerInt(response, "x-ratelimit-reset");
    if (remaining !== null) rateLimit.remaining = remaining;
    if (reset !== null) rateLimit.reset = reset;
  }

  async function pauseIfNearLimit(): Promise<void> {
    if (rateLimit.remaining === null || rateLimit.reset === null) return;
    if (rateLimit.remaining >= RATE_LIMIT_PAUSE_THRESHOLD) return;
    if (pausedForReset === rateLimit.reset) return;
    pausedForReset = rateLimit.reset;
    await sleep(Math.max(0, rateLimit.reset * 1000 - now()));
  }

  function retryDelayMs(response: Response, attempt: number): number | null {
    const retryAfter = headerInt(response, "retry-after");
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return retryAfter !== null ? retryAfter * 1000 : 1000 * 2 ** attempt;
    }
    if (response.status === 403 || response.status === 429) {
      if (retryAfter !== null) return retryAfter * 1000;
      if (headerInt(response, "x-ratelimit-remaining") === 0) {
        const reset = headerInt(response, "x-ratelimit-reset");
        if (reset !== null) return Math.max(0, reset * 1000 - now());
      }
    }
    return null;
  }

  async function send(
    url: string,
    requestOptions: RequestOptions,
  ): Promise<{ data: unknown; response: Response }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "buildhound",
    };
    const init: RequestInit = { method: requestOptions.method ?? "GET", headers };
    if (requestOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(requestOptions.body);
    }

    for (let attempt = 0; ; attempt++) {
      await pauseIfNearLimit();
      const response = await fetchImpl(url, init);
      recordRateLimit(response);
      if (response.ok) {
        if (response.status === 204) return { data: null, response };
        return { data: await response.json(), response };
      }
      const delay = retryDelayMs(response, attempt);
      if (delay !== null && attempt < MAX_RETRIES) {
        await sleep(delay);
        continue;
      }
      throw new GitHubApiError(response.status, url, await errorMessage(response));
    }
  }

  async function errorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: string };
      return body.message ?? response.statusText;
    } catch {
      return response.statusText;
    }
  }

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const { data } = await send(buildUrl(baseUrl, path, requestOptions.params), requestOptions);
    return data as T;
  }

  async function paginate<T>(path: string, params: QueryParams = {}): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = buildUrl(baseUrl, path, { ...params, per_page: PER_PAGE });
    while (url) {
      const { data, response } = await send(url, {});
      items.push(...extractItems<T>(data));
      url = parseNextLink(response.headers.get("link"));
    }
    return items;
  }

  const client: GitHubClient = {
    rateLimit,
    request,
    paginate,

    async getRepository(owner, repo) {
      const data = await request<{
        id: number;
        full_name: string;
        private: boolean;
        default_branch: string;
        archived: boolean;
      }>(`/repos/${owner}/${repo}`);
      return {
        id: data.id,
        fullName: data.full_name,
        private: data.private,
        defaultBranch: data.default_branch,
        archived: data.archived,
      };
    },

    listWorkflows(owner, repo) {
      return paginate<GitHubWorkflow>(`/repos/${owner}/${repo}/actions/workflows`);
    },

    async getWorkflowContent(owner, repo, path, ref) {
      const data = await request<{ path: string; content: string; encoding: string }>(
        `/repos/${owner}/${repo}/contents/${path}`,
        { params: { ref } },
      );
      if (data.encoding !== "base64") {
        throw new GitHubApiError(200, path, `unexpected content encoding ${data.encoding}`);
      }
      return { path: data.path, content: decodeBase64Utf8(data.content) };
    },

    listRuns(owner, repo, { sinceDays }) {
      return paginate<GitHubRun>(`/repos/${owner}/${repo}/actions/runs`, {
        created: `>=${sinceDate(now(), sinceDays)}`,
      });
    },

    listJobs(owner, repo, runId) {
      return paginate<GitHubJob>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
    },
  };

  return client;
}
