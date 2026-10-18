import { createGitHubClient, GitHubApiError } from "./client";
import type { GitHubFetchOptions } from "./app-auth";

export interface GitHubUser {
  id: number;
  login: string;
  type: "User" | "Organization";
  /** The public email on the GitHub profile, when the person set one; the support form replies there. */
  email?: string | null;
}

/** `GET /user` for a user token; null when the token is missing or revoked (401). */
export async function getUser(userToken: string, options: GitHubFetchOptions = {}): Promise<GitHubUser | null> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const data = await client.request<{ id: number; login: string; type?: string; email?: string | null }>("/user");
    return { id: data.id, login: data.login, type: data.type === "Organization" ? "Organization" : "User", email: data.email ?? null };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * The person's primary verified email, from `GET /user/emails`, for when the profile shows none. Needs the GitHub App's
 * "Email addresses" account permission (GITHUB_APP.md); null when it is not granted (403 or 404), the token is revoked,
 * or no address is verified.
 */
export async function getPrimaryEmail(userToken: string, options: GitHubFetchOptions = {}): Promise<string | null> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const emails = await client.request<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails");
    return (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return null;
    throw error;
  }
}

/**
 * A user administers an account when it is their own, or when `GET /user/memberships/orgs/{org}` reports an
 * active admin role. Anything else (404, member role, pending state) is not admin. See `orgRole` for `accountId`.
 */
export async function isAdmin(userToken: string, login: string, options: GitHubFetchOptions = {}, accountId?: number): Promise<boolean> {
  return (await orgRole(userToken, login, options, accountId)) === "admin";
}

/**
 * The user's role in an organisation from `GET /user/memberships/orgs/{org}`: admin or member when the
 * membership is active, else null. On their own account a user is admin.
 *
 * With `accountId`, GitHub's id for the account, the stored login is only a hint (found in an abuse review): a
 * login freed by a rename can be taken by someone else. The holder of a personal account is the user with that id,
 * whatever either login is now, and a membership counts only when GitHub names the organisation with that id.
 */
export async function orgRole(userToken: string, login: string, options: GitHubFetchOptions = {}, accountId?: number): Promise<"admin" | "member" | null> {
  const user = await getUser(userToken, options);
  if (!user) return null;
  if (accountId !== undefined && user.id === accountId) return "admin";
  if (user.login.toLowerCase() === login.toLowerCase()) return accountId === undefined ? "admin" : null;
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const membership = await client.request<{ role?: string; state?: string; organization?: { id?: number } }>(`/user/memberships/orgs/${login}`);
    if (membership.state !== "active") return null;
    if (accountId !== undefined && membership.organization?.id !== accountId) return null;
    return membership.role === "admin" ? "admin" : "member";
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** Whether the user can read a repository: `GET /repos/{owner}/{repo}` answers 200 only then. */
export async function canReadRepository(userToken: string, fullName: string, options: GitHubFetchOptions = {}): Promise<boolean> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    await client.request(`/repos/${fullName}`);
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403 || error.status === 401)) return false;
    throw error;
  }
}

/** The organisations the user belongs to (`GET /user/orgs`, first 100). */
export async function listUserOrgs(userToken: string, options: GitHubFetchOptions = {}): Promise<string[]> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const orgs = await client.request<Array<{ login: string }>>("/user/orgs", { params: { per_page: 100 } });
    return orgs.map((o) => o.login);
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 403 || error.status === 401)) return [];
    throw error;
  }
}

/** GitHub's REST root, as the client uses it. */
const API = "https://api.github.com";

/**
 * Revokes Buildhound's grant for one person: `DELETE /applications/{client_id}/grant` with basic auth by the App's client
 * id and secret and the person's token in the body. Every token GitHub issued Buildhound for that person stops working,
 * on every device. "revoked" when GitHub removed it now (204), "no_grant" when the token was already revoked or never
 * Buildhound's (404, 422), so a second call changes nothing. The secret and the token go only to GitHub, never to a log.
 */
export async function revokeGrant(clientId: string, clientSecret: string, userToken: string, options: GitHubFetchOptions = {}): Promise<"revoked" | "no_grant"> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(`${options.baseUrl ?? API}/applications/${encodeURIComponent(clientId)}/grant`, {
    method: "DELETE",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "buildhound",
    },
    body: JSON.stringify({ access_token: userToken }),
  });
  if (res.status === 204) return "revoked";
  if (res.status === 404 || res.status === 422) return "no_grant";
  // The body may echo what was sent: only the status is kept.
  throw new GitHubApiError(res.status, `/applications/{client_id}/grant`, `GitHub answered ${res.status}`);
}

/** One installation of the GitHub App the person can see (`GET /user/installations`). */
export interface UserInstallation {
  id: number;
  account: { login: string; type: "User" | "Organization"; avatar_url: string | null };
  repository_selection: "all" | "selected";
  /** Where a person changes the installation on GitHub. */
  html_url: string;
}

/**
 * The App's installations a person can reach with their token, first 100; null when the token is not one GitHub issued
 * the App (401, 403), which only the App's own sign-in tokens are.
 */
export async function listUserInstallations(userToken: string, options: GitHubFetchOptions = {}): Promise<UserInstallation[] | null> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const data = await client.request<{ installations?: Array<{ id: number; account?: { login?: string; type?: string; avatar_url?: string } | null; repository_selection?: string; html_url?: string }> }>("/user/installations", { params: { per_page: 100 } });
    return (data.installations ?? []).map((i) => ({
      id: i.id,
      account: { login: i.account?.login ?? "", type: i.account?.type === "Organization" ? "Organization" : "User", avatar_url: i.account?.avatar_url ?? null },
      repository_selection: i.repository_selection === "selected" ? "selected" : "all",
      html_url: i.html_url ?? "",
    }));
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

/** How many repositories an installation gives the person (`GET /user/installations/{id}/repositories`, its total_count). */
export async function countUserInstallationRepositories(userToken: string, installationId: number, options: GitHubFetchOptions = {}): Promise<number | null> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const data = await client.request<{ total_count?: number }>(`/user/installations/${installationId}/repositories`, { params: { per_page: 1 } });
    return typeof data.total_count === "number" ? data.total_count : null;
  } catch (error) {
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return null;
    throw error;
  }
}
