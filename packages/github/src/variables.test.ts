import { describe, expect, it } from "vitest";
import { deleteVariable, setVariable } from "./variables";
import { getUser, isAdmin } from "./user";
import { fakeFetch } from "./fake-fetch";

const BASE = "https://api.github.test";

describe("variables", () => {
  it("creates an organisation variable when absent and updates it when present", async () => {
    const fake = fakeFetch({
      [`${BASE}/orgs/acme/actions/variables/BUILDHOUND_MACOS`]: [{ status: 404 }, { body: { name: "BUILDHOUND_MACOS", value: "old" } }, { status: 204 }],
      [`${BASE}/orgs/acme/actions/variables`]: { status: 201 },
    });
    await setVariable("t", { org: "acme" }, "BUILDHOUND_MACOS", "buildhound-macos-mini-01", { fetch: fake.fetch, baseUrl: BASE });
    await setVariable("t", { org: "acme" }, "BUILDHOUND_MACOS", "buildhound-macos-mini-02", { fetch: fake.fetch, baseUrl: BASE });
    expect(fake.calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "GET /orgs/acme/actions/variables/BUILDHOUND_MACOS",
      "POST /orgs/acme/actions/variables",
      "GET /orgs/acme/actions/variables/BUILDHOUND_MACOS",
      "PATCH /orgs/acme/actions/variables/BUILDHOUND_MACOS",
    ]);
  });
  it("uses the repository routes and treats a missing variable on delete as done", async () => {
    const fake = fakeFetch({
      [`${BASE}/repos/benyd/app/actions/variables/BUILDHOUND_LINUX`]: [{ status: 404 }, { status: 404 }],
      [`${BASE}/repos/benyd/app/actions/variables`]: { status: 201 },
    });
    await setVariable("t", { owner: "benyd", repo: "app" }, "BUILDHOUND_LINUX", "x", { fetch: fake.fetch, baseUrl: BASE });
    await deleteVariable("t", { owner: "benyd", repo: "app" }, "BUILDHOUND_LINUX", { fetch: fake.fetch, baseUrl: BASE });
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
  });
});

describe("user", () => {
  it("returns null for a revoked token", async () => {
    const fake = fakeFetch({ [`${BASE}/user`]: { status: 401, body: { message: "Bad credentials" } } });
    expect(await getUser("bad", { fetch: fake.fetch, baseUrl: BASE })).toBeNull();
  });
  it("is admin of its own account, of organisations with an active admin membership, and nothing else", async () => {
    const fake = fakeFetch({
      [`${BASE}/user`]: { body: { id: 1, login: "BenyD", type: "User" } },
      [`${BASE}/user/memberships/orgs/acme`]: { body: { role: "admin", state: "active" } },
      [`${BASE}/user/memberships/orgs/other`]: { body: { role: "member", state: "active" } },
      [`${BASE}/user/memberships/orgs/none`]: { status: 404 },
    });
    const opts = { fetch: fake.fetch, baseUrl: BASE };
    expect(await isAdmin("t", "benyd", opts)).toBe(true);
    expect(await isAdmin("t", "acme", opts)).toBe(true);
    expect(await isAdmin("t", "other", opts)).toBe(false);
    expect(await isAdmin("t", "none", opts)).toBe(false);
  });
});
