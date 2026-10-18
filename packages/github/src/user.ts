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
