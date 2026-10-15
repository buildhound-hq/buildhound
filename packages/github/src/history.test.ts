import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "./client";
import { fakeFetch } from "./fake-fetch";
import { fetchHistory, pool } from "./history";

const BASE = "https://api.github.test";
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const R = `${BASE}/repos/acme/api`;

function run(overrides: Record<string, unknown>) {
  return {
    name: "CI",
    path: ".github/workflows/ci.yml",
    workflow_id: 7,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: "abc123",
    created_at: "2026-10-01T10:00:00Z",
    run_started_at: "2026-10-01T10:00:05Z",
    actor: { login: "alice" },
    repository: { full_name: "acme/api" },
    head_repository: { full_name: "acme/api" },
    pull_requests: [],
    ...overrides,
  };
}

function routes() {
  return {
    [R]: {
      body: {
        id: 42,
        full_name: "acme/api",
        private: true,
        default_branch: "main",
        archived: false,
      },
    },
    [`${R}/actions/workflows?per_page=100`]: {
      body: {
        total_count: 2,
        workflows: [
          { id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
          {
            id: 8,
            name: "pages-build-deployment",
            path: "dynamic/pages/pages-build-deployment",
            state: "active",
          },
        ],
      },
    },
    [`${R}/contents/.github/workflows/ci.yml?ref=main`]: {
      body: {
        path: ".github/workflows/ci.yml",
        encoding: "base64",
        content: "bmFtZTogQ0kK\nb246IHB1c2gK\n",
      },
    },
    [`${R}/contents/dynamic/pages/pages-build-deployment?ref=main`]: {
      status: 404,
      body: { message: "Not Found" },
    },
    [`${R}/actions/runs?created=>=2026-09-06&per_page=100`]: {
      body: {
        total_count: 3,
        workflow_runs: [
          run({ id: 1 }),
          run({
            id: 2,
            event: "pull_request",
            head_branch: "claude/fix-lint",
            head_sha: "def456",
            actor: { login: "bob" },
            head_repository: { full_name: "bobfork/api" },
            pull_requests: [{ number: 9, draft: true }],
            created_at: "2026-10-02T10:00:00Z",
          }),
          run({
            id: 3,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-06T11:00:00Z",
          }),
        ],
      },
    },
    [`${R}/actions/runs/1/jobs?per_page=100`]: {
      body: {
        total_count: 2,
        jobs: [
          {
            id: 100,
            run_id: 1,
            name: "build",
            labels: ["ubuntu-latest"],
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-01T10:00:10Z",
            completed_at: "2026-10-01T10:05:10Z",
            steps: [
              {
                name: "Checkout",
                status: "completed",
                conclusion: "success",
                started_at: "2026-10-01T10:00:10Z",
                completed_at: "2026-10-01T10:00:15Z",
              },
              {
                name: "Test",
                status: "completed",
                conclusion: "success",
                started_at: "2026-10-01T10:00:15Z",
                completed_at: "2026-10-01T10:05:10Z",
              },
            ],
          },
          {
            id: 101,
            run_id: 1,
            name: "lint",
            labels: ["macos-latest"],
            status: "completed",
            conclusion: "failure",
            started_at: "2026-10-01T10:00:10Z",
            completed_at: "2026-10-01T10:01:40Z",
            steps: [
              {
                name: "Lint",
                status: "completed",
                conclusion: "failure",
                started_at: "2026-10-01T10:00:10Z",
                completed_at: "2026-10-01T10:01:40Z",
              },
            ],
          },
        ],
      },
    },
    [`${R}/actions/runs/2/jobs?per_page=100`]: {
      body: {
        total_count: 1,
        jobs: [
          {
            id: 200,
            run_id: 2,
            name: "build",
            labels: ["ubuntu-latest"],
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-02T10:00:10Z",
            completed_at: "2026-10-02T10:03:10Z",
            steps: [
              {
                name: "Checkout",
                status: "completed",
                conclusion: "success",
                started_at: null,
                completed_at: null,
              },
            ],
          },
        ],
      },
    },
  };
}

describe("fetchHistory", () => {
  it("builds the History shape with attribution, fork detection and step durations", async () => {
    const fake = fakeFetch(routes());
    const client = createGitHubClient({
      token: "tok",
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => NOW,
    });
    const progress = vi.fn();

    const result = await fetchHistory({ client, owner: "acme", repo: "api", onProgress: progress });

    expect(result.repository).toEqual({
      id: 42,
      fullName: "acme/api",
      private: true,
      defaultBranch: "main",
      archived: false,
    });
    expect(result.workflows).toEqual([
      { id: 7, path: ".github/workflows/ci.yml", name: "CI", content: "name: CI\non: push\n" },
    ]);

    const { history } = result;
    expect(history.days).toBe(30);
    expect(history.runs).toHaveLength(3);
    expect(history.jobs).toHaveLength(3);

    const [first, second, third] = history.runs;
    expect(first).toMatchObject({
      id: 1,
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      headBranch: "main",
      headSha: "abc123",
      actorLogin: "alice",
      actorKind: "human",
      agentName: null,
      conclusion: "success",
      isFork: false,
      isDraft: false,
    });
    expect(first?.createdAt).toEqual(new Date("2026-10-01T10:00:00Z"));
    expect(first?.runStartedAt).toEqual(new Date("2026-10-01T10:00:05Z"));

    expect(second).toMatchObject({
      id: 2,
      actorLogin: "bob",
      actorKind: "agent",
      agentName: "claude",
      isFork: true,
      isDraft: true,
    });
    expect(third).toMatchObject({ id: 3, conclusion: null });

    const [build, lint, forkBuild] = history.jobs;
    expect(build).toMatchObject({
      id: 100,
      runId: 1,
      name: "build",
      labels: ["ubuntu-latest"],
      conclusion: "success",
    });
    expect(build?.startedAt).toEqual(new Date("2026-10-01T10:00:10Z"));
    expect(build?.completedAt).toEqual(new Date("2026-10-01T10:05:10Z"));
    expect(build?.steps).toEqual([
      { name: "Checkout", durationSeconds: 5, conclusion: "success" },
      { name: "Test", durationSeconds: 295, conclusion: "success" },
    ]);
    expect(lint?.steps).toEqual([{ name: "Lint", durationSeconds: 90, conclusion: "failure" }]);
    expect(forkBuild).toMatchObject({
      id: 200,
      runId: 2,
      steps: [{ name: "Checkout", durationSeconds: 0, conclusion: "success" }],
    });

    // Jobs are fetched only for completed runs; the in-progress run stays in `runs`.
    const jobUrls = fake.calls.map((c) => c.url).filter((u) => u.includes("/jobs"));
    expect(jobUrls).toEqual([
      `${R}/actions/runs/1/jobs?per_page=100`,
      `${R}/actions/runs/2/jobs?per_page=100`,
    ]);

    expect(progress).toHaveBeenCalledWith({ stage: "jobs", done: 2, total: 2 });
    // The dynamic Pages workflow has no file, so only ci.yml is read.
    expect(progress).toHaveBeenCalledWith({ stage: "workflows", done: 1, total: 1 });
    expect(fake.calls.some((c) => c.url.includes("/contents/dynamic"))).toBe(false);
    expect(result).toMatchObject({ skipped: [], capped: false, partial: false });
  });

  it("skips odd workflow entries without failing: an empty path, a symlink, a file over 1 MB, a refused read", async () => {
    // Alamofire/Alamofire lists a workflow with path "", which the Contents API answers with the repository root.
    const fake = fakeFetch({
      ...routes(),
      [`${R}/actions/workflows?per_page=100`]: {
        body: {
          total_count: 5,
          workflows: [
            { id: 6, name: "Old CI", path: "", state: "active" },
            { id: 7, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
            { id: 9, name: "Linked", path: ".github/workflows/linked.yml", state: "active" },
            { id: 10, name: "Huge", path: ".github/workflows/huge.yml", state: "active" },
            { id: 11, name: "Refused", path: ".github/workflows/refused.yml", state: "active" },
          ],
        },
      },
      [`${R}/contents/?ref=main`]: { body: [{ name: "README.md", type: "file" }] },
      [`${R}/contents/.github/workflows/linked.yml?ref=main`]: { body: { type: "symlink", path: ".github/workflows/linked.yml", target: "../ci.yml" } },
      [`${R}/contents/.github/workflows/huge.yml?ref=main`]: { body: { type: "file", path: ".github/workflows/huge.yml", encoding: "none", content: "", size: 2_000_000 } },
      [`${R}/contents/.github/workflows/refused.yml?ref=main`]: { status: 403, body: { message: "Forbidden" } },
    });
    const client = createGitHubClient({ token: "tok", baseUrl: BASE, fetch: fake.fetch, sleep: async () => {}, now: () => NOW });
    const result = await fetchHistory({ client, owner: "acme", repo: "api" });
    expect(result.workflows.map((w) => w.path)).toEqual([".github/workflows/ci.yml"]);
    expect(result.skipped).toEqual([
      { path: ".github/workflows/linked.yml", reason: "a symlink, not a file" },
      { path: ".github/workflows/huge.yml", reason: "larger than 1 MB, which the Contents API does not return" },
      { path: ".github/workflows/refused.yml", reason: "GitHub answered 403" },
    ]);
    expect(fake.calls.some((c) => c.url === `${R}/contents/?ref=main`)).toBe(false);
    expect(result.history.runs).toHaveLength(3);
  });

  it("stops at shouldStop and keeps only the newest runs whose jobs were all read", async () => {
    const fake = fakeFetch(routes());
    const client = createGitHubClient({ token: "tok", baseUrl: BASE, fetch: fake.fetch, sleep: async () => {}, now: () => NOW });
    // Time runs out once run 1's jobs are in.
    const shouldStop = () => fake.calls.some((c) => c.url.includes("/runs/1/jobs"));
    const result = await fetchHistory({ client, owner: "acme", repo: "api", concurrency: 1, shouldStop, now: () => NOW });
    // Run 1's jobs were read, run 2's were not: run 2 and everything older go, and the window is run 1's span.
    expect(result.partial).toBe(true);
    expect(result.history.runs.map((r) => r.id)).toEqual([1]);
    expect(result.history.jobs.map((j) => j.runId)).toEqual([1, 1]);
    expect(result.history.days).toBe(6);
    expect(fake.calls.some((c) => c.url.includes("/runs/2/jobs"))).toBe(false);
  });

  it("honours the days option in the created filter", async () => {
    const fake = fakeFetch({
      ...routes(),
      [`${R}/actions/runs?created=>=2026-09-29&per_page=100`]: {
        body: { total_count: 0, workflow_runs: [] },
      },
    });
    const client = createGitHubClient({
      token: "tok",
      baseUrl: BASE,
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => NOW,
    });
    const result = await fetchHistory({ client, owner: "acme", repo: "api", days: 7 });
    expect(result.history).toEqual({ days: 7, runs: [], jobs: [] });
  });

  it("caps runs at maxRuns, fetches jobs for those alone and shortens the window to their span", async () => {
    const base = routes();
    const runsPage = base[`${R}/actions/runs?created=>=2026-09-06&per_page=100`] as { body: { workflow_runs: unknown[] } };
    const [r1, r2, r3] = runsPage.body.workflow_runs;
    const fake = fakeFetch({
      ...base,
      [`${R}/branches/main`]: { body: { name: "main", commit: { sha: "f".repeat(40) } } },
      [`${R}/contents/.github/workflows/ci.yml?ref=${"f".repeat(40)}`]: base[`${R}/contents/.github/workflows/ci.yml?ref=main`]!,
      [`${R}/actions/runs?created=>=2026-09-06&per_page=2`]: { body: { total_count: 3, workflow_runs: [r3, r2, r1] } },
      [`${R}/actions/runs/2/jobs?per_page=100`]: {
        body: { total_count: 1, jobs: [{ id: 200, run_id: 2, name: "build", labels: ["macos-latest"], status: "completed", conclusion: "success", created_at: "2026-10-02T10:00:00Z", started_at: "2026-10-02T10:00:40Z", completed_at: "2026-10-02T10:03:10Z" }] },
      },
    });
    const client = createGitHubClient({ token: "tok", baseUrl: BASE, fetch: fake.fetch, sleep: async () => {}, now: () => NOW });
    const repository = await client.getRepository("acme", "api");
    const head = await client.getBranchHead("acme", "api", repository.defaultBranch);
    expect(head).toBe("f".repeat(40));
    const result = await fetchHistory({ client, owner: "acme", repo: "api", repository, ref: head, maxRuns: 2, now: () => NOW });
    expect(result.history.runs.map((r) => r.id)).toEqual([3, 2]);
    expect(result.history.jobs.map((j) => j.id)).toEqual([200]);
    expect(result.history.jobs[0]?.queuedAt).toEqual(new Date("2026-10-02T10:00:00Z"));
    // Oldest run kept is 2026-10-02 10:00, four days and two hours before NOW: five whole days.
    expect(result.history.days).toBe(5);
    expect(fake.calls.filter((c) => c.url === R)).toHaveLength(1);
    expect(fake.calls.some((c) => c.url.includes("/runs/1/jobs"))).toBe(false);
  });
});

describe("pool", () => {
  it("bounds concurrency and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1 + (7 - n)));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });
});
