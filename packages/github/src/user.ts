import { createGitHubClient, GitHubApiError } from "./client";
import type { GitHubFetchOptions } from "./app-auth";

export interface GitHubUser {
  id: number;
  login: string;
  type: "User" | "Organization";
}

/** `GET /user` for a user token; null when the token is missing or revoked (401). */
export async function getUser(userToken: string, options: GitHubFetchOptions = {}): Promise<GitHubUser | null> {
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const data = await client.request<{ id: number; login: string; type?: string }>("/user");
    return { id: data.id, login: data.login, type: data.type === "Organization" ? "Organization" : "User" };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * A user administers an account when it is their own login, or when `GET /user/memberships/orgs/{org}`
 * reports an active admin role. Anything else (404, member role, pending state) is not admin.
 */
export async function isAdmin(userToken: string, login: string, options: GitHubFetchOptions = {}): Promise<boolean> {
  const user = await getUser(userToken, options);
  if (!user) return false;
  if (user.login.toLowerCase() === login.toLowerCase()) return true;
  const client = createGitHubClient({ token: userToken, ...options });
  try {
    const membership = await client.request<{ role?: string; state?: string }>(`/user/memberships/orgs/${login}`);
    return membership.role === "admin" && membership.state === "active";
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
}
