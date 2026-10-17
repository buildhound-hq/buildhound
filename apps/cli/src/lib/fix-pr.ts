import { COMBINED_FIX_BRANCH, fixBranch, fixMarkerRules } from "@buildhound/core";
import { pullsFor, readBase, readRepoAccess, readWorkflowsAt } from "@buildhound/github/pulls";
import type { Base, RepoAccess, Rest } from "@buildhound/github/pulls";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import type { Source } from "./audit";
import { resolveToken } from "./token";
import { parseRepo } from "./workflows";

/**
 * The CLI's side of opening pull requests: the writes themselves (a branch from the default branch's head, one commit,
 * then the pull request, idempotent) are `@buildhound/github/pulls`, shared with the control plane's routing endpoint;
 * here are the token, the checks before a write and GitHub's errors as CLI errors with `next`.
 */
export { openFixPullRequest, readBase, readDefaultTokenPermission, readRepoAccess, readWorkflowsAt } from "@buildhound/github/pulls";
export type { Base, FixOutcome, FixStatus, PullRequestChange, RepoAccess, Rest } from "@buildhound/github/pulls";

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
