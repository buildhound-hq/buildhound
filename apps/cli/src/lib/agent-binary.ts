import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, renameSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import { agentBinDir, installedAgentPath } from "./agent-home";
import { runQuiet, which } from "./exec";

export interface AgentSource {
  path: string;
  origin: "flag" | "installed" | "path" | "checkout" | "download";
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Present only in a repository checkout after `go build` in apps/agent; never shipped with the npm package. */
const checkoutBinary = path.resolve(here, "..", "..", "..", "agent", "bin", "buildhound-agent");

/**
 * Where the agent binary comes from, in order: --agent-binary, an earlier install under ~/.buildhound/bin,
 * a buildhound-agent on PATH, this repository's build, else a download: from BUILDHOUND_RELEASE_URL when set,
 * else the version dl.buildhound.sh names as latest.
 */
export async function locateAgentBinary(explicit: string | undefined, host: { os: string; arch: string }, next: string): Promise<AgentSource> {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!existsSync(p)) throw new CliError("AGENT_BINARY_NOT_FOUND", `--agent-binary ${explicit} does not exist`, next, EXIT.usage);
    return { path: p, origin: "flag" };
  }
  if (existsSync(installedAgentPath())) return { path: installedAgentPath(), origin: "installed" };
  const onPath = which("buildhound-agent");
  if (onPath) return { path: onPath, origin: "path" };
  if (existsSync(checkoutBinary)) return { path: checkoutBinary, origin: "checkout" };
  return { path: await downloadAgent(host, next), origin: "download" };
}

/** Where releases are published (.github/workflows/release.yml); `agent/latest` names the current version. */
export const DOWNLOADS_URL = "https://dl.buildhound.sh";

/** Download the agent from BUILDHOUND_RELEASE_URL when set, else the latest release. Returns the verified file. */
export async function downloadAgent(host: { os: string; arch: string }, next: string): Promise<string> {
  const base = process.env.BUILDHOUND_RELEASE_URL || (await latestRelease(next));
  return download(base.replace(/\/+$/, ""), host, next);
}

async function latestRelease(next: string): Promise<string> {
  const downloads = (process.env.BUILDHOUND_DOWNLOADS_URL || DOWNLOADS_URL).replace(/\/+$/, "");
  const url = `${downloads}/agent/latest`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const version = (await res.text()).trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version.slice(0, 40)}" is not a version`);
    return `${downloads}/agent/v${version}`;
  } catch (e) {
    throw new CliError("AGENT_DOWNLOAD_FAILED", `could not read ${url}: ${e instanceof Error ? e.message : String(e)}`, `${next} --agent-binary <path to buildhound-agent>`, EXIT.network);
  }
}

/** Download `buildhound-agent-<os>-<arch>` and verify it against the `.sha256` beside it before trusting it. */
async function download(base: string, host: { os: string; arch: string }, next: string): Promise<string> {
  // Release assets are named by Go's GOOS and GOARCH: darwin-arm64, linux-amd64, linux-arm64.
  const goos = host.os === "macos" ? "darwin" : host.os;
  const goarch = host.arch === "x64" ? "amd64" : host.arch;
  const name = `buildhound-agent-${goos}-${goarch}`;
  const url = `${base}/${name}`;
  let bin: ArrayBuffer;
  let sum: string;
  try {
    const [b, s] = await Promise.all([fetch(url), fetch(`${url}.sha256`)]);
    if (!b.ok || !s.ok) throw new Error(`HTTP ${b.ok ? s.status : b.status}`);
    bin = await b.arrayBuffer();
    sum = (await s.text()).trim().split(/\s+/)[0] ?? "";
  } catch (e) {
    throw new CliError("AGENT_DOWNLOAD_FAILED", `could not download ${url}: ${e instanceof Error ? e.message : String(e)}`, `${next} --agent-binary <path to buildhound-agent>`, EXIT.network);
  }
  const actual = createHash("sha256").update(Buffer.from(bin)).digest("hex");
  if (!sum || actual !== sum.toLowerCase()) {
    throw new CliError("AGENT_CHECKSUM_MISMATCH", `${name}: sha256 ${actual} does not match ${url}.sha256`, `${next} --agent-binary <path to buildhound-agent>`, EXIT.network);
  }
  mkdirSync(agentBinDir(), { recursive: true, mode: 0o700 });
  const target = path.join(agentBinDir(), `${name}.download`);
  writeFileSync(target, Buffer.from(bin), { mode: 0o755 });
  return target;
}

/** Copy the located binary to ~/.buildhound/bin/buildhound-agent. Returns false when it was already there unchanged. */
export function installAgentBinary(source: AgentSource): { path: string; changed: boolean } {
  const target = installedAgentPath();
  if (source.path === target) return { path: target, changed: false };
  mkdirSync(agentBinDir(), { recursive: true, mode: 0o700 });
  if (existsSync(target) && sameFile(source.path, target)) return { path: target, changed: false };
  // Copy beside the target and rename over it: macOS caches a binary's code signature by file, and
  // overwriting a signed binary in place gets the next launch killed with OS_REASON_CODESIGNING.
  const temp = `${target}.new-${process.pid}`;
  copyFileSync(source.path, temp);
  chmodSync(temp, 0o755);
  renameSync(temp, target);
  return { path: target, changed: true };
}

function sameFile(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return createHash("sha256").update(readFileSync(a)).digest("hex") === createHash("sha256").update(readFileSync(b)).digest("hex");
}

/** The version the binary reports (`buildhound-agent --json` prints `{ version }`), or "unknown". Never throws. */
export function agentVersion(binary: string): string {
  const out = runQuiet(binary, ["--json"]);
  if (!out) return "unknown";
  try {
    const v = (JSON.parse(out) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}
