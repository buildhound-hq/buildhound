// Output for people, the GitHub CLI's way (docs/CLI_AND_MCP.md, Output for people): uppercase headers with
// two-space gaps, a symbol column for results, relative times, colour only on symbols and dimmed text, and
// the next command last. Agents never see this: without a TTY or with --json every command prints JSON.

// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Colour only in a terminal, and never with NO_COLOR or TERM=dumb. Read at call time so tests can flip it. */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

const paint = (open: number, close: number) => (s: string) => (colorEnabled() && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const color = {
  green: paint(32, 39),
  red: paint(31, 39),
  yellow: paint(33, 39),
  dim: paint(2, 22),
  bold: paint(1, 22),
};

/** Visible width: escape codes take no columns. */
export const visibleWidth = (s: string): number => [...s.replace(ANSI, "")].length;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

export const SYMBOLS = { done: "✓", failed: "X", skipped: "-", running: "*", needed: "!" } as const;

/** gh's status column: green ✓ success, red X failure, - cancelled or skipped, yellow * running or waiting. */
export function resultSymbol(result: string | null | undefined): string {
  switch (result) {
    case "success":
      return color.green(SYMBOLS.done);
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return color.red(SYMBOLS.failed);
    case "running":
    case "in_progress":
    case "waiting":
    case "queued":
    case "pending":
      return color.yellow(SYMBOLS.running);
    default:
      return SYMBOLS.skipped;
  }
}

export const done = (text: string): string => `${color.green(SYMBOLS.done)} ${text}`;
export const failed = (text: string): string => `${color.red(SYMBOLS.failed)} ${text}`;

/** A person is needed: one line why, then each line to act on (a URL or a command) indented on its own line. */
export function needed(why: string, ...act: string[]): string[] {
  return [`${color.yellow(SYMBOLS.needed)} ${why}`, ...act.filter(Boolean).map((a) => `  ${a}`)];
}

/** The useful next command, last and dimmed. */
export const next = (cmd: string): string => color.dim(`Next: ${cmd}`);

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Relative time in gh's wording: "just now", "3 minutes ago", "about 1 hour ago", "2 days ago", "about 3 months ago". */
export function ago(when: string | number | Date | null | undefined, now: number = Date.now()): string {
  if (when === null || when === undefined) return "";
  const t = when instanceof Date ? when.getTime() : typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `about ${plural(Math.floor(s / 60), "minute")} ago`;
  if (s < 86400) return `about ${plural(Math.floor(s / 3600), "hour")} ago`;
  if (s < 30 * 86400) return `about ${plural(Math.floor(s / 86400), "day")} ago`;
  if (s < 365 * 86400) return `about ${plural(Math.floor(s / (30 * 86400)), "month")} ago`;
  return `about ${plural(Math.floor(s / (365 * 86400)), "year")} ago`;
}

/** "4s", "2m 25s", "1h 3m"; empty when unknown. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Integer cents as dollars; empty when unknown. */
export const money = (cents: number | null | undefined): string => (cents === null || cents === undefined ? "" : `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`);

/** "2026-10" or an ISO time as "October 2026", in UTC. */
export function monthName(month: string): string {
  const d = new Date(month.length === 7 ? `${month}-01T00:00:00Z` : month);
  if (Number.isNaN(d.getTime())) return month;
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface TableOptions {
  /** Column indexes to right-align: money, durations, counts. */
  right?: number[];
  /** Fit rows into this many columns; defaults to the terminal's width (120 when unknown), no limit outside a terminal. */
  width?: number;
}

function cut(s: string, width: number): string {
  const plain = stripAnsi(s);
  if ([...plain].length <= width) return s;
  return [...plain].slice(0, Math.max(0, width - 3)).join("") + "...";
}

/** Uppercase headers, two-space gaps, no borders; the widest text column is truncated until a row fits. */
export function table(headers: string[], rows: string[][], opts: TableOptions = {}): string[] {
  const right = new Set(opts.right ?? []);
  const head = headers.map((h) => h.toUpperCase());
  let body = rows.map((r) => head.map((_, i) => r[i] ?? ""));
  const widths = head.map((h, i) => Math.max(visibleWidth(h), ...body.map((r) => visibleWidth(r[i]!))));
  const max = opts.width ?? (process.stdout.isTTY ? process.stdout.columns || 120 : Infinity);
  const total = () => widths.reduce((n, w) => n + w, 0) + 2 * (widths.length - 1);
  while (total() > max) {
    let col = -1;
    for (let i = 0; i < widths.length; i++) if (!right.has(i) && widths[i]! > Math.max(visibleWidth(head[i]!), 8) && (col < 0 || widths[i]! > widths[col]!)) col = i;
    if (col < 0) break;
    widths[col] = Math.max(visibleWidth(head[col]!), 8, widths[col]! - (total() - max));
    const w = widths[col]!;
    body = body.map((r) => r.map((c, i) => (i === col ? cut(c, w) : c)));
  }
  const pad = (c: string, i: number) => {
    const gap = " ".repeat(Math.max(0, widths[i]! - visibleWidth(c)));
    return right.has(i) ? gap + c : c + gap;
  };
  const line = (r: string[]) => r.map(pad).join("  ").trimEnd();
  return [line(head), ...body.map(line)];
}

/** Aligned "Key  value" lines; pairs with an empty value are left out. */
export function fields(pairs: Array<[string, string]>): string[] {
  const shown = pairs.filter(([, v]) => v !== "");
  const w = Math.max(0, ...shown.map(([k]) => visibleWidth(k)));
  return shown.map(([k, v]) => `${k}${" ".repeat(w - visibleWidth(k))}  ${v}`);
}
