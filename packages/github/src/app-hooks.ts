import { createGitHubClient, GitHubApiError } from "./client";
import type { GitHubFetchOptions } from "./app-auth";

// The GitHub App's own webhook deliveries (GET /app/hook/deliveries, App JWT). GitHub keeps every attempt for three
// days, with the status our endpoint answered; a delivery our API never stored can be sent again by its id. Our
// handlers dedupe on X-GitHub-Delivery (CLAUDE.md rule 3), which a redelivery keeps, so sending one twice is safe.

export interface AppHookDelivery {
  /** A string: delivery ids pass 2^53 (3849327781183774717), past what a JavaScript number holds exactly. */
  id: string;
  /** X-GitHub-Delivery: the same on every attempt of one delivery. */
  guid: string;
  deliveredAt: string;
  redelivery: boolean;
  /** What our endpoint answered; 0 when GitHub could not reach it. */
  statusCode: number;
  event: string;
  action: string | null;
}

/** Quotes every `"id": <digits>` before parsing, so a delivery id keeps its every digit. */
export function parseDeliveries(text: string): Array<{ id: string; guid: string; delivered_at: string; redelivery: boolean; status_code: number; event: string; action?: string | null }> {
  return JSON.parse(text.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"')) as ReturnType<typeof parseDeliveries>;
}

/**
 * Attempts delivered at or after `since`, newest first, reading at most `limit` (100 a page). GitHub pages newest first by
 * a cursor in the Link header. Read with its own fetch rather than the shared client, whose JSON parse would round ids.
 */
export async function listAppHookDeliveries(jwt: string, since: Date, limit = 2000, options: GitHubFetchOptions = {}): Promise<AppHookDelivery[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const out: AppHookDelivery[] = [];
  let url: string | null = "https://api.github.com/app/hook/deliveries?per_page=100";
  let read = 0;
  while (url && read < limit) {
    const response: Response = await fetchImpl(url, { headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "buildhound" } });
    if (!response.ok) throw new GitHubApiError(response.status, url, response.statusText);
    const page = parseDeliveries(await response.text());
    read += page.length;
    let older = false;
    for (const d of page) {
      if (Date.parse(d.delivered_at) < since.getTime()) {
        older = true;
        continue;
      }
      out.push({ id: d.id, guid: d.guid, deliveredAt: d.delivered_at, redelivery: d.redelivery, statusCode: d.status_code, event: d.event, action: d.action ?? null });
    }
    if (older || page.length === 0) break;
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  }
  return out;
}

/**
 * The deliveries no attempt of which our endpoint accepted, one attempt each (the newest), oldest first: every attempt of
 * a guid answered something other than 2xx. A delivery redelivered successfully since is left out.
 */
export function undeliveredAppHooks(attempts: readonly AppHookDelivery[]): AppHookDelivery[] {
  const byGuid = new Map<string, AppHookDelivery[]>();
  for (const a of attempts) byGuid.set(a.guid, [...(byGuid.get(a.guid) ?? []), a]);
  const out: AppHookDelivery[] = [];
  for (const list of byGuid.values()) {
    if (list.some((a) => a.statusCode >= 200 && a.statusCode < 300)) continue;
    out.push(list.reduce((a, b) => (Date.parse(b.deliveredAt) > Date.parse(a.deliveredAt) ? b : a)));
  }
  return out.sort((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt));
}

/** Asks GitHub to send a delivery again (202). */
export async function redeliverAppHookDelivery(jwt: string, id: string, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token: jwt, ...options });
  await client.request(`/app/hook/deliveries/${id}/attempts`, { method: "POST" });
}
