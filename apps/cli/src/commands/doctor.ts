import { Command } from "commander";
import { EXIT } from "@buildhound/shared";
import { CHECKS } from "../lib/doctor/checks";
import { Doctor } from "../lib/doctor/context";
import { realSys } from "../lib/doctor/sys";
import type { Check, DoctorOptions, DoctorResult, Sys } from "../lib/doctor/types";
import { emit, wantsJson } from "../output";
import { color, SYMBOLS } from "../lib/style";

export type { Check, DoctorOptions, DoctorResult } from "../lib/doctor/types";

/** A check that has not answered by then is reported, not waited for: doctor finishes in seconds. */
const CHECK_TIMEOUT_MS = 15_000;

function withTimeout(id: string, title: string, run: Promise<Check>, ms: number): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Check>((resolve) => {
    timer = setTimeout(() => resolve({ id, status: "warn", title: `${title}: no answer in ${Math.round(ms / 1000)} seconds`, fix: "Run npx buildhound doctor again" }), ms);
  });
  const settled = run.catch((e: unknown): Check => ({ id, status: "warn", title: `${title}: could not be checked`, detail: e instanceof Error ? e.message : String(e), fix: "Run npx buildhound doctor again" }));
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}

/**
 * Every check at once, read-only: this machine, the Buildhound agent on it, the account and the network
 * (B06.3, B06.4 part 2). Fails only by reporting; the exit code says whether anything failed.
 */
export async function runDoctor(opts: DoctorOptions = {}, sys: Sys = realSys(), timeoutMs = CHECK_TIMEOUT_MS): Promise<DoctorResult> {
  const d = new Doctor(sys, opts);
  const checks = await Promise.all(CHECKS.map((c) => withTimeout(c.id, c.title, c.run(d), timeoutMs)));
  // Every check has settled, so the owner is known by now unless GitHub never answered.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owner = await Promise.race([d.owner().catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), 2000)))]).finally(() => clearTimeout(timer));
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  // A concrete fix (stop the simulators, free the disk) comes before the general memory advice, and a power
  // warning, which is the machine working as set, comes last.
  const later = ["memory", "power"];
  const warns = checks.filter((c) => c.status === "warn" && c.fix).sort((a, b) => later.indexOf(a.id) - later.indexOf(b.id));
  const first = checks.find((c) => c.status === "fail" && c.fix) ?? warns[0] ?? checks.find((c) => c.status === "skip" && c.fix);
  const next = first?.fix ?? (owner ? `buildhound runner status --org ${owner}` : "buildhound runner status --local");
  return { ok: summary.fail === 0, owner, machine: sys.hostname, checks, summary, next };
}

const SYMBOL: Record<Check["status"], () => string> = {
  ok: () => color.green(SYMBOLS.done),
  warn: () => color.yellow(SYMBOLS.needed),
  fail: () => color.red(SYMBOLS.failed),
  skip: () => color.dim(SYMBOLS.skipped),
};

/** One line per check, `Fix:` under each one to act on, a summary last (docs/CLI_AND_MCP.md, Output for people). */
export function prettyDoctor(r: DoctorResult): string {
  const lines = [`Checking ${r.machine}${r.owner ? ` for ${r.owner}` : ""}`, ""];
  for (const c of r.checks) {
    lines.push(`${SYMBOL[c.status]()} ${c.status === "skip" ? color.dim(c.title) : c.title}`);
    if (c.fix && c.status !== "ok") lines.push(`  Fix: ${c.fix}`);
  }
  const s = r.summary;
  const parts = [`${s.ok} ok`, s.warn && `${s.warn} to look at`, s.fail && `${s.fail} failed`, s.skip && `${s.skip} skipped`].filter(Boolean);
  lines.push("", s.fail ? `${parts.join(", ")}` : s.warn ? `Nothing failed. ${parts.join(", ")}` : `All good. ${parts.join(", ")}`);
  return lines.join("\n");
}

/** In a terminal, a spinner on stderr while the checks run, so it never looks frozen; nothing for agents. */
function spinner(opts: { json?: boolean | undefined }): () => void {
  if (wantsJson(opts) || !process.stderr.isTTY) return () => undefined;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const draw = () => process.stderr.write(`\r${color.yellow(frames[i++ % frames.length]!)} Checking this machine`);
  draw();
  const t = setInterval(draw, 80);
  return () => {
    clearInterval(t);
    process.stderr.write("\r\x1b[K");
  };
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check this machine, the Buildhound agent, the account and the network, and say what to fix; read-only")
    .option("--org <login>", "GitHub organisation or user; default the account this machine is connected to, else the signed-in user")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: DoctorOptions & { json?: boolean }) => {
      const stop = spinner(opts);
      let result: DoctorResult;
      try {
        result = await runDoctor(opts);
      } finally {
        stop();
      }
      emit(result, opts, prettyDoctor);
      if (!result.ok) process.exitCode = EXIT.findings;
    });
}
