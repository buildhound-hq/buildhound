import { COMBINED_FIX_BRANCH, FIX_TRAILER, fixBranch, fixMarkerRules } from "@buildhound/core";
import type { GitHubClient } from "@buildhound/github";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import type { Source } from "./audit";
import { resolveToken } from "./token";
import { parseRepo } from "./workflows";
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

/**
 * What one pull request writes: a fix group from the CI report, or the routing pull request. `trailer` marks the
 * commit as Buildhound's own (default `Buildhound-Fix`), and `noun` names the change in notes (default "fix").
 */
export interface PullRequestChange {
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: ReadonlyArray<{ path: string; after: string }>;
  trailer?: string;
  noun?: string;
}

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
async function sameContent(gh: Rest, owner: string, name: string, base: Base, sha: string, group: PullRequestChange): Promise<boolean> {
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

async function commitGroup(gh: Rest, owner: string, name: string, base: Base, group: PullRequestChange): Promise<string> {
  const repo = `/repos/${seg(owner)}/${seg(name)}`;
  const tree = await gh.request<{ sha: string }>(`${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: base.treeSha, tree: group.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.after })) },
  });
  const commit = await gh.request<{ sha: string }>(`${repo}/git/commits`, { method: "POST", body: { message: group.commitMessage, tree: tree.sha, parents: [base.sha] } });
  return commit.sha;
}

/** Open or update one fix (or routing) pull request. Throws GitHub's error; the caller maps it to a CLI error with `next`. */
export async function openFixPullRequest(gh: Rest, owner: string, name: string, base: Base, group: PullRequestChange): Promise<FixOutcome> {
  const repo = `/repos/${seg(owner)}/${seg(name)}`;
  const trailer = group.trailer ?? FIX_TRAILER;
  const noun = group.noun ?? "fix";
  const pulls = await pullsFor(gh, owner, name, group.branch, "all");
  const open = pulls.find((p) => p.state === "open");
  const latest = pulls[0];
  if (!open && latest && latest.state === "closed" && !latest.merged_at) {
    return { branch: group.branch, status: "skipped", url: latest.html_url, number: latest.number, note: `pull request #${latest.number} for this ${noun} was closed without merging, so it is not opened again; reopen it on GitHub to take the ${noun}` };
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
    if (!head.message.includes(`${trailer}:`)) {
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
    return { branch: group.branch, status, url: open.html_url, number: open.number, ...(status === "unchanged" ? { note: `already open with this ${noun}` } : {}) };
  }
  const pr = await gh.request<{ number: number; html_url: string }>(`${repo}/pulls`, { method: "POST", body: { title: group.title, head: group.branch, base: base.branch, body: group.body } });
  return { branch: group.branch, status: "created", url: pr.html_url, number: pr.number };
}

/**
 * The repository's default GITHUB_TOKEN permission from its Actions settings, as the job classifier reads it
 * (SECURITY.md, Trusted machines). Undefined when it cannot be read, which the classifier counts as write.
 */
export async function readDefaultTokenPermission(gh: Rest, owner: string, name: string): Promise<"read" | "write" | undefined> {
  try {
    const r = await gh.request<{ default_workflow_permissions?: string }>(`/repos/${seg(owner)}/${seg(name)}/actions/permissions/workflow`);
    return r.default_workflow_permissions === "read" || r.default_workflow_permissions === "write" ? r.default_workflow_permissions : undefined;
  } catch {
    return undefined;
  }
}

/** A GitHub client with the person's token, or the one a test hands in. */
export async function githubClient(token: string, given?: Rest): Promise<Rest> {
  if (given) return given;
  const mod = await import("@buildhound/github");
  return mod.createGitHubClient({ token, ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}) });
}

/**
 * GitHub's error on a write, as a CLI error whose `next` says what a person or agent does about it. `command` is the
 * command to run again; `maintainer` is the same command as a maintainer would run it, for NO_PUSH_ACCESS.
 */
export function writeError(e: unknown, repo: string, command: string, opened: ReadonlyArray<{ url: string | null }>, maintainer: string): CliError {
  if (e instanceof CliError) return e;
  const status = (e as { status?: unknown })?.status;
  const message = e instanceof Error ? e.message : String(e);
  const so = opened.filter((p) => p.url).map((p) => p.url).join(", ");
  const sofar = so ? ` Opened or updated so far: ${so}.` : "";
  // GitHub answers a tree write that changes .github/workflows without the workflow scope with a plain 404 once
  // the repository showed push access (found on a real repository 2026-10-16), so that 404 means the same.
  if ((/workflow/i.test(message) && /scope|permission/i.test(message)) || (status === 404 && /\/git\/trees\b/.test(message))) {
    return new CliError("WORKFLOW_SCOPE_REQUIRED", `GitHub refused to change workflow files with this token: it needs the workflow scope (a fine-grained token needs Workflows write).${sofar}`, `gh auth refresh -s workflow, then ${command}`, EXIT.auth);
  }
  if (status === 401) return new CliError("TOKEN_INVALID", `GitHub rejected the token: ${message}${sofar}`, `${command} --token $(gh auth token)`, EXIT.auth);
  if (status === 403 || status === 404) {
    return new CliError("NO_PUSH_ACCESS", `the token cannot write to ${repo}: ${message}.${sofar}`, `use a token that can push to ${repo} (gh auth login, or a fine-grained token with Contents and Pull requests write and Workflows write), or ask a maintainer to run ${maintainer}`, EXIT.auth);
  }
  return new CliError("GITHUB_ERROR", `GitHub request failed: ${message}.${sofar}`, command, EXIT.network);
}

export interface WriteTarget {
  gh: Rest;
  owner: string;
  name: string;
  base: Base;
  /** The source with GitHub's workflow files at the default branch's head and the repository as GitHub reports it. */
  src: Source;
  assumptions: string[];
}

/**
 * Everything a command needs before it writes a pull request: the repository named, a token, push access, the default
 * branch's head and the workflow files at that commit, so a pull request never carries uncommitted or unpushed changes.
 * `command` is the command with --yes; `unknownRepo` the same with `--repo <owner/name>`; `maintainer(fullName, name)`
 * the advice when the login cannot push.
 */
export async function prepareWrite(i: { src: Source; repoGiven: boolean; token: string | undefined; github?: Rest | undefined; command: string; unknownRepo: string; purpose: string; maintainer: (fullName: string, name: string) => string }): Promise<WriteTarget> {
  if (i.src.repo === "local/repo") throw new CliError("REPO_UNKNOWN", "no GitHub repository found for this directory: it has no origin remote on github.com", i.unknownRepo, EXIT.usage);
  const { owner, name } = parseRepo(i.src.repo, i.command);
  const token = resolveToken(i.token, i.command, i.purpose);
  const gh = await githubClient(token, i.github);
  let access: RepoAccess;
  try {
    access = await readRepoAccess(gh, owner, name);
  } catch (e) {
    if ((e as { status?: unknown })?.status === 404) throw new CliError("REPO_NOT_FOUND", `${i.src.repo} was not found or the token cannot see it`, `${i.command} --token $(gh auth token)`, EXIT.network);
    throw writeError(e, i.src.repo, i.command, [], i.maintainer(i.src.repo, name));
  }
  if (access.archived) throw new CliError("REPO_ARCHIVED", `${access.fullName} is archived, so it takes no pull requests`, "buildhound scan", EXIT.usage);
  if (!access.push) throw new CliError("NO_PUSH_ACCESS", `your GitHub login cannot push to ${access.fullName}, so it cannot open pull requests there`, i.maintainer(access.fullName, name), EXIT.auth);
  try {
    const base = await readBase(gh, owner, name, access.defaultBranch);
    const remote = await readWorkflowsAt(gh, owner, name, base.sha);
    const differs = i.src.workflows.filter((w) => remote.find((r) => r.path === w.path)?.content !== w.content).map((w) => w.path);
    const assumptions = [`Changes are made against ${access.defaultBranch} on GitHub (${base.sha.slice(0, 7)}), never against uncommitted or unpushed changes.`];
    if (!i.repoGiven && differs.length) assumptions.push(`This checkout's ${differs.join(", ")} ${differs.length === 1 ? "differs" : "differ"} from ${access.defaultBranch} on GitHub; the pull requests change GitHub's version.`);
    const src: Source = { ...i.src, workflows: remote, repository: { ...i.src.repository, fullName: access.fullName, private: access.private, defaultBranch: access.defaultBranch } };
    return { gh, owner, name, base, src, assumptions };
  } catch (e) {
    throw writeError(e, i.src.repo, i.command, [], i.maintainer(i.src.repo, name));
  }
}
