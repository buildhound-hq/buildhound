import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, decodeBase64Utf8, GitHubApiError, sinceDate, UnreadableFileError } from "./client";
import { fakeFetch } from "./fake-fetch";

const BASE = "https://api.github.test";
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function makeClient(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  const sleep = vi.fn(async () => {});
  const client = createGitHubClient({
    token: "tok",
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep,
    now: () => NOW,
  });
  return { client, fake, sleep };
}

describe("request", () => {
  it("sends the GitHub headers and a Bearer token", async () => {
    const { client, fake } = makeClient({ [`${BASE}/repos/acme/api`]: { body: { id: 1 } } });
    await client.request("/repos/acme/api");
    const call = fake.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.headers["authorization"]).toBe("Bearer tok");
    expect(call?.headers["accept"]).toBe("application/vnd.github+json");
    expect(call?.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("appends query params", async () => {
    const { client, fake } = makeClient({
      [`${BASE}/repos/acme/api/contents/x.yml?ref=main`]: { body: {} },
    });
    await client.request("/repos/acme/api/contents/x.yml", {
      params: { ref: "main", skip: undefined },
    });
    expect(fake.calls[0]?.url).toBe(`${BASE}/repos/acme/api/contents/x.yml?ref=main`);
  });

  it("exposes the latest rate-limit headers and pauses until reset under 200 remaining", async () => {
    const reset = Math.floor(NOW / 1000) + 90;
    const { client, fake, sleep } = makeClient({
      [`${BASE}/a`]: {
        body: {},
        headers: { "x-ratelimit-remaining": "150", "x-ratelimit-reset": String(reset) },
      },
      [`${BASE}/b`]: {
        body: {},
        headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(reset + 3600) },
      },
    });
    await client.request("/a");
    expect(client.rateLimit).toEqual({ remaining: 150, reset });
    expect(sleep).not.toHaveBeenCalled();

    await client.request("/b");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(90_000);
    expect(client.rateLimit).toEqual({ remaining: 4999, reset: reset + 3600 });
    expect(fake.calls.map((c) => c.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
  });

  it("retries a 503 and then succeeds", async () => {
    const { client, fake, sleep } = makeClient({
      [`${BASE}/flaky`]: [{ status: 503, body: { message: "down" } }, { body: { ok: true } }],
    });
    await expect(client.request("/flaky")).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("honours Retry-After on a secondary-rate-limit 403", async () => {
    const { client, fake, sleep } = makeClient({
      [`${BASE}/busy`]: [
        {
          status: 403,
          body: { message: "You have exceeded a secondary rate limit" },
          headers: { "retry-after": "7" },
        },
        { body: { ok: true } },
      ],
    });
    await expect(client.request("/busy")).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("gives up after three retries", async () => {
    const { client, fake } = makeClient({
      [`${BASE}/dead`]: { status: 502, body: { message: "bad gateway" } },
    });
    await expect(client.request("/dead")).rejects.toBeInstanceOf(GitHubApiError);
    expect(fake.calls).toHaveLength(4);
  });

  it("keeps GitHub's message on the error and says whether a rate limit caused it", async () => {
    const policy = "The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days.";
    const { client } = makeClient({
      [`${BASE}/policy`]: { status: 403, body: { message: policy }, headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1" } },
      [`${BASE}/secondary`]: { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "x-ratelimit-remaining": "4000" } },
      [`${BASE}/spent`]: { status: 403, body: { message: "API rate limit exceeded for user." }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 1) } },
    });
    const caught = async (path: string) => (await client.request(path).catch((e: unknown) => e)) as GitHubApiError;
    const blocked = await caught("/policy");
    expect(blocked).toBeInstanceOf(GitHubApiError);
    expect(blocked).toMatchObject({ status: 403, githubMessage: policy, rateLimited: false });
    expect((await caught("/secondary")).rateLimited).toBe(true);
    expect((await caught("/spent")).rateLimited).toBe(true);
  });

  it("does not retry a plain 403 or a 404", async () => {
    const { client, fake } = makeClient({
      [`${BASE}/forbidden`]: {
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
    });
    await expect(client.request("/forbidden")).rejects.toMatchObject({ status: 403 });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("paginate", () => {
  it("follows Link rel=next with per_page=100 and unwraps envelopes", async () => {
    const { client, fake } = makeClient({
      [`${BASE}/repos/acme/api/actions/workflows?per_page=100`]: {
        body: { total_count: 3, workflows: [{ id: 1 }, { id: 2 }] },
        headers: {
          link: `<${BASE}/repos/acme/api/actions/workflows?per_page=100&page=2>; rel="next", <${BASE}/x?page=2>; rel="last"`,
        },
      },
      [`${BASE}/repos/acme/api/actions/workflows?per_page=100&page=2`]: {
        body: { total_count: 3, workflows: [{ id: 3 }] },
      },
    });
    const items = await client.paginate<{ id: number }>("/repos/acme/api/actions/workflows");
    expect(items.map((w) => w.id)).toEqual([1, 2, 3]);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("decodes base64 with embedded newlines into UTF-8", () => {
    const encoded = "bmFtZTogQ0kKb246IHB1\nc2gK\n";
    expect(decodeBase64Utf8(encoded)).toBe("name: CI\non: push\n");
  });

  it("formats the created filter date in UTC", () => {
    expect(sinceDate(NOW, 30)).toBe("2026-09-06");
  });
});

describe("resource methods", () => {
  it("getRepository maps to RepositoryInfo plus id and archived", async () => {
    const { client } = makeClient({
      [`${BASE}/repos/acme/api`]: {
        body: {
          id: 42,
          full_name: "acme/api",
          private: true,
          default_branch: "main",
          archived: false,
        },
      },
    });
    await expect(client.getRepository("acme", "api")).resolves.toEqual({
      id: 42,
      fullName: "acme/api",
      private: true,
      defaultBranch: "main",
      archived: false,
    });
  });

  it("getWorkflowContent decodes the Contents API payload", async () => {
    const { client, fake } = makeClient({
      [`${BASE}/repos/acme/api/contents/.github/workflows/ci.yml?ref=main`]: {
        body: { path: ".github/workflows/ci.yml", encoding: "base64", content: "bmFtZTogQ0kK\n" },
      },
    });
    await expect(
      client.getWorkflowContent("acme", "api", ".github/workflows/ci.yml", "main"),
    ).resolves.toEqual({
      path: ".github/workflows/ci.yml",
      content: "name: CI\n",
    });
    expect(fake.calls[0]?.url).toContain("?ref=main");
  });

  it("getWorkflowContent throws UnreadableFileError for a 200 that holds no file text", async () => {
    const { client } = makeClient({
      // An empty path lists the repository root.
      [`${BASE}/repos/acme/api/contents/?ref=main`]: { body: [{ name: "README.md", type: "file" }] },
      [`${BASE}/repos/acme/api/contents/.github/workflows/sub.yml?ref=main`]: { body: { type: "submodule", path: ".github/workflows/sub.yml" } },
      [`${BASE}/repos/acme/api/contents/.github/workflows/big.yml?ref=main`]: { body: { type: "file", path: ".github/workflows/big.yml", encoding: "none", content: "", size: 1_500_000 } },
    });
    for (const [path, reason] of [
      ["", "a directory, not a file"],
      [".github/workflows/sub.yml", "a submodule, not a file"],
      [".github/workflows/big.yml", "larger than 1 MB, which the Contents API does not return"],
    ] as const) {
      const error = await client.getWorkflowContent("acme", "api", path, "main").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnreadableFileError);
      expect(error).not.toBeInstanceOf(GitHubApiError);
      expect((error as UnreadableFileError).reason).toBe(reason);
    }
  });

  it("listJobs stops paging at maxJobs", async () => {
    const page = (from: number) => ({ body: { total_count: 250, jobs: Array.from({ length: 100 }, (_, i) => ({ id: from + i })) } });
    const { client, fake } = makeClient({
      [`${BASE}/repos/acme/api/actions/runs/10/jobs?per_page=100`]: { ...page(0), headers: { link: `<${BASE}/repos/acme/api/actions/runs/10/jobs?per_page=100&page=2>; rel="next"` } },
      [`${BASE}/repos/acme/api/actions/runs/10/jobs?per_page=100&page=2`]: { ...page(100), headers: { link: `<${BASE}/repos/acme/api/actions/runs/10/jobs?per_page=100&page=3>; rel="next"` } },
    });
    const jobs = await client.listJobs("acme", "api", 10, { maxJobs: 150 });
    expect(jobs).toHaveLength(150);
    expect(fake.calls).toHaveLength(2);
  });

  it("listRuns filters by created date and paginates", async () => {
    const { client } = makeClient({
      [`${BASE}/repos/acme/api/actions/runs?created=>=2026-09-29&per_page=100`]: {
        body: { total_count: 1, workflow_runs: [{ id: 10 }] },
      },
    });
    const runs = await client.listRuns("acme", "api", { sinceDays: 7 });
    expect(runs.map((r) => r.id)).toEqual([10]);
  });

  it("listJobs paginates the jobs envelope", async () => {
    const { client } = makeClient({
      [`${BASE}/repos/acme/api/actions/runs/10/jobs?per_page=100`]: {
        body: { total_count: 2, jobs: [{ id: 100 }, { id: 101 }] },
      },
    });
    const jobs = await client.listJobs("acme", "api", 10);
    expect(jobs.map((j) => j.id)).toEqual([100, 101]);
  });
});
