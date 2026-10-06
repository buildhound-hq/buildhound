import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import { runQuiet, which } from "./exec";

export interface WorkflowFile {
  /** Repository-relative path, always `.github/workflows/<name>`. */
  path: string;
  content: string;
}

/**
 * Absolute path for a user-supplied path. `pnpm cli -- scan apps/cli/fixtures` runs with cwd apps/cli,
 * so a relative path that does not exist there is tried against INIT_CWD (where pnpm was invoked).
 */
export function resolveUserPath(p: string): string {
  const direct = path.resolve(p);
  if (existsSync(direct) || path.isAbsolute(p)) return direct;
  const init = process.env.INIT_CWD;
  if (init) {
    const alt = path.resolve(init, p);
    if (existsSync(alt)) return alt;
  }
  return direct;
}

/** Every .yml and .yaml file under <root>/.github/workflows, sorted by name. Missing directory gives an empty list. */
export function readLocalWorkflows(root: string): WorkflowFile[] {
  const abs = resolveUserPath(root);
  if (!existsSync(abs)) throw new CliError("PATH_NOT_FOUND", `${abs} does not exist`, "buildhound scan <path-to-repository-root>", EXIT.usage);
  if (!statSync(abs).isDirectory()) throw new CliError("PATH_NOT_DIRECTORY", `${abs} is not a directory`, "buildhound scan <path-to-repository-root>", EXIT.usage);
  const dir = path.join(abs, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ path: `.github/workflows/${f}`, content: readFileSync(path.join(dir, f), "utf8") }));
}

/** Read one workflow file given as a path on disk. */
export function readWorkflowFile(file: string): WorkflowFile {
  const abs = resolveUserPath(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new CliError("FILE_NOT_FOUND", `${abs} is not a file`, "buildhound estimate .github/workflows/<name>.yml", EXIT.usage);
  const idx = abs.split(path.sep).lastIndexOf(".github");
  const rel = idx >= 0 ? abs.split(path.sep).slice(idx).join("/") : path.basename(abs);
  return { path: rel, content: readFileSync(abs, "utf8") };
}

/** owner/name from a git remote URL (https, ssh or git protocol), or null. */
export function repoFromRemote(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Repository name from the origin remote when git is present and the path is a repository, else "local/repo". */
export function localRepoName(root: string): string {
  const git = which("git");
  if (!git) return "local/repo";
  const url = runQuiet(git, ["-C", resolveUserPath(root), "remote", "get-url", "origin"]);
  return (url && repoFromRemote(url)) ?? "local/repo";
}

/** Validate an `owner/name` argument. */
export function parseRepo(repo: string, next: string): { owner: string; name: string } {
  const m = repo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) throw new CliError("REPO_INVALID", `--repo must be owner/name, got "${repo}"`, next, EXIT.usage);
  return { owner: m[1]!, name: m[2]! };
}
