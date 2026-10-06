import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { base64UrlDecode, createAppJwt, createScopedInstallationToken, getInstallationForAccount, listInstallationRepositories } from "./app-auth";
import { fakeFetch } from "./fake-fetch";

const BASE = "https://api.github.test";
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

async function verify(jwt: string): Promise<Record<string, unknown>> {
  const [header, payload, signature] = jwt.split(".");
  const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(signature!), new TextEncoder().encode(`${header}.${payload}`));
  expect(ok).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header!)))).toEqual({ alg: "RS256", typ: "JWT" });
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!))) as Record<string, unknown>;
}

describe("createAppJwt", () => {
  it("signs RS256 with a PKCS#1 key, the format GitHub issues", async () => {
    const jwt = await createAppJwt({ appId: 12345, privateKeyPem: pkcs1Pem, now: () => NOW });
    const claims = await verify(jwt);
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp).toBe(NOW / 1000 - 60 + 600);
  });
  it("accepts a PKCS#8 key and env-style escaped newlines", async () => {
    const jwt = await createAppJwt({ appId: "7", privateKeyPem: pkcs8Pem.replace(/\n/g, "\\n"), now: () => NOW });
    expect((await verify(jwt)).iss).toBe("7");
  });
  it("rejects text that is not a PEM key", async () => {
    await expect(createAppJwt({ appId: 1, privateKeyPem: "nope" })).rejects.toThrow(/PEM/);
  });
});

describe("installations", () => {
  it("falls back from the org route to the user route and returns null when neither exists", async () => {
    const fake = fakeFetch({
      [`${BASE}/orgs/benyd/installation`]: { status: 404, body: { message: "Not Found" } },
      [`${BASE}/users/benyd/installation`]: { body: { id: 99, target_type: "User", repository_selection: "selected", account: { id: 42, login: "benyd" } } },
      [`${BASE}/orgs/nobody/installation`]: { status: 404 },
      [`${BASE}/users/nobody/installation`]: { status: 404 },
    });
    const found = await getInstallationForAccount("jwt", "benyd", { fetch: fake.fetch, baseUrl: BASE });
    expect(found).toEqual({ id: 99, targetType: "User", repositorySelection: "selected", accountId: 42, accountLogin: "benyd" });
    expect(await getInstallationForAccount("jwt", "nobody", { fetch: fake.fetch, baseUrl: BASE })).toBeNull();
  });
  it("mints a token with only the requested permissions", async () => {
    const fake = fakeFetch({
      [`${BASE}/app/installations/99/access_tokens`]: {
        status: 201,
        body: { token: "ghs_x", expires_at: "2026-10-06T13:00:00Z", permissions: { administration: "write" } },
      },
    });
    const token = await createScopedInstallationToken("jwt", 99, { permissions: { administration: "write" }, repositories: ["app"] }, { fetch: fake.fetch, baseUrl: BASE });
    expect(token).toEqual({ token: "ghs_x", expiresAt: "2026-10-06T13:00:00Z", permissions: { administration: "write" } });
    expect(fake.calls[0]?.method).toBe("POST");
  });
  it("lists installation repositories across pages", async () => {
    const fake = fakeFetch({
      [`${BASE}/installation/repositories?per_page=100`]: {
        body: { total_count: 2, repositories: [{ id: 1, full_name: "benyd/app", private: true, default_branch: "main", archived: false }] },
        headers: { link: `<${BASE}/installation/repositories?per_page=100&page=2>; rel="next"` },
      },
      [`${BASE}/installation/repositories?per_page=100&page=2`]: {
        body: { total_count: 2, repositories: [{ id: 2, full_name: "benyd/site", private: false, default_branch: "main", archived: false }] },
      },
    });
    const repos = await listInstallationRepositories("ghs_x", { fetch: fake.fetch, baseUrl: BASE });
    expect(repos.map((r) => r.fullName)).toEqual(["benyd/app", "benyd/site"]);
  });
});
