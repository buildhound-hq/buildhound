import { Command } from "commander";
import { RULES } from "@buildhound/core";
import { CliError, emit } from "../output";

export function scanCommand(): Command {
  return new Command("scan")
    .description("Audit workflow files for wasted CI spend")
    .argument("[path]", "directory containing .github/workflows", ".")
    .option("--repo <owner/name>", "run dynamic rules against GitHub run history")
    .option("--token <token>", "GitHub token for --repo; or set GITHUB_TOKEN")
    .option("--json", "JSON output")
    .action((path: string, opts: { repo?: string; token?: string; json?: boolean }) => {
      if (opts.repo && !opts.token && !process.env.GITHUB_TOKEN) {
        throw new CliError("TOKEN_REQUIRED", "--repo needs a GitHub token to read run history", `buildhound scan ${path} --repo ${opts.repo} --token $(gh auth token)`, 3);
      }
      // M0 placeholder: the rule engine arrives in M1. The shape of the output is final.
      emit({ path, repo: opts.repo ?? null, rules: RULES.map((r) => r.id), findings: [], totals: { minutes_per_month: 0, cents_per_month: 0 }, next: "buildhound rates" }, opts);
    });
}
