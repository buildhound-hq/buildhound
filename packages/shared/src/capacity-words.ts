import { familyName } from "./why-hosted";
import type { CapacityLine } from "./capacity";

/* The sentences of the capacity line and the machine page (THROUGHPUT.md, built 2026-10-19), shared so every surface says the same. */

/** A label short of capacity: its jobs waited longer than this in the week because every slot was full. */
export const CAPACITY_SHORT_SECONDS = 10 * 60;

/** "38 min", "1 h 10 min", "45 s": a wait as the capacity line says it. */
export function waitWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const small = (n: number): string => SMALL[n] ?? String(n);

/** "one slot on Benys-Mac-mini", "three slots on Benys-Mac-mini", "four slots on mini and book", "12 slots on 5 machines". */
export function slotsWords(c: Pick<CapacityLine, "slots" | "machines">): string {
  const slots = `${small(c.slots)} slot${c.slots === 1 ? "" : "s"}`;
  const names = c.machines.map((m) => m.name);
  if (names.length === 0) return slots;
  if (names.length === 1) return `${slots} on ${names[0]}`;
  if (names.length === 2) return `${slots} on ${names[0]} and ${names[1]}`;
  return `${slots} on ${names.length} machines`;
}

/** The capacity line's sentence: "macOS jobs waited 38 min this week for one slot on Benys-Mac-mini". */
export function capacitySentence(c: CapacityLine): string {
  return `${familyName(c.label)} jobs waited ${waitWords(c.wait_seconds_from_saturation)} this week for ${slotsWords(c)}`;
}

/** Whether a label's wait from full slots makes it short of capacity. */
export function capacityShort(c: Pick<CapacityLine, "wait_seconds_from_saturation">): boolean {
  return c.wait_seconds_from_saturation > CAPACITY_SHORT_SECONDS;
}

/** The fix for a label short of capacity: fallback on when it is off, else another machine for the label. */
export function capacityNext(c: Pick<CapacityLine, "label">, owner: string, fallbackOff: boolean): string {
  return fallbackOff ? `buildhound failover --org ${owner} --label ${c.label} --fallback on` : `buildhound runner add --org ${owner} --label ${familyName(c.label).toLowerCase().replace(/ /g, "-")} --yes`;
}

/** Why the label is short, in one sentence: the fallback off, or how many jobs were asked for at once. */
export function capacityWhy(c: Pick<CapacityLine, "peak_demand">, fallbackOff: boolean): string {
  return fallbackOff ? "Fall back to GitHub-hosted is off, so jobs wait for a slot instead of running there." : `Up to ${c.peak_demand} jobs were queued or running at once.`;
}

/** What the fix means in the dashboard's words. */
export function capacityFixWords(c: Pick<CapacityLine, "label">, fallbackOff: boolean): string {
  return fallbackOff
    ? `Turn on Fall back to GitHub-hosted for ${familyName(c.label)} and jobs run there while every slot is busy, or connect another machine that runs ${familyName(c.label)} jobs.`
    : `Connect another machine that runs ${familyName(c.label)} jobs, or give one more memory; new jobs route to GitHub-hosted meanwhile.`;
}

/**
 * "Runs 1 macOS and 3 Linux jobs at once", from a machine's label slots (each label's capacity from its last
 * heartbeat). The Linux families share one guest, so Linux is named once with the most any of them offers; trusted
 * twins and exclusive labels are their family's. Null when the machine reports no slots yet.
 */
export function runsAtOnce(slots: Record<string, { capacity: number }>): string | null {
  const byKind = new Map<string, number>();
  for (const [label, s] of Object.entries(slots)) {
    const n = Number(s?.capacity ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const kind = label.startsWith("buildhound-macos") ? "macOS" : label.startsWith("buildhound-linux") ? "Linux" : familyName(label);
    byKind.set(kind, Math.max(byKind.get(kind) ?? 0, n));
  }
  if (byKind.size === 0) return null;
  const rank = (k: string) => (k === "macOS" ? 0 : k === "Linux" ? 1 : 2);
  const parts = [...byKind.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([k, n]) => `${n} ${k}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  const total = [...byKind.values()].reduce((a, b) => a + b, 0);
  return `Runs ${list} job${total === 1 ? "" : "s"} at once`;
}
