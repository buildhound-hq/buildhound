#!/usr/bin/env node
import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { estimateCommand } from "./commands/estimate";
import { ratesCommand } from "./commands/rates";
import { routeCommand } from "./commands/route";
import { scanCommand } from "./commands/scan";
import { CliError, fail } from "./output";

const program = new Command("buildhound")
  .description("Your spare Mac mini runs your CI, and your agent set it up.")
  .version("0.0.1")
  .configureOutput({ writeErr: (s) => process.stderr.write(s) })
  .exitOverride();

for (const cmd of [scanCommand(), estimateCommand(), routeCommand(), ratesCommand()]) {
  // Subcommands do not inherit exitOverride or output settings from addCommand, so set them here:
  // every usage error has to reach the JSON envelope below instead of commander's process.exit.
  cmd.configureOutput({ writeErr: (s) => process.stderr.write(s) }).exitOverride();
  program.addCommand(cmd);
}

// `pnpm cli -- scan .` forwards the literal `--`; drop it when it is the first argument.
const argv = process.argv[2] === "--" ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;

try {
  await program.parseAsync(argv);
} catch (err) {
  const e = err as { code?: string; message?: string };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") process.exit(0);
  if (typeof e.code === "string" && e.code.startsWith("commander.")) {
    const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
    fail(new CliError("USAGE", e.message?.replace(/^error:\s*/i, "").trim() || "invalid usage", command ? `buildhound ${command} --help` : "buildhound scan . --json", EXIT.usage));
  }
  fail(err);
}
