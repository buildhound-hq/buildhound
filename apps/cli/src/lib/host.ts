import { arch as nodeArch, availableParallelism, hostname, platform, totalmem } from "node:os";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";

export interface HostInfo {
  os: "macos" | "linux";
  arch: "arm64" | "x64";
  cpu_cores: number;
  memory_gb: number;
  hostname: string;
}

/** What POST /v1/machines needs about this host, from node:os. Windows hosts are not supported. */
export function detectHost(next: string): HostInfo {
  const p = platform();
  const os = p === "darwin" ? "macos" : p === "linux" ? "linux" : null;
  if (!os) throw new CliError("UNSUPPORTED_OS", `Buildhound runs on macOS and Linux hosts, not ${p}`, next, EXIT.usage);
  const a = nodeArch();
  const arch = a === "arm64" ? "arm64" : a === "x64" ? "x64" : null;
  if (!arch) throw new CliError("UNSUPPORTED_ARCH", `Buildhound supports arm64 and x64 hosts, not ${a}`, next, EXIT.usage);
  return { os, arch, cpu_cores: availableParallelism(), memory_gb: Math.round(totalmem() / 2 ** 30), hostname: hostname().replace(/\.local$/, "") };
}

export type LabelFamily = "buildhound-macos" | "buildhound-linux" | "buildhound-linux-x64";

/** `--label macos|linux` to the label family in CONTROL_PLANE_API.md. macOS guests need a Mac host. */
export function labelFor(label: string | undefined, host: HostInfo, next: string): LabelFamily {
  if (label === "macos") {
    if (host.os !== "macos") throw new CliError("USAGE", "--label macos needs a Mac host; this machine runs Linux", next.replace("--label macos", "--label linux"), EXIT.usage);
    return "buildhound-macos";
  }
  if (label === "linux") return host.arch === "x64" ? "buildhound-linux-x64" : "buildhound-linux";
  throw new CliError("USAGE", `--label must be macos or linux, got "${label ?? ""}"`, next, EXIT.usage);
}
