import { isFullSha, loadWorkflow, parseUses } from "@buildhound/core";
import type { ActionRefResolver } from "@buildhound/core";

/** An action or reusable workflow named by a tag or branch, the input R17 asks a commit SHA for. */
export interface ActionRefKey {
  owner: string;
  repo: string;
  ref: string;
}

export interface ResolveOptions {
  /** GitHub token when one is at hand; without it the lookups run unauthenticated. */
  token?: string | null | undefined;
  /** Lookups at once. */
  concurrency?: number;
  /** Per request, in milliseconds. */
  timeoutMs?: number;
}

const API_URL = "https://api.github.com";

/** Owner and repository names are case-insensitive on GitHub; the ref is not. */
const keyOf = (owner: string, repo: string, ref: string): string => `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every `uses: owner/repo[/path]@ref` in the workflows whose ref is not already a full commit SHA, once per
 * owner/repo@ref. Local (`./`) and `docker://` references are skipped, and so are refs built from an expression.
 * A workflow that does not parse adds nothing; the audit reports it.
 */
export function collectActionRefs(workflows: ReadonlyArray<{ path: string; content: string }>): ActionRefKey[] {
  const out = new Map<string, ActionRefKey>();
  const add = (uses: unknown) => {
    if (typeof uses !== "string") return;
    const u = uses.trim();
    if (u.startsWith("./") || u.startsWith("docker://")) return;
    const r = parseUses(u);
    if (!r || isFullSha(r.ref) || r.ref.includes("${{")) return;
    const k = keyOf(r.owner, r.repo, r.ref);
    if (!out.has(k)) out.set(k, { owner: r.owner, repo: r.repo, ref: r.ref });
  };
  for (const w of workflows) {
    let raw: unknown;
    try {
      raw = loadWorkflow(w.path, w.content).doc.toJS({ mapAsMap: false });
    } catch {
      continue;
    }
    const jobs = isObj(raw) && isObj(raw.jobs) ? raw.jobs : {};
    for (const job of Object.values(jobs)) {
      if (!isObj(job)) continue;
      add(job.uses);
      for (const step of Array.isArray(job.steps) ? job.steps : []) if (isObj(step)) add(step.uses);
    }
  }
  return [...out.values()];
}

/** The commit a ref points at now, or null on any failure, 404, rate limit or timeout. Never throws. */
async function lookup(r: ActionRefKey, token: string | null, timeoutMs: number): Promise<string | null> {
  const ref = r.ref.split("/").map(encodeURIComponent).join("/");
  const url = `${API_URL}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/commits/${ref}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github.sha", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "buildhound-cli" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return isFullSha(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Resolve each reference once, a few at a time. The table holds only the references that resolved. */
export async function resolveActionRefs(refs: readonly ActionRefKey[], opts: ResolveOptions = {}): Promise<Map<string, string>> {
  const token = opts.token ?? null;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const table = new Map<string, string>();
  let i = 0;
  const worker = async () => {
    while (i < refs.length) {
      const r = refs[i++]!;
      const sha = await lookup(r, token, timeoutMs);
      if (sha) table.set(keyOf(r.owner, r.repo, r.ref), sha);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, refs.length) }, worker));
  return table;
}

/**
 * The R17 resolver for a scan: rules run synchronously, so every reference in the workflows is looked up
 * on GitHub first and the resolver reads the table. Unknown references resolve to null.
 */
export async function actionRefResolver(workflows: ReadonlyArray<{ path: string; content: string }>, opts: ResolveOptions = {}): Promise<ActionRefResolver> {
  const table = await resolveActionRefs(collectActionRefs(workflows), opts);
  return (owner, repo, ref) => table.get(keyOf(owner, repo, ref)) ?? null;
}
