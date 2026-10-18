import { describe, expect, it } from "vitest";
import { orgRole } from "./user";

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
});
