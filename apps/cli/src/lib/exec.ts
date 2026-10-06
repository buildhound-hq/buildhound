import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Absolute path of a binary on PATH, or null. We never spawn a tool we have not found first. */
export function which(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run a binary found with `which` and return trimmed stdout, or null on any failure. Never throws. */
export function runQuiet(bin: string, args: string[], cwd?: string): string | null {
  try {
    const out = execFileSync(bin, args, { cwd: cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    return out.trim();
  } catch {
    return null;
  }
}
