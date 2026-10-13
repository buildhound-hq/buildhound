import { createInterface } from "node:readline/promises";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";

/**
 * Destructive-class commands need --yes without a TTY (AGENT_FIRST.md rule 2). With a TTY and no --yes, ask once.
 * `command` is the full command the agent should rerun with --yes.
 */
export async function confirm(yes: boolean | undefined, question: string, command: string): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("CONFIRM_REQUIRED", `${question} Pass --yes to confirm.`, `${command} --yes`, EXIT.usage);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") throw new CliError("CANCELLED", "cancelled", `${command} --yes`, EXIT.usage);
}

/**
 * Changes only a person may make (CLAUDE.md rule 19; SECURITY.md, Consent): the person types `expected`
 * in a terminal. Without one, returns false so the caller can answer `needs_human`; --yes does not count.
 */
export async function confirmPerson(question: string, expected: string, command: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${question}\nType ${expected} to confirm: `)).trim();
  rl.close();
  if (answer !== expected) throw new CliError("CANCELLED", "cancelled: the name did not match", command, EXIT.usage);
  return true;
}
