import { createGitHubClient, GitHubApiError } from "./client";
import type { GitHubFetchOptions } from "./app-auth";

// Actions variables at organisation or repository scope. The failover evaluator points
// BUILDHOUND_* at the healthy machine's scale set and clears it when none is healthy.

export type VariableScope = { org: string } | { owner: string; repo: string };

function basePath(scope: VariableScope): string {
  return "org" in scope ? `/orgs/${scope.org}/actions/variables` : `/repos/${scope.owner}/${scope.repo}/actions/variables`;
}

/** Creates the variable when absent (POST) and updates it when present (PATCH). Re-running with the same value is a no-op on GitHub's side. */
export async function setVariable(token: string, scope: VariableScope, name: string, value: string, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  const path = basePath(scope);
  let exists = true;
  try {
    await client.request(`${path}/${name}`);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) exists = false;
    else throw error;
  }
  if (exists) {
    await client.request(`${path}/${name}`, { method: "PATCH", body: { name, value } });
    return;
  }
  const body: Record<string, unknown> = { name, value };
  if ("org" in scope) body.visibility = "all";
  await client.request(path, { method: "POST", body });
}

/** Deleting a variable that does not exist is a success: the goal state is "absent". */
export async function deleteVariable(token: string, scope: VariableScope, name: string, options: GitHubFetchOptions = {}): Promise<void> {
  const client = createGitHubClient({ token, ...options });
  try {
    await client.request(`${basePath(scope)}/${name}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return;
    throw error;
  }
}
