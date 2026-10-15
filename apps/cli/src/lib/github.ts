import type { History, RepositoryInfo } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../output";
import type { WorkflowFile } from "./workflows";

/** Longest rate-limit pause the CLI will sit through before failing with RATE_LIMITED. Agents should not hang. */
export const MAX_RATE_LIMIT_WAIT_MS = 120_000;
/** Fetched history is reused for an hour so `scan` then `route` does not spend the GitHub budget twice. */
export const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000;

function cachePath(owner: string, name: string, days: number): string {
  const dir = process.env.BUILDHOUND_CACHE_DIR ?? join(homedir(), ".cache", "buildhound", "history");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${owner}__${name}__${days}d.json`);
}

function readCache(path: string): RemoteRepo | null {
  if (process.env.BUILDHOUND_NO_CACHE) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { savedAt: number; data: RemoteRepo };
    if (Date.now() - raw.savedAt > HISTORY_CACHE_TTL_MS) return null;
    const h = raw.data.history;
    raw.data.history = {
      days: h.days,
      runs: h.runs.map((r) => ({ ...r, createdAt: new Date(r.createdAt), runStartedAt: r.runStartedAt ? new Date(r.runStartedAt) : null })),
      jobs: h.jobs.map((j) => ({ ...j, ...(j.queuedAt ? { queuedAt: new Date(j.queuedAt) } : {}), startedAt: j.startedAt ? new Date(j.startedAt) : null, completedAt: j.completedAt ? new Date(j.completedAt) : null })),
    };
    return raw.data;
  } catch {
    return null;
  }
}

function writeCache(path: string, data: RemoteRepo): void {
  if (process.env.BUILDHOUND_NO_CACHE) return;
  try { writeFileSync(path, JSON.stringify({ savedAt: Date.now(), data })); } catch { /* cache is best effort */ }
}

export interface RemoteRepo {
  repository: RepositoryInfo;
  workflows: WorkflowFile[];
  history: History;
}

/**
 * The shape this CLI codes against. `createGitHubClient({ token })` and
 * `fetchHistory({ client, owner, repo, days })` live in packages/github; they are looked up at run
 * time so the CLI typechecks and its tests run before that package is finished (tests mock the module).
 */
interface GitHubModule {
  createGitHubClient?: (i: { token: string; baseUrl?: string; sleep?: (ms: number) => Promise<void> }) => unknown;
  fetchHistory?: (i: { client: unknown; owner: string; repo: string; days: number }) => Promise<{ repository?: Partial<RepositoryInfo>; workflows?: WorkflowFile[]; history?: History }>;
}

function statusOf(e: unknown): number | null {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : null;
}

/** Fetch workflow files and the last `days` of run history for owner/name. Every failure is a CliError. */
export async function fetchRemoteRepo(i: { token: string; owner: string; name: string; days: number; next: string }): Promise<RemoteRepo> {
  const mod = (await import("@buildhound/github")) as GitHubModule;
  if (typeof mod.createGitHubClient !== "function" || typeof mod.fetchHistory !== "function") {
    throw new CliError("GITHUB_UNAVAILABLE", "run history is not available in this build of the CLI", "buildhound scan <path>", EXIT.network);
  }
  const full = `${i.owner}/${i.name}`;
  const cache = cachePath(i.owner, i.name, i.days);
  const cached = readCache(cache);
  if (cached) {
    process.stderr.write(JSON.stringify({ log: "history", source: "cache", repo: full, days: i.days }) + "\n");
    return cached;
  }
  const sleep = async (ms: number) => {
    if (ms > MAX_RATE_LIMIT_WAIT_MS) {
      const minutes = Math.ceil(ms / 60_000);
      throw new CliError("RATE_LIMITED", `GitHub rate limit reached; it resets in ${minutes} minutes`, `wait ${minutes} minutes and run ${i.next} again, or use --days 7 to need fewer requests`, EXIT.network);
    }
    process.stderr.write(JSON.stringify({ log: "rate_limit_wait", seconds: Math.ceil(ms / 1000) }) + "\n");
    await new Promise((r) => setTimeout(r, ms));
  };
  try {
    const client = mod.createGitHubClient({ token: i.token, sleep, ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}) });
    const r = await mod.fetchHistory({ client, owner: i.owner, repo: i.name, days: i.days });
    const repository: RepositoryInfo = { fullName: full, private: true, defaultBranch: "main", ...(r.repository ?? {}) };
    const history: History = r.history ?? { days: i.days, runs: [], jobs: [] };
    const workflows = (r.workflows ?? []).map((w) => ({ path: w.path, content: w.content }));
    const result = { repository, workflows, history };
    writeCache(cache, result);
    return result;
  } catch (e) {
    if (e instanceof CliError) throw e;
    const status = statusOf(e);
    const message = e instanceof Error ? e.message : String(e);
    if (status === 401) throw new CliError("TOKEN_INVALID", `GitHub rejected the token: ${message}`, `${i.next} --token $(gh auth token)`, EXIT.auth);
    if (status === 403) throw new CliError("TOKEN_FORBIDDEN", `the token cannot read ${full}: ${message}`, `${i.next} --token <token with repo and actions:read scope>`, EXIT.auth);
    if (status === 404) throw new CliError("REPO_NOT_FOUND", `${full} was not found or the token cannot see it`, `${i.next} --token $(gh auth token)`, EXIT.network);
    throw new CliError("GITHUB_ERROR", `GitHub request failed: ${message}`, `${i.next}`, EXIT.network);
  }
}
