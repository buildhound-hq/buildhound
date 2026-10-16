// After `runner add` on a Mac (B06.2, onboarding): Linux jobs run within minutes, and the macOS image follows once
// it is built on this Mac. A person at a terminal is offered the build right away; a coding agent gets it as `next`.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { agentHome, agentSocketPath } from "./agent-home";
import { CliError, wantsJson } from "../output";
import { color, failed, next as nextLine } from "./style";

export const IMAGE_BUILD = "buildhound image build --yes";

export interface MacImageState {
  status: "missing" | "ready";
  next?: string;
  note?: string;
}

/** Whether this Mac serves macOS jobs and still needs its image; null when it does not serve them. */
export function macImageState(r: { os: string; arch: string; scale_sets: Array<{ label: string }> }, home = agentHome()): MacImageState | null {
  if (r.os !== "macos" || r.arch !== "arm64" || !r.scale_sets.some((s) => s.label === "buildhound-macos")) return null;
  if (existsSync(path.join(home, "images", "macos-arm64", "current", "manifest.json"))) return { status: "ready" };
  return { status: "missing", next: IMAGE_BUILD, note: "Linux jobs run on this Mac now; macOS jobs run on GitHub-hosted until the macOS image is built on it (about 30 to 45 minutes, one password step)" };
}

/** `runner add`'s result with the image build as next when this Mac still needs its macOS image; the route step follows as `then`. */
export function withMacImage<T extends { status: string; os: string; arch: string; scale_sets: Array<{ label: string }>; next: string }>(r: T): T & { macos_image?: MacImageState; then?: string } {
  const image = macImageState(r);
  if (!image) return r;
  if (image.status === "ready") return { ...r, macos_image: image };
  return { ...r, macos_image: image, next: IMAGE_BUILD, then: r.next };
}

/** At a terminal, offer the build right after connecting; it runs live in this terminal and continues in the background if stopped. */
export async function offerMacImage(r: { status: string; macos_image?: MacImageState; then?: string }, opts: { json?: boolean | undefined }, build: () => Promise<void>): Promise<void> {
  if (r.status !== "ready" || r.macos_image?.status !== "missing" || wantsJson(opts) || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`\nBuild the macOS image now? Linux jobs already run here; macOS jobs switch over when it is ready (about 30 to 45 minutes, your password once). [Y/n] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "" && answer !== "y" && answer !== "yes") {
    process.stderr.write(`${color.dim("Build it any time with: buildhound image build")}\n`);
    return;
  }
  // The Buildhound agent was just (re)started: give it a moment to open its socket.
  for (let i = 0; i < 30 && !existsSync(agentSocketPath()); i++) await new Promise((res) => setTimeout(res, 500));
  try {
    await build();
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    process.stderr.write([failed(e.message), "", nextLine(e.next)].join("\n") + "\n");
  }
}
