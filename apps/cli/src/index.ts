#!/usr/bin/env node
import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { doctorCommand } from "./commands/doctor";
import { estimateCommand } from "./commands/estimate";
import { failoverCommand } from "./commands/failover";
import { imageCommand } from "./commands/image";
import { auditCommand, planCommand, reposCommand, settingsCommand } from "./commands/account";
import { billingCommand } from "./commands/billing";
import { cacheCommand } from "./commands/cache";
import { jobCommand, jobsCommand, overviewCommand, savingsCommand } from "./commands/jobs";
import { ratesCommand } from "./commands/rates";
import { routeCommand } from "./commands/route";
import { runnerAddCommand } from "./commands/runner-add";
import { runnerRemoveCommand } from "./commands/runner-remove";
import { runnerSetCommand } from "./commands/runner-set";
import { runnerStatusCommand } from "./commands/runner-status";
import { scanCommand } from "./commands/scan";
import { setupCommand } from "./commands/setup";
import { CliError, fail, wantsJsonError } from "./output";
import pkg from "../package.json" with { type: "json" };

// In a terminal, fail() prints the usage error itself, so commander's own "error:" line would say it twice.
const output = { writeErr: (s: string) => process.stderr.write(s), outputError: (s: string, write: (s: string) => void) => (wantsJsonError() ? write(s) : undefined) };

const program = new Command("buildhound")
  .description("Your own computer runs your CI, and your coding agent set it up.")
  .version(pkg.version)
  .configureOutput(output)
  .exitOverride();

const runner = new Command("runner").description("Connect, inspect and remove machines that run your CI");
for (const sub of [runnerAddCommand(), runnerStatusCommand(), runnerRemoveCommand(), runnerSetCommand()]) runner.addCommand(sub);

// Subcommands do not inherit exitOverride or output settings from addCommand, so set them on every level:
// every usage error has to reach the JSON envelope below instead of commander's process.exit.
function agentFirst(cmd: Command): Command {
  cmd.configureOutput(output).exitOverride();
  for (const sub of cmd.commands) agentFirst(sub);
  return cmd;
}
for (const cmd of [scanCommand(), estimateCommand(), routeCommand(), ratesCommand(), runner, failoverCommand(), overviewCommand(), jobsCommand(), jobCommand(), savingsCommand(), reposCommand(), planCommand(), billingCommand(), auditCommand(), settingsCommand(), setupCommand(), doctorCommand(), imageCommand(), cacheCommand()]) program.addCommand(agentFirst(cmd));

// `pnpm cli -- scan .` forwards the literal `--`; drop it when it is the first argument.
const argv = process.argv[2] === "--" ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;

try {
  await program.parseAsync(argv);
} catch (err) {
  const e = err as { code?: string; message?: string };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") process.exit(0);
  if (typeof e.code === "string" && e.code.startsWith("commander.")) {
    const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
    const message = e.code === "commander.help" ? `a subcommand is required; see buildhound ${command ? `${command} ` : ""}--help` : e.message?.replace(/^error:\s*/i, "").trim() || "invalid usage";
    fail(new CliError("USAGE", message, command ? `buildhound ${command} --help` : "buildhound scan . --json", EXIT.usage));
  }
  fail(err);
}
