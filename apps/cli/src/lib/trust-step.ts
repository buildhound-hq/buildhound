import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { which } from "./exec";
import { createInterface } from "node:readline/promises";
import { color, done, failed } from "./style";

// The trust step (the canvas's D-TrustOnboard board, panel 3): `runner add` ends with it and `runner set --trusted on`
// uses it. Full-disk encryption is needed only for jobs that use secrets (SECURITY.md, Secrets), never to use
// Buildhound. At a terminal on a Mac with FileVault off, a person may turn it on here: `sudo fdesetup enable` runs in
// their own terminal with its input and output, so macOS asks for the password and prints the recovery key to them.
// Buildhound never reads, logs or stores either. Marking a machine Trusted stays a person's step (CLAUDE.md rule 19):
// a coding agent gets `needs_human` with the one dashboard URL and the commands for the person.

/** Why encryption is asked about, in one line, everywhere it is (CLI, MCP, doctor, API `next`). */
export const ENCRYPTION_WHY = "Only needed for jobs that use secrets: deploys, signing, publishing. Without it, those jobs stay on GitHub-hosted.";
/** Said once, before `fdesetup enable` runs. */
export const RECOVERY_KEY_WARNING = "Save the recovery key it prints somewhere safe: without it and your password, this disk cannot be unlocked.";
/** LUKS cannot be turned on in place safely, so on Linux the CLI only points here. */
export const LUKS_DOCS = "https://buildhound.sh/docs/security#trust";

export type HostOs = "macos" | "linux" | (string & {});
export type BlockedBy = "filevault_off" | "disk_encryption_off";

export interface TrustNeedsHuman {
  status: "needs_human";
  reason: "trust_needs_person";
  url: string;
  blocked_by?: BlockedBy;
  next: string;
}

/**
 * The dashboard's root for an API URL: `--api-url https://api.example.com` has its dashboard at app.example.com, a
 * local control plane at localhost:3000; BUILDHOUND_APP_URL wins.
 */
export function appUrl(apiUrl: string): string {
  const set = process.env.BUILDHOUND_APP_URL;
  if (set) return set.replace(/\/+$/, "");
  try {
    const u = new URL(apiUrl);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return "http://localhost:3000";
    if (u.hostname.startsWith("api.")) return `${u.protocol}//app.${u.hostname.slice(4)}`;
  } catch {
    // Not a URL: the production dashboard.
  }
  return "https://app.buildhound.sh";
}

export const trustCommand = (machine: string, owner: string) => `buildhound runner set --machine ${machine} --org ${owner} --trusted on`;

/** The answer for a coding agent (or a terminal where the person said no): only a person trusts a machine. */
export function trustNeedsHuman(ctx: { owner: string; machine: string; os: HostOs; encrypted: boolean | null; apiUrl: string }): TrustNeedsHuman {
  const url = `${appUrl(ctx.apiUrl)}/${encodeURIComponent(ctx.owner)}/fleet/${encodeURIComponent(ctx.machine)}?trust=1`;
  const command = trustCommand(ctx.machine, ctx.owner);
  if (ctx.encrypted === false && ctx.os === "macos") {
    return {
      status: "needs_human",
      reason: "trust_needs_person",
      url,
      blocked_by: "filevault_off",
      next: `only jobs that use secrets need this: a person runs sudo fdesetup enable in a terminal on ${ctx.machine} and saves the recovery key it prints, then runs ${command} there, or opens the url`,
    };
  }
  if (ctx.encrypted === false) {
    return {
      status: "needs_human",
      reason: "trust_needs_person",
      url,
      blocked_by: "disk_encryption_off",
      next: `only jobs that use secrets need this: a Linux disk is encrypted with LUKS when it is installed (${LUKS_DOCS}); every other job runs on ${ctx.machine} without it`,
    };
  }
  return { status: "needs_human", reason: "trust_needs_person", url, next: `a person runs ${command} in a terminal, or opens the url` };
}

/** `fdesetup status` on a Mac: true for "FileVault is On." (also while it encrypts), false for Off, null when unreadable. */
export function parseFdesetupStatus(out: string | null): boolean | null {
  if (!out) return null;
  if (/FileVault is On/i.test(out)) return true;
  if (/FileVault is Off/i.test(out)) return false;
  return null;
}

/** `lsblk -s -rno TYPE <root device>`: the root file system's device and every device under it; LUKS shows as crypt. */
export function parseLsblkTypes(out: string | null): boolean | null {
  if (out === null) return null;
  return out.split(/\s+/).includes("crypt");
}

type Exec = (bin: string, args: string[]) => Promise<string | null>;

/** Reads a system tool's answer (fdesetup, findmnt, lsblk), found on PATH or in the system directories; null on failure. */
export const systemExec: Exec = (bin, args) => {
  const file = which(bin) ?? ["/usr/bin", "/usr/sbin", "/bin", "/sbin"].map((d) => path.join(d, bin)).find((f) => existsSync(f)) ?? null;
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      const out = typeof stdout === "string" ? stdout.trim() : "";
      resolve(err && !out ? null : out);
    });
  });
};

/**
 * Whether this machine's disk is encrypted: FileVault on a Mac, LUKS under the root file system on Linux; null when it
 * cannot be told. Reads only. BUILDHOUND_TEST_DISK_ENCRYPTED (on or off) stands in for it in tests.
 */
export async function readEncryption(os: HostOs, exec: Exec): Promise<boolean | null> {
  const forced = process.env.BUILDHOUND_TEST_DISK_ENCRYPTED;
  if (forced === "on" || forced === "off") return forced === "on";
  if (os === "macos") return parseFdesetupStatus(await exec("fdesetup", ["status"]));
  if (os === "linux") {
    const root = await exec("findmnt", ["-no", "SOURCE", "/"]);
    if (root) return parseLsblkTypes(await exec("lsblk", ["-s", "-rno", "TYPE", root.split("\n")[0]!.replace(/\[.*$/, "")]));
    // Without findmnt, any LUKS device at all is the best answer there is.
    const all = await exec("lsblk", ["-rno", "TYPE"]);
    return all === null ? null : parseLsblkTypes(all);
  }
  return null;
}

/** What the trust step needs from the world, so tests run it with no terminal, no sudo and no control plane. */
export interface TrustIO {
  /** A yes or no question; the default is No. */
  ask(question: string): Promise<boolean>;
  /** One line for the person (stderr). */
  say(line: string): void;
  /** Runs a command in the person's terminal with its input and output; resolves with its exit code. Nothing is captured. */
  runInteractive(file: string, args: string[]): Promise<number>;
  encryption(): Promise<boolean | null>;
  /** Waits for the control plane to report the disk encrypted from the Buildhound agent's heartbeat; false after a timeout. */
  waitForReport(): Promise<boolean>;
}

export interface TrustContext {
  owner: string;
  machine: string;
  os: HostOs;
}

const kind = (os: HostOs) => (os === "macos" ? "Mac" : "machine");

/**
 * Makes sure the disk is encrypted before a machine is trusted, offering FileVault at a terminal on a Mac. Says each
 * line itself. True once the disk is encrypted and the control plane has seen it; false when it stays off.
 */
export async function ensureEncryption(ctx: TrustContext, io: TrustIO, known?: boolean | null): Promise<boolean> {
  const encrypted = known === undefined ? await io.encryption() : known;
  if (encrypted !== false) return true;
  const command = trustCommand(ctx.machine, ctx.owner);
  if (ctx.os !== "macos") {
    io.say(`  Disk encryption is off on this ${kind(ctx.os)}.`);
    io.say(`  ${ENCRYPTION_WHY}`);
    io.say(`  A Linux disk is encrypted with LUKS when it is installed: ${LUKS_DOCS}`);
    return false;
  }
  io.say("  FileVault is off on this Mac.");
  io.say(`  ${ENCRYPTION_WHY}`);
  if (!(await io.ask("Turn on FileVault now? This runs sudo fdesetup enable in this terminal."))) {
    io.say(color.dim(`  Turn it on any time with sudo fdesetup enable, then run ${command}`));
    return false;
  }
  io.say(`  ${RECOVERY_KEY_WARNING}`);
  const code = await io.runInteractive("/usr/bin/sudo", ["/usr/bin/fdesetup", "enable"]);
  if (code !== 0 || (await io.encryption()) !== true) {
    io.say(failed("FileVault was not turned on."));
    io.say(color.dim(`  Try again with sudo fdesetup enable, or in System Settings, Privacy and Security, then run ${command}`));
    return false;
  }
  io.say(done("FileVault is on"));
  io.say(color.dim("  Waiting for the Buildhound agent to report it, within a minute"));
  if (!(await io.waitForReport())) {
    io.say(color.dim(`  Not reported yet. Once it is, run ${command}`));
    return false;
  }
  io.say(done("Buildhound sees FileVault on"));
  return true;
}

export type TrustOutcome = "trusted" | "declined" | "encryption_off";

/**
 * `runner add`'s last step at a terminal: encryption first, then "Run jobs with secrets on this Mac?" (default No), and on
 * yes the person-confirmed path of `runner set --trusted on` (`markTrusted`), where they type the machine's name.
 */
export async function interactiveTrust(ctx: TrustContext, io: TrustIO, markTrusted: () => Promise<void>): Promise<TrustOutcome> {
  io.say("");
  io.say("Jobs that use secrets");
  if (!(await ensureEncryption(ctx, io))) return "encryption_off";
  if (!(await io.ask(`Run jobs with secrets on this ${kind(ctx.os)}?`))) {
    io.say(color.dim(`  Mark it Trusted any time with ${trustCommand(ctx.machine, ctx.owner)}`));
    return "declined";
  }
  await markTrusted();
  return "trusted";
}

/** The real terminal: questions on stderr, `sudo fdesetup enable` with the person's own input and output. */
export function terminalIO(encryption: () => Promise<boolean | null>, waitForReport: () => Promise<boolean>): TrustIO {
  return {
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(`\n${question} [y/N] `)).trim().toLowerCase();
      rl.close();
      return answer === "y" || answer === "yes";
    },
    say: (line) => process.stderr.write(`${line}\n`),
    runInteractive: (file, args) =>
      new Promise((resolve) => {
        if (!existsSync(file)) return resolve(127);
        // Inherited input and output: the password prompt and the recovery key reach the person and nothing else.
        const child = spawn(file, args, { stdio: "inherit" });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      }),
    encryption,
    waitForReport,
  };
}

/** Polls `check` every `everyMs` until it answers true or `timeoutMs` passes. */
export async function pollUntil(check: () => Promise<boolean>, timeoutMs = 90_000, everyMs = 5_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  for (let waited = 0; ; waited += everyMs) {
    if (await check().catch(() => false)) return true;
    if (waited >= timeoutMs) return false;
    await sleep(everyMs);
  }
}
