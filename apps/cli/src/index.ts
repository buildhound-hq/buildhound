#!/usr/bin/env node
import { Command } from "commander";
import { ratesCommand } from "./commands/rates";
import { scanCommand } from "./commands/scan";
import { fail } from "./output";

const program = new Command("buildhound")
  .description("Your spare Mac mini runs your CI, and your agent set it up.")
  .version("0.0.1")
  .configureOutput({ writeErr: (s) => process.stderr.write(s) })
  .exitOverride();

program.addCommand(scanCommand());
program.addCommand(ratesCommand());

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const e = err as { code?: string; exitCode?: number; message?: string };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") process.exit(0);
  fail(err);
}
