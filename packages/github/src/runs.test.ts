import { describe, expect, it } from "vitest";
import { dispatchWorkflow, getRun, listBranchNames, listRecentRuns, listRepositoryWorkflows, listRunJobs } from "./runs";
import { fakeFetch } from "./fake-fetch";

const BASE = "https://api.github.test";
const RUN = `${BASE}/repos/acme/app/actions/runs/7`;

describe("getRun", () => {
  it("reads the run's event, head repository and visibility, and the file of a reusable workflow", async () => {
    const fake = fakeFetch({
      [RUN]: { body: { head_sha: "abc", path: ".github/workflows/build.yml@refs/heads/main", event: "pull_request", repository: { full_name: "acme/app", private: false }, head_repository: { full_name: "stranger/app" } } },
    });
    expect(await getRun("t", { owner: "acme", repo: "app" }, 7, { fetch: fake.fetch, baseUrl: BASE })).toEqual({
      headSha: "abc",
      path: ".github/workflows/build.yml",
      event: "pull_request",
      repository: "acme/app",
      headRepository: "stranger/app",
      repositoryPrivate: false,
      createdAt: null,
    });
  });

  it("dates a run by its creation, and a re-run attempt by when that attempt started", async () => {
    const created = { head_sha: "abc", path: ".github/workflows/ci.yml", created_at: "2026-10-19T19:02:53Z", run_started_at: "2026-10-19T19:30:00Z" };
    const first = fakeFetch({ [RUN]: { body: { ...created, run_attempt: 1 } } });
    expect((await getRun("t", { owner: "acme", repo: "app" }, 7, { fetch: first.fetch, baseUrl: BASE })).createdAt).toBe("2026-10-19T19:02:53Z");
    const again = fakeFetch({ [RUN]: { body: { ...created, run_attempt: 2 } } });
    expect((await getRun("t", { owner: "acme", repo: "app" }, 7, { fetch: again.fetch, baseUrl: BASE })).createdAt).toBe("2026-10-19T19:30:00Z");
  });

  it("reports a deleted fork's head repository as null and a run without visibility as public", async () => {
    const fake = fakeFetch({ [RUN]: { body: { head_sha: "abc", path: ".github/workflows/ci.yml", event: "pull_request", head_repository: null } } });
    expect(await getRun("t", { owner: "acme", repo: "app" }, 7, { fetch: fake.fetch, baseUrl: BASE })).toMatchObject({ repository: "acme/app", headRepository: null, repositoryPrivate: false });
  });
});

describe("listRecentRuns", () => {
  it("pages through runs created since a date, newest first, up to the limit", async () => {
    const runs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from - i, status: "completed", created_at: "2026-10-05T10:00:00Z" }));
    const url = (page: number) => `${BASE}/repos/acme/app/actions/runs?created=>=2026-09-06&per_page=100&page=${page}`;
    const fake = fakeFetch({ [url(1)]: { body: { workflow_runs: runs(500, 100) } }, [url(2)]: { body: { workflow_runs: runs(400, 100) } } });
    const out = await listRecentRuns("t", { owner: "acme", repo: "app" }, new Date("2026-09-06T12:00:00Z"), 150, { fetch: fake.fetch, baseUrl: BASE });
    expect(out).toHaveLength(150);
    expect(out[0]).toEqual({ id: 500, status: "completed", createdAt: "2026-10-05T10:00:00Z" });
    expect(fake.calls).toHaveLength(2);
  });

  it("stops at a short page", async () => {
    const fake = fakeFetch({ [`${BASE}/repos/acme/app/actions/runs?created=>=2026-09-06&per_page=50&page=1`]: { body: { workflow_runs: [{ id: 1, status: "completed", created_at: "2026-10-05T10:00:00Z" }] } } });
    expect(await listRecentRuns("t", { owner: "acme", repo: "app" }, new Date("2026-09-06T00:00:00Z"), 50, { fetch: fake.fetch, baseUrl: BASE })).toHaveLength(1);
  });
});

describe("listRunJobs", () => {
  it("reads when a job started and finished, and its runner group", async () => {
    const fake = fakeFetch({
      [`${BASE}/repos/acme/app/actions/runs/7/jobs?filter=latest&per_page=100`]: {
        body: { jobs: [{ id: 1, name: "test", status: "completed", labels: ["macos-15"], created_at: "2026-10-05T10:00:00Z", started_at: "2026-10-05T10:01:30Z", completed_at: "2026-10-05T10:04:00Z", runner_group_name: "GitHub Actions" }] },
      },
    });
    expect(await listRunJobs("t", { owner: "acme", repo: "app" }, 7, { fetch: fake.fetch, baseUrl: BASE })).toEqual([
      { id: 1, name: "test", status: "completed", conclusion: null, labels: ["macos-15"], createdAt: "2026-10-05T10:00:00Z", startedAt: "2026-10-05T10:01:30Z", completedAt: "2026-10-05T10:04:00Z", runnerName: null, runnerGroupName: "GitHub Actions" },
    ]);
  });

  it("reads a job's page and its steps in GitHub's order, pending ones included", async () => {
    const fake = fakeFetch({
      [`${BASE}/repos/acme/app/actions/runs/7/jobs?filter=latest&per_page=100`]: {
        body: {
          jobs: [
            {
              id: 2,
              name: "build",
              status: "in_progress",
              created_at: "2026-10-05T10:00:00Z",
              html_url: "https://github.com/acme/app/actions/runs/7/job/2",
              steps: [
                { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-10-05T10:01:00Z", completed_at: "2026-10-05T10:01:02Z" },
                { number: 2, name: "Build", status: "in_progress", conclusion: null, started_at: "2026-10-05T10:01:02Z", completed_at: null },
                { number: 3, name: "Test", status: "queued", conclusion: null, started_at: null, completed_at: null },
              ],
            },
          ],
        },
      },
    });
    const [job] = await listRunJobs("t", { owner: "acme", repo: "app" }, 7, { fetch: fake.fetch, baseUrl: BASE });
    expect(job!.htmlUrl).toBe("https://github.com/acme/app/actions/runs/7/job/2");
    expect(job!.steps).toEqual([
      { number: 1, name: "Set up job", status: "completed", conclusion: "success", startedAt: "2026-10-05T10:01:00Z", completedAt: "2026-10-05T10:01:02Z" },
      { number: 2, name: "Build", status: "in_progress", conclusion: null, startedAt: "2026-10-05T10:01:02Z", completedAt: null },
      { number: 3, name: "Test", status: "queued", conclusion: null, startedAt: null, completedAt: null },
    ]);
  });
});

describe("workflows, branches and dispatch", () => {
  const r = { owner: "acme", repo: "app" };

  it("lists the repository's workflows with their state, and its branch names", async () => {
    const fake = fakeFetch({
      [`${BASE}/repos/acme/app/actions/workflows?per_page=100`]: { body: { total_count: 2, workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }, { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" }] } },
      [`${BASE}/repos/acme/app/branches?per_page=100`]: { body: [{ name: "main" }, { name: "feature" }] },
    });
    expect(await listRepositoryWorkflows("t", r, 200, { fetch: fake.fetch, baseUrl: BASE })).toEqual([
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" },
    ]);
    expect(await listBranchNames("t", r, 100, { fetch: fake.fetch, baseUrl: BASE })).toEqual(["main", "feature"]);
  });

  it("dispatches a workflow by id with the ref and inputs in the body", async () => {
    const sent: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await dispatchWorkflow("t", r, 9, "main", { channel: "beta" }, { fetch: fetchImpl, baseUrl: BASE });
    expect(sent).toEqual([{ url: `${BASE}/repos/acme/app/actions/workflows/9/dispatches`, method: "POST", body: { ref: "main", inputs: { channel: "beta" } } }]);
  });
});
