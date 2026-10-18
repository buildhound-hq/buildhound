import { describe, expect, it } from "vitest";
import { countUserInstallationRepositories, getPrimaryEmail, isAdmin, listUserInstallations, orgRole, revokeGrant } from "./user";

function fakeGitHub(membership: Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1, login: "ada", type: "User" }), { status: 200 });
    if (url.endsWith("/user/memberships/orgs/acme")) return membership.clone();
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

const membership = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

describe("getPrimaryEmail", () => {
  const reply = (status: number, body?: unknown) => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("picks the primary verified address, else any verified one", async () => {
    expect(await getPrimaryEmail("gho_x", { fetch: reply(200, [{ email: "old@x.dev", primary: false, verified: true }, { email: "ada@x.dev", primary: true, verified: true }]) })).toBe("ada@x.dev");
    expect(await getPrimaryEmail("gho_x", { fetch: reply(200, [{ email: "new@x.dev", primary: true, verified: false }, { email: "ok@x.dev", primary: false, verified: true }]) })).toBe("ok@x.dev");
  });
  it("is null without the App's email permission or with a revoked token", async () => {
    expect(await getPrimaryEmail("gho_x", { fetch: reply(403, { message: "Resource not accessible by integration" }) })).toBeNull();
    expect(await getPrimaryEmail("gho_x", { fetch: reply(404, { message: "Not Found" }) })).toBeNull();
    expect(await getPrimaryEmail("gho_x", { fetch: reply(401, { message: "Bad credentials" }) })).toBeNull();
  });
});

describe("orgRole", () => {
  it("is admin only for an active owner", async () => {
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(membership({ role: "admin", state: "active" })) })).toBe("admin");
    expect(await orgRole("gho_x", "ada", { fetch: fakeGitHub(membership({})) })).toBe("admin");
  });

  // GitHub custom organisation and repository roles never change the membership role, and any value
  // GitHub adds later must not grant more than member (SECURITY.md, Roles).
  it("reads every other active role as member, never admin", async () => {
    for (const role of ["member", "billing_manager", "ci_admin", "", undefined]) {
      expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(membership({ role, state: "active" })) })).toBe("member");
    }
  });

  it("gives no role to a pending invite or someone outside the organisation", async () => {
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(membership({ role: "admin", state: "pending" })) })).toBeNull();
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(new Response(null, { status: 404 })) })).toBeNull();
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(new Response(null, { status: 403 })) })).toBeNull();
  });

  // A login freed by a rename can be registered by someone else, so GitHub's id decides (found in an abuse review).
  it("goes by the account's id over its stored login", async () => {
    // ada is user id 1. Her own account, renamed since: admin by id whatever the stored login says.
    expect(await orgRole("gho_x", "ada-old-name", { fetch: fakeGitHub(membership({})) }, 1)).toBe("admin");
    // Someone else's account that once had the login "ada": not hers.
    expect(await orgRole("gho_x", "ada", { fetch: fakeGitHub(membership({})) }, 99)).toBeNull();
    // An organisation now called acme that is not the one Buildhound knows by id.
    const other = membership({ role: "admin", state: "active", organization: { id: 7 } });
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(other) }, 500)).toBeNull();
    expect(await isAdmin("gho_x", "acme", { fetch: fakeGitHub(other) }, 500)).toBe(false);
    const same = membership({ role: "member", state: "active", organization: { id: 500 } });
    expect(await orgRole("gho_x", "acme", { fetch: fakeGitHub(same) }, 500)).toBe("member");
  });
});

describe("revokeGrant", () => {
  it("deletes the grant with basic auth and the token in the body, and reads 404 and 422 as already gone", async () => {
    const seen: Array<{ url: string; method: string | undefined; auth: string | null; body: unknown }> = [];
    const reply = (status: number) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status });
      }) as typeof fetch;
    expect(await revokeGrant("Iv1.abc", "s3cret", "ghu_token", { fetch: reply(204) })).toBe("revoked");
    expect(seen[0]).toEqual({ url: "https://api.github.com/applications/Iv1.abc/grant", method: "DELETE", auth: `Basic ${btoa("Iv1.abc:s3cret")}`, body: { access_token: "ghu_token" } });
    expect(await revokeGrant("Iv1.abc", "s3cret", "ghu_token", { fetch: reply(404) })).toBe("no_grant");
    expect(await revokeGrant("Iv1.abc", "s3cret", "ghu_token", { fetch: reply(422) })).toBe("no_grant");
    const failed = await revokeGrant("Iv1.abc", "s3cret", "ghu_token", { fetch: reply(500) }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(String((failed as Error).message)).not.toMatch(/s3cret|ghu_token/);
  });
});

describe("listUserInstallations", () => {
  it("lists the App's installations the person can see, and is null for a token GitHub did not issue the App", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/user/installations/2/repositories")) return new Response(JSON.stringify({ total_count: 3, repositories: [] }), { status: 200 });
      if (url.includes("/user/installations")) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            installations: [
              { id: 1, account: { login: "BenyD", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1" }, repository_selection: "all", html_url: "https://github.com/settings/installations/1" },
              { id: 2, account: { login: "buildhound-hq", type: "Organization", avatar_url: "https://avatars.githubusercontent.com/u/2" }, repository_selection: "selected", html_url: "https://github.com/organizations/buildhound-hq/settings/installations/2" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const list = await listUserInstallations("ghu_x", { fetch: fetcher });
    expect(list).toEqual([
      { id: 1, account: { login: "BenyD", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1" }, repository_selection: "all", html_url: "https://github.com/settings/installations/1" },
      { id: 2, account: { login: "buildhound-hq", type: "Organization", avatar_url: "https://avatars.githubusercontent.com/u/2" }, repository_selection: "selected", html_url: "https://github.com/organizations/buildhound-hq/settings/installations/2" },
    ]);
    expect(await countUserInstallationRepositories("ghu_x", 2, { fetch: fetcher })).toBe(3);
    const refused = (async () => new Response(JSON.stringify({ message: "You must authenticate with an access token authorized to a GitHub App" }), { status: 403 })) as unknown as typeof fetch;
    expect(await listUserInstallations("gho_cli", { fetch: refused })).toBeNull();
  });
});
