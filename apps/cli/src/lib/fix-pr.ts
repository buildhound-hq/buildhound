import { COMBINED_FIX_BRANCH, FIX_TRAILER, fixBranch, fixMarkerRules } from "@buildhound/core";
import type { FixGroup } from "@buildhound/core";
import type { GitHubClient } from "@buildhound/github";
import type { WorkflowFile } from "./workflows";

/**
 * Opens the CI report's fix pull requests through the GitHub REST API with the person's own token: a branch from the
 * default branch's head, one commit through the Git Data API, then the pull request. No local git state is touched.
 * Idempotent: a branch Buildhound made is updated in place and its open pull request edited, never duplicated.
 */

/** The part of the GitHub client this needs, so tests can hand in a client over a fake GitHub. */
export type Rest = Pick<GitHubClient, "request" | "getWorkflowContent">;

export interface RepoAccess {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  /** The token's user can push (write, maintain or admin). */
  push: boolean;
}

export interface Base {
  branch: string;
  sha: string;
  treeSha: string;
}

export type FixStatus = "planned" | "created" | "updated" | "unchanged" | "skipped";

export interface FixOutcome {
  branch: string;
  status: FixStatus;
  url: string | null;
  number: number | null;
  note?: string;
}

interface PullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  merged_at: string | null;
}

const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** 404 from GitHub, read from the error's status so this works whatever client threw it. */
const isNotFound = (e: unknown) => (e as { status?: unknown })?.status === 404;

export async function readRepoAccess(gh: Rest, owner: string, name: string): Promise<RepoAccess> {
  const r = await gh.request<{ full_name: string; default_branch: string; private: boolean; archived?: boolean; permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } }>(`/repos/${seg(owner)}/${seg(name)}`);
  const p = r.permissions ?? {};
  return { fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, archived: Boolean(r.archived), push: Boolean(p.push || p.admin || p.maintain) };
}

export async function readBase(gh: Rest, owner: string, name: string, branch: string): Promise<Base> {
  const ref = await gh.request<{ object: { sha: string } }>(`/repos/${seg(owner)}/${seg(name)}/git/ref/heads/${seg(branch)}`);
  const commit = await gh.request<{ tree: { sha: string } }>(`/repos/${seg(owner)}/${seg(name)}/git/commits/${ref.object.sha}`);
  return { branch, sha: ref.object.sha, treeSha: commit.tree.sha };
}

/** Every workflow file at a commit, read through the Contents API. Files it cannot read as text are left out. */
export async function readWorkflowsAt(gh: Rest, owner: string, name: string, sha: string): Promise<WorkflowFile[]> {
  let list: Array<{ type: string; path: string; name: string }> = [];
  try {
    list = await gh.request<typeof list>(`/repos/${seg(owner)}/${seg(name)}/contents/.github/workflows`, { params: { ref: sha } });
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: WorkflowFile[] = [];
  for (const f of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.type !== "file" || !/\.ya?ml$/i.test(f.name)) continue;
    try {
      out.push(await gh.getWorkflowContent(owner, name, f.path, sha));
    } catch (e) {
      if ((e as { name?: string })?.name === "UnreadableFileError") continue;
      throw e;
    }
  }
  return out;
}

async function pullsFor(gh: Rest, owner: string, name: string, branch: string, state: "open" | "all"): Promise<PullRequest[]> {
  return gh.request<PullRequest[]>(`/repos/${seg(owner)}/${seg(name)}/pulls`, { params: { head: `${owner}:${branch}`, state, per_page: 20 } });
}

/**
 * Rules already in an open fix pull request of the other kind, so the two modes never open the same fix twice:
 * per rule, the combined pull request's rules; with `--one-pr`, every rule that has its own open pull request.
 */
export async function coveredElsewhere(gh: Rest, owner: string, name: string, onePr: boolean, ruleIds: readonly string[]): Promise<Map<string, { branch: string; url: string; number: number }>> {
  const covered = new Map<string, { branch: string; url: string; number: number }>();
  if (!onePr) {
    for (const pr of await pullsFor(gh, owner, name, COMBINED_FIX_BRANCH, "open")) {
      for (const id of fixMarkerRules(pr.body)) covered.set(id, { branch: COMBINED_FIX_BRANCH, url: pr.html_url, number: pr.number });
    }
    return covered;
  }
  for (const id of ruleIds) {
    const pr = (await pullsFor(gh, owner, name, fixBranch(id), "open"))[0];
    if (pr) covered.set(id, { branch: fixBranch(id), url: pr.html_url, number: pr.number });
  }
  return covered;
}

/** The branch changes exactly the group's files, to exactly the fixed content, against where it left the default branch. */
async function sameContent(gh: Rest, owner: string, name: string, base: Base, sha: string, group: FixGroup): Promise<boolean> {
  const cmp = await gh.request<{ files?: Array<{ filename: string }> }>(`/repos/${seg(owner)}/${seg(name)}/compare/${base.sha}...${sha}`);
  const changed = (cmp.files ?? []).map((f) => f.filename).sort();
  const wanted = group.files.map((f) => f.path).sort();
  if (changed.length !== wanted.length || changed.some((p, i) => p !== wanted[i])) return false;
  for (const f of group.files) {
    try {
      const at = await gh.getWorkflowContent(owner, name, f.path, sha);
      if (at.content !== f.after) return false;
    } catch (e) {
      if (isNotFound(e) || (e as { name?: string })?.name === "UnreadableFileError") return false;
      throw e;
    }
  }
  return true;
}

async function commitGroup(gh: Rest, owner: string, name: string, base: Base, group: FixGroup): Promise<string> {
  const repo = `/repos/${seg(owner)}/${seg(name)}`;
  const tree = await gh.request<{ sha: string }>(`${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: base.treeSha, tree: group.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.after })) },
  });
  const commit = await gh.request<{ sha: string }>(`${repo}/git/commits`, { method: "POST", body: { message: group.commitMessage, tree: tree.sha, parents: [base.sha] } });
  return commit.sha;
}

/** Open or update one fix pull request. Throws GitHub's error; the caller maps it to a CLI error with `next`. */
export async function openFixPullRequest(gh: Rest, owner: string, name: string, base: Base, group: FixGroup): Promise<FixOutcome> {
  const repo = `/repos/${seg(owner)}/${seg(name)}`;
  const pulls = await pullsFor(gh, owner, name, group.branch, "all");
  const open = pulls.find((p) => p.state === "open");
  const latest = pulls[0];
  if (!open && latest && latest.state === "closed" && !latest.merged_at) {
    return { branch: group.branch, status: "skipped", url: latest.html_url, number: latest.number, note: `pull request #${latest.number} for this fix was closed without merging, so it is not opened again; reopen it on GitHub to take the fix` };
  }

  let ref: { object: { sha: string } } | null = null;
  try {
    ref = await gh.request<{ object: { sha: string } }>(`${repo}/git/ref/heads/${seg(group.branch)}`);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  let branchChanged = false;
  if (ref) {
    const head = await gh.request<{ message: string }>(`${repo}/git/commits/${ref.object.sha}`);
    if (!head.message.includes(`${FIX_TRAILER}:`)) {
      return { branch: group.branch, status: "skipped", url: open?.html_url ?? null, number: open?.number ?? null, note: `branch ${group.branch} has a commit Buildhound did not make, so it is left alone; merge or delete it, then run this again` };
    }
    if (!(await sameContent(gh, owner, name, base, ref.object.sha, group))) {
      const sha = await commitGroup(gh, owner, name, base, group);
      await gh.request(`${repo}/git/refs/heads/${seg(group.branch)}`, { method: "PATCH", body: { sha, force: true } });
      branchChanged = true;
    }
  } else {
    const sha = await commitGroup(gh, owner, name, base, group);
    await gh.request(`${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${group.branch}`, sha } });
  }

  if (open) {
    const bodyChanged = open.title !== group.title || (open.body ?? "") !== group.body;
    if (bodyChanged) await gh.request(`${repo}/pulls/${open.number}`, { method: "PATCH", body: { title: group.title, body: group.body } });
    const status: FixStatus = branchChanged || bodyChanged ? "updated" : "unchanged";
    return { branch: group.branch, status, url: open.html_url, number: open.number, ...(status === "unchanged" ? { note: "already open with this fix" } : {}) };
  }
  const pr = await gh.request<{ number: number; html_url: string }>(`${repo}/pulls`, { method: "POST", body: { title: group.title, head: group.branch, base: base.branch, body: group.body } });
  return { branch: group.branch, status: "created", url: pr.html_url, number: pr.number };
}
