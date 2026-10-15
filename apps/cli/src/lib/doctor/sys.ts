import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { arch, hostname, platform, totalmem } from "node:os";
import path from "node:path";
import { readLocalStatus } from "../../commands/runner-status";
import { which as whichOnPath } from "../exec";
import type { HttpResult, Sys } from "./types";

/** macOS and Linux keep these outside some users' PATH; doctor still finds them. Never docker, gh or other user tools. */
const SYSTEM_TOOLS = new Set(["pmset", "sysctl", "ioreg", "fdesetup", "ps", "xcrun", "lsblk", "vm_stat"]);
const SYSTEM_DIRS = ["/usr/bin", "/usr/sbin", "/bin", "/sbin"];

function which(bin: string): string | null {
  const found = whichOnPath(bin);
  if (found || !SYSTEM_TOOLS.has(bin)) return found;
  for (const dir of SYSTEM_DIRS) if (existsSync(path.join(dir, bin))) return path.join(dir, bin);
  return null;
}

function exec(bin: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  const file = which(bin);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
      // A non-zero exit with output still answers (fdesetup, pmset); a timeout or a missing binary does not.
      const out = typeof stdout === "string" ? stdout.trim() : "";
      if (err && ((err as { killed?: boolean }).killed || !out)) return resolve(null);
      resolve(out);
    });
  });
}

async function http(url: string, opts: { token?: string | undefined; timeoutMs?: number } = {}): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "buildhound-cli", "x-buildhound-source": process.env.BUILDHOUND_SOURCE === "mcp" ? "mcp" : "cli", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: true, status: res.status, body, text };
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = err.name === "TimeoutError" ? `no answer in ${Math.round((opts.timeoutMs ?? 5000) / 1000)} seconds` : err.cause?.code ?? err.cause?.message ?? err.message ?? String(e);
    return { ok: false, error: why };
  }
}

/** The real machine. Doctor only reads: no command here changes anything. */
export function realSys(): Sys {
  const p = platform();
  return {
    os: p === "darwin" ? "macos" : p === "linux" ? "linux" : "other",
    arch: arch(),
    nodeVersion: process.versions.node,
    memoryBytes: totalmem(),
    hostname: hostname().replace(/\.local$/, ""),
    now: () => Date.now(),
    env: (name) => process.env[name],
    which,
    exec,
    http,
    exists: (file) => existsSync(file),
    readText: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    listDir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    agentStatus: (socket) => readLocalStatus(socket),
    diskFree: async (dir) => {
      try {
        const s = await statfs(dir);
        return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
      } catch {
        return null;
      }
    },
  };
}
