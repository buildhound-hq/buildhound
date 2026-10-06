import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import { runQuiet, which } from "./exec";

/**
 * Token for --repo: --token, then GITHUB_TOKEN, then `gh auth token` when the gh CLI is on PATH.
 * Throws TOKEN_REQUIRED (exit 3) with the exact next command when none is found.
 */
export function resolveToken(explicit: string | undefined, nextCommand: string, purpose = "--repo needs a GitHub token to read run history and workflow files"): string {
  if (explicit) return explicit;
  const env = process.env.GITHUB_TOKEN;
  if (env) return env;
  const gh = which("gh");
  if (gh) {
    const out = runQuiet(gh, ["auth", "token"]);
    if (out) return out;
  }
  throw new CliError("TOKEN_REQUIRED", purpose, `${nextCommand} --token $(gh auth token)`, EXIT.auth);
}
