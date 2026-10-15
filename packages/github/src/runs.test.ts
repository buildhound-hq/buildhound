import { describe, expect, it } from "vitest";
import { getRun } from "./runs";
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
