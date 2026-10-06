// Test double for the Fetch API: canned responses keyed by decoded URL. Tests never touch the network.

export interface CannedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = CannedResponse | CannedResponse[];

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

function toResponse(canned: CannedResponse): Response {
  const headers = new Headers({ "content-type": "application/json", ...(canned.headers ?? {}) });
  const status = canned.status ?? 200;
  const body = status === 204 ? null : JSON.stringify(canned.body ?? {});
  return new Response(body, { status, headers });
}

/** Routes are matched on the decoded URL so `created=>=2026-09-06` reads naturally in tests. An array route answers in order and repeats its last entry. */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const queues = new Map<string, CannedResponse[]>();
  for (const [url, route] of Object.entries(routes)) {
    queues.set(url, Array.isArray(route) ? [...route] : [route]);
  }
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = decodeURIComponent(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, method: init?.method ?? "GET", headers });
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      return new Response(JSON.stringify({ message: `no canned response for ${url}` }), {
        status: 404,
      });
    }
    const canned =
      queue.length > 1 ? (queue.shift() as CannedResponse) : (queue[0] as CannedResponse);
    return toResponse(canned);
  };
  return { fetch: impl as typeof fetch, calls };
}
