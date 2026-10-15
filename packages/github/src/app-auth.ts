import { createGitHubClient, GitHubApiError } from "./client";

// GitHub App authentication with Web Crypto only (ARCHITECTURE.md, Portability). The App's private
// key never leaves the control plane; agents receive installation tokens scoped to one permission.

const APP_JWT_LIFETIME_SECONDS = 10 * 60;
const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

export interface GitHubFetchOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function base64UrlEncode(bytes: Uint8Array | string): string {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of input) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function pemBody(pem: string, label: string): Uint8Array<ArrayBuffer> | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const match = re.exec(pem);
  if (!match?.[1]) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** DER length octets: short form under 128, long form otherwise. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derSequence(...parts: number[][]): number[] {
  const body = parts.flat();
  return [0x30, ...derLength(body.length), ...body];
}

/**
 * GitHub App keys are PKCS#1 (`RSA PRIVATE KEY`), which Web Crypto cannot import. Wrap the PKCS#1
 * DER in a PKCS#8 PrivateKeyInfo: SEQUENCE { INTEGER 0, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING { pkcs1 } }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const algorithm = derSequence(RSA_OID, [0x05, 0x00]);
  const key = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  return Uint8Array.from(derSequence(version, algorithm, key));
}

/** Accepts a PKCS#8 (`PRIVATE KEY`) or PKCS#1 (`RSA PRIVATE KEY`) PEM. Literal `\n` sequences from env files are unescaped. */
export async function importRsaPrivateKey(privateKeyPem: string) {
  const pem = privateKeyPem.replace(/\\n/g, "\n");
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  const der = pkcs8 ?? (pkcs1 ? pkcs1ToPkcs8(pkcs1) : null);
  if (!der) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export interface AppJwtOptions {
  appId: string | number;
  privateKeyPem: string;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
}

/** RS256 JWT for `Authorization: Bearer`, issued 60 seconds in the past to absorb clock drift, valid 10 minutes. */
export async function createAppJwt(options: AppJwtOptions): Promise<string> {
  const key = await importRsaPrivateKey(options.privateKeyPem);
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds - 60 + APP_JWT_LIFETIME_SECONDS, iss: String(options.appId) }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface AppInstallation {
  id: number;
  targetType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  accountId: number;
  accountLogin: string;
}

interface InstallationResponse {
  id: number;
  target_type: string;
  repository_selection: string;
  account: { id: number; login: string } | null;
}

/** `GET /orgs/{login}/installation`, then `GET /users/{login}/installation`; null when the App is not installed on either. */
export async function getInstallationForAccount(jwt: string, login: string, options: GitHubFetchOptions = {}): Promise<AppInstallation | null> {
  const client = createGitHubClient({ token: jwt, ...options });
  for (const path of [`/orgs/${login}/installation`, `/users/${login}/installation`]) {
    try {
      const data = await client.request<InstallationResponse>(path);
      return {
        id: data.id,
        targetType: data.target_type === "Organization" ? "Organization" : "User",
        repositorySelection: data.repository_selection === "all" ? "all" : "selected",
        accountId: data.account?.id ?? 0,
        accountLogin: data.account?.login ?? login,
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) continue;
      throw error;
    }
  }
  return null;
}

export type InstallationPermissions = Record<string, "read" | "write">;

export interface ScopedInstallationToken {
  token: string;
  expiresAt: string;
  permissions: InstallationPermissions;
}

/** `POST /app/installations/{id}/access_tokens` with a permissions subset, so the agent never holds more than it needs. */
export async function createScopedInstallationToken(
  jwt: string,
  installationId: number,
  scope: { permissions: InstallationPermissions; repositories?: string[] },
  options: GitHubFetchOptions = {},
): Promise<ScopedInstallationToken> {
  const client = createGitHubClient({ token: jwt, ...options });
  const body: Record<string, unknown> = { permissions: scope.permissions };
  if (scope.repositories && scope.repositories.length > 0) body.repositories = scope.repositories;
  const data = await client.request<{ token: string; expires_at: string; permissions?: InstallationPermissions }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", body },
  );
  return { token: data.token, expiresAt: data.expires_at, permissions: data.permissions ?? scope.permissions };
}

export interface InstallationRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  /** The last push, so a caller can take the most active repositories first. */
  pushedAt?: string | null;
}

/** Every repository the installation covers, paginated. */
export async function listInstallationRepositories(installationToken: string, options: GitHubFetchOptions = {}): Promise<InstallationRepository[]> {
  const client = createGitHubClient({ token: installationToken, ...options });
  const items = await client.paginate<{ id: number; full_name: string; private: boolean; default_branch: string; archived: boolean; pushed_at?: string | null }>(
    "/installation/repositories",
  );
  return items.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, archived: r.archived, pushedAt: r.pushed_at ?? null }));
}
