import { afterEach, describe, expect, it, vi } from "vitest";
import { actionRefResolver, collectActionRefs, resolveActionRefs } from "./action-refs";

const SHA = "a".repeat(40);
const PINNED = "b".repeat(40);

const workflow = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: Pnpm/Action-Setup@v4
      - uses: github/codeql-action/init@v3
      - uses: actions/cache@${PINNED}
      - uses: ./.github/actions/local
      - uses: docker://alpine:3.20
      - uses: acme/tool@\${{ matrix.ref }}
      - run: echo hi
  call:
    uses: acme/workflows/.github/workflows/ci.yml@main
`;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {})));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectActionRefs", () => {
  it("lists each tag or branch reference once, skipping SHAs, local, docker and expression references", () => {
    expect(collectActionRefs([{ path: ".github/workflows/ci.yml", content: workflow }, { path: ".github/workflows/bad.yml", content: "on: [\n" }])).toEqual([
      { owner: "actions", repo: "checkout", ref: "v4" },
      { owner: "pnpm", repo: "action-setup", ref: "v4" },
      { owner: "github", repo: "codeql-action", ref: "v3" },
      { owner: "acme", repo: "workflows", ref: "main" },
    ]);
  });
});

describe("resolveActionRefs", () => {
  it("asks GitHub for the bare SHA of each ref, with the token when there is one", async () => {
    const fetch = stubFetch(() => new Response(`${SHA}\n`, { status: 200 }));
    const table = await resolveActionRefs([{ owner: "pnpm", repo: "action-setup", ref: "v4" }, { owner: "acme", repo: "tool", ref: "release/v1" }], { token: "t_test" });
    expect(table.get("pnpm/action-setup@v4")).toBe(SHA);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/pnpm/action-setup/commits/v4");
    expect(init!.headers).toMatchObject({ Accept: "application/vnd.github.sha", "X-GitHub-Api-Version": "2022-11-28", Authorization: "Bearer t_test" });
    expect(fetch.mock.calls[1]![0]).toBe("https://api.github.com/repos/acme/tool/commits/release/v1");
  });

  it("calls unauthenticated without a token", async () => {
    const fetch = stubFetch(() => new Response(SHA));
    await resolveActionRefs([{ owner: "pnpm", repo: "action-setup", ref: "v4" }], { token: null });
    expect(fetch.mock.calls[0]![1]!.headers).not.toHaveProperty("Authorization");
  });

  it("treats a 404, a rate limit, a body that is not a SHA and a network error as unknown", async () => {
    stubFetch((url) => {
      if (url.includes("/missing/")) return new Response("Not Found", { status: 404 });
      if (url.includes("/limited/")) return new Response("rate limited", { status: 403 });
      if (url.includes("/odd/")) return new Response("<html>");
      throw new Error("ECONNRESET");
    });
    const refs = ["missing", "limited", "odd", "offline"].map((repo) => ({ owner: "acme", repo, ref: "v1" }));
    expect((await resolveActionRefs(refs)).size).toBe(0);
  });

  it("runs no more than the cap at once", async () => {
    let inFlight = 0;
    let peak = 0;
    stubFetch(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(SHA);
    });
    const refs = Array.from({ length: 20 }, (_, i) => ({ owner: "acme", repo: `tool${i}`, ref: "v1" }));
    const table = await resolveActionRefs(refs, { concurrency: 3 });
    expect(table.size).toBe(20);
    expect(peak).toBe(3);
  });
});

describe("actionRefResolver", () => {
  it("answers R17 from the table, case-insensitive on owner and repo, null for anything unknown", async () => {
    stubFetch((url) => (url.includes("/pnpm/") ? new Response(SHA) : new Response("", { status: 404 })));
    const resolve = await actionRefResolver([{ path: ".github/workflows/ci.yml", content: workflow }]);
    expect(resolve("pnpm", "action-setup", "v4")).toBe(SHA);
    expect(resolve("PNPM", "Action-Setup", "v4")).toBe(SHA);
    expect(resolve("pnpm", "action-setup", "v3")).toBeNull();
    expect(resolve("actions", "checkout", "v4")).toBeNull();
  });
});
