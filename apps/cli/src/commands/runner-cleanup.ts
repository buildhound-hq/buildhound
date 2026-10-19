import { Command } from "commander";
import { EXIT, type MachineCleanup, type MachineCleanupResponse, type MachineStorage, type RequestCleanupResponse } from "@buildhound/shared";
import { readAgentConfig } from "../lib/agent-home";
import { ApiClient } from "../lib/api";
import { gb } from "../lib/doctor/context";
import { CliError, emit } from "../output";
import { ago, color, done, next, table } from "../lib/style";
import { machinesOf } from "./cache";

// Clear Buildhound's leftovers on one machine (RUNNERS.md, Disk space): images superseded by a newer one, the macOS
// image build's cache and package caches over their limits. Without --yes it only reads what the machine's last
// heartbeat reported; with --yes it asks the machine through the control plane, which clears on its next heartbeat.

export interface RunnerCleanupOptions {
  machine?: string | undefined;
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export interface RunnerCleanupPreview {
  status: "preview";
  owner: string;
  machine: { id: string; name: string };
  /** When the machine last checked in; null before its first heartbeat. */
  reported_at: string | null;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  /** What Buildhound keeps there and what clearing frees; null when its agent does not report it. */
  storage: MachineStorage | null;
  /** All kinds together: what clearing frees now. */
  reclaimable_bytes: number | null;
  /** The last cleanup asked of the machine. */
  cleanup: MachineCleanup | null;
  next: string;
}

export interface RunnerCleanupRequested {
  status: "requested";
  owner: string;
  machine: { id: string; name: string };
  requested_at: string;
  reclaimable_bytes: number | null;
  next: string;
}

export type RunnerCleanupResult = RunnerCleanupPreview | RunnerCleanupRequested;

const enc = encodeURIComponent;
const USAGE = "buildhound runner cleanup --machine <id|name> --org <login> [--yes]";

export async function runRunnerCleanup(opts: RunnerCleanupOptions): Promise<RunnerCleanupResult> {
  const owner = opts.org ?? readAgentConfig()?.owner;
  if (!opts.machine) throw new CliError("USAGE", "--machine is required: the machine to clear Buildhound's leftovers on", owner ? `buildhound runner status --org ${owner}` : USAGE, EXIT.usage);
  if (!owner) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user that owns the machine", USAGE, EXIT.usage);
  const base = `buildhound runner cleanup --org ${owner} --machine ${opts.machine}`;
  const api = ApiClient.forCommand(opts, opts.yes ? `${base} --yes` : base);
  const [m] = await machinesOf(api, owner, opts.machine, base);
  if (!m) throw new CliError("NOT_FOUND", `no machine named ${opts.machine} in ${owner}`, `buildhound runner status --org ${owner}`, EXIT.usage);
  if (opts.yes) {
    const r = await api.expect<RequestCleanupResponse>("POST", `/v1/machines/${enc(m.id)}/cleanup`, undefined, `${base} --yes`);
    return { status: "requested", owner, machine: r.machine, requested_at: r.requested_at, reclaimable_bytes: r.reclaimable_bytes, next: `buildhound runner cleanup --org ${owner} --machine ${r.machine.name}` };
  }
  const p = await api.expect<MachineCleanupResponse>("GET", `/v1/machines/${enc(m.id)}/cleanup`, undefined, base);
  const reclaimable = p.storage ? p.storage.reclaimable.old_images + p.storage.reclaimable.build_cache + p.storage.reclaimable.package_cache : null;
  return {
    status: "preview",
    owner,
    machine: p.machine,
    reported_at: p.reported_at,
    disk_free_bytes: p.disk_free_bytes,
    disk_total_bytes: p.disk_total_bytes,
    storage: p.storage,
    reclaimable_bytes: reclaimable,
    cleanup: p.cleanup,
    // Nothing to free sends the person to their own files; an agent that reports nothing, to an update.
    next: p.storage && reclaimable === 0 ? `buildhound runner status --org ${owner}` : p.next,
  };
}

const size = (bytes: number): string => (bytes > 0 && bytes < 2 ** 20 ? "under 1 MB" : gb(bytes));

/** The last cleanup in words: "Freed 31 GB 2 min ago", "Requested 1 min ago, waiting for the machine". */
function lastCleanup(c: MachineCleanup | null): string | null {
  if (!c) return null;
  if (c.status === "done") return `Last cleanup freed ${size(c.bytes_freed ?? 0)} ${ago(c.finished_at)}.`;
  if (c.status === "requested") return `Cleanup requested ${ago(c.requested_at)}. The machine clears on its next check-in, within 30 seconds.`;
  return `Cleanup requested ${ago(c.requested_at)} was not picked up: the machine was offline for an hour.`;
}

export function prettyRunnerCleanup(r: RunnerCleanupResult): string {
  if (r.status === "requested") {
    const frees = r.reclaimable_bytes ? ` (about ${size(r.reclaimable_bytes)})` : "";
    return [done(`Cleanup requested on ${r.machine.name}${frees}`), color.dim("  It clears on its next check-in, within 30 seconds, and never removes the image in use or anything a running job uses."), "", next(r.next)].join("\n");
  }
  const out: string[] = [];
  const disk = r.disk_free_bytes !== null ? `${size(r.disk_free_bytes)} free${r.disk_total_bytes ? ` of ${size(r.disk_total_bytes)}` : ""}` : "";
  out.push([`Buildhound on ${r.machine.name}`, disk, r.reported_at ? color.dim(`reported ${ago(r.reported_at)}`) : ""].filter(Boolean).join("  "));
  if (!r.storage) {
    out.push(color.dim("  No sizes reported yet. They come with the next Buildhound agent."));
  } else {
    const s = r.storage;
    const frees = (n: number) => (n > 0 ? size(n) : "-");
    out.push(
      "",
      ...table(
        ["KIND", "SIZE", "FREES"],
        [
          ["Image in use", size(s.used.images), "-"],
          ["Old images", size(s.used.old_images), frees(s.reclaimable.old_images)],
          ["Image build cache", size(s.used.build_cache), frees(s.reclaimable.build_cache)],
          ["Package caches", size(s.used.package_cache), frees(s.reclaimable.package_cache)],
        ],
        { right: [1, 2] },
      ),
      "",
      r.reclaimable_bytes ? `Clearing Buildhound's leftovers frees about ${size(r.reclaimable_bytes)}.` : "Nothing of Buildhound's to clear. The rest is your own files.",
    );
  }
  const last = lastCleanup(r.cleanup);
  if (last) out.push(color.dim(last));
  return [...out, "", next(r.next)].join("\n");
}

export function runnerCleanupCommand(): Command {
  return new Command("cleanup")
    .description("Clear Buildhound's leftovers on a machine: old images, the image build cache and package caches over their limits")
    .option("--machine <id|name>", "machine id or name")
    .option("--org <login>", "GitHub organisation or user that owns the machine; default this machine's")
    .option("--yes", "clear them; without it, only show what would be freed")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RunnerCleanupOptions) => {
      emit(await runRunnerCleanup(opts), opts, prettyRunnerCleanup);
    });
}
