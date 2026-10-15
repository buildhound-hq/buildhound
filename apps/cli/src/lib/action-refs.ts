import { actionRefKey as keyOf, collectActionRefs, isFullSha } from "@buildhound/core";
import type { ActionRefKey, ActionRefResolver } from "@buildhound/core";

export { collectActionRefs, type ActionRefKey };

export interface ResolveOptions {
  /** GitHub token when one is at hand; without it the lookups run unauthenticated. */
  token?: string | null | undefined;
  /** Lookups at once. */
  concurrency?: number;
  /** Per request, in milliseconds. */
  timeoutMs?: number;
}

const API_URL = "https://api.github.com";

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
