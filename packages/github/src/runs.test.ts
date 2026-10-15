import { describe, expect, it } from "vitest";
import { getRun, listRecentRuns, listRunJobs } from "./runs";
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
    });
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
  it("reads when a job started and its runner group", async () => {
    const fake = fakeFetch({
      [`${BASE}/repos/acme/app/actions/runs/7/jobs?filter=latest&per_page=100`]: {
        body: { jobs: [{ id: 1, name: "test", status: "completed", labels: ["macos-15"], created_at: "2026-10-05T10:00:00Z", started_at: "2026-10-05T10:01:30Z", runner_group_name: "GitHub Actions" }] },
      },
    });
    expect(await listRunJobs("t", { owner: "acme", repo: "app" }, 7, { fetch: fake.fetch, baseUrl: BASE })).toEqual([
      { id: 1, name: "test", status: "completed", conclusion: null, labels: ["macos-15"], createdAt: "2026-10-05T10:00:00Z", startedAt: "2026-10-05T10:01:30Z", runnerName: null, runnerGroupName: "GitHub Actions" },
    ]);
  });
});
