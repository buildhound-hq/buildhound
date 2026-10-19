/*
 * Server errors in PostHog error tracking (ARCHITECTURE.md, Observability): the control plane's unexpected errors
 * (apps/api/src/analytics.ts) and the website's server errors (apps/web/instrumentation.ts). An error's message can
 * carry what must never leave: a token, an address, a query's parameters, a GitHub URL naming a repository. So the
 * text sent is scrubbed first, and nothing else from the request goes with it.
 */

const MAX_TEXT = 300;
const MAX_FRAMES = 40;
const MAX_CAUSES = 3;

const REDACTIONS: [RegExp, string][] = [
  // A URL keeps its scheme and host only: the path names accounts, repositories and machines, the userinfo a password.
  [/\b(https?|postgres(?:ql)?|wss?):\/\/(?:[^\s/@]+@)?([^\s/?#"']+)[^\s"']*/gi, "$1://$2/…"],
  // GitHub tokens, a bearer or basic credential, a JWT, an address, then any long secret-looking run of characters.
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[token]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [token]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[token]"],
  [/[^\s@<>()"']+@[^\s@<>()"']+\.[A-Za-z]{2,}/g, "[email]"],
  [/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]"],
];

/** An error message fit to send: the first line before any query parameters, secrets and paths redacted, shortened. */
export function scrubErrorText(text: string): string {
  let out = (text.split(/\n\s*params:/i)[0] ?? "").split("\n")[0] ?? "";
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  out = out.trim();
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 1)}…` : out;
}

export interface ExceptionFrame {
  platform: "node:javascript";
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

export interface ExceptionEntry {
  type: string;
  value: string;
  mechanism: { type: string; handled: boolean; synthetic: false };
  stacktrace?: { type: "raw"; frames: ExceptionFrame[] };
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** A V8 stack's frames, innermost last as PostHog expects. Code locations only; file paths lose any query string. */
export function stackFrames(stack: string | undefined): ExceptionFrame[] {
  if (!stack) return [];
  const frames: ExceptionFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const filename = (m[2] ?? "").replace(/[?#].*$/, "");
    frames.push({
      platform: "node:javascript",
      filename,
      function: m[1] ?? "?",
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|^node:|^internal\//.test(filename),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** PostHog's `$exception_list` for an error and up to three of its causes, outermost first, each scrubbed. */
export function exceptionList(error: unknown, mechanism: string): ExceptionEntry[] {
  const list: ExceptionEntry[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && list.length <= MAX_CAUSES) {
    const e = current instanceof Error ? current : null;
    const frames = stackFrames(e?.stack);
    list.push({
      type: e?.name || "Error",
      value: scrubErrorText(e ? e.message : typeof current === "string" ? current : "non-error thrown"),
      mechanism: { type: mechanism, handled: false, synthetic: false },
      ...(frames.length ? { stacktrace: { type: "raw" as const, frames } } : {}),
    });
    current = e?.cause;
  }
  return list;
}
