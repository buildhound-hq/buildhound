import { describe, expect, it } from "vitest";
import { isAdmin, orgRole } from "./user";

function fakeGitHub(membership: Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1, login: "ada", type: "User" }), { status: 200 });
    if (url.endsWith("/user/memberships/orgs/acme")) return membership.clone();
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

const membership = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

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
