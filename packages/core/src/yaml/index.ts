import { isMap, isPair, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { createTwoFilesPatch, diffLines } from "diff";
import { normaliseWorkflow } from "../model/normalise";
import type { NormalisedWorkflow } from "../model/types";

export interface LoadedWorkflow {
  path: string;
  content: string;
  doc: Document;
  model: NormalisedWorkflow;
}

/** Parse once, keep the Document for comment-preserving edits, and derive the model. */
export function loadWorkflow(path: string, content: string): LoadedWorkflow {
  const doc = parseDocument(content, { keepSourceTokens: true, version: "1.2" });
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0]!.message}`);
  return { path, content, doc, model: normaliseWorkflow(doc.toJS({ mapAsMap: false })) };
}

export type WorkflowEdit = (doc: Document) => void;

export interface AppliedEdit {
  before: string;
  after: string;
  diff: string;
  /** Comment lines before and after. An edit that loses comments is a bug (CLAUDE.md rule 1). */
  commentsBefore: number;
  commentsAfter: number;
}

/** Whitespace-insensitive form of a line, with a trailing comment kept so comment moves are visible. */
function canonical(line: string): string {
  return line.replace(/\s+/g, " ").replace(/([[{])\s+/g, "$1").replace(/\s+([\]}])/g, "$1").trim();
}

/**
 * The serialiser rewrites spacing and moves `key:   # comment` onto its own line even on lines the fix never
 * touched. This restores the original text of every line whose content did not change, hunk by hunk, so the
 * diff shows only the fix. The result must parse to the same data as the serialised document, else it is dropped.
 */
export function minimiseChurn(before: string, serialised: string, expectedJson: string): string {
  const out: string[] = [];
  for (const part of diffLines(before, serialised)) {
    if (!part.added && !part.removed) { out.push(part.value); continue; }
    if (part.removed) { pendingRemoved = part.value.replace(/\n$/, "").split("\n"); continue; }
    const added = part.value.replace(/\n$/, "").split("\n");
    const removed = pendingRemoved; pendingRemoved = [];
    out.push(restoreHunk(removed, added).join("\n") + "\n");
  }
  if (pendingRemoved.length) { pendingRemoved = []; }
  const candidate = out.join("");
  try {
    const reparsed = parseDocument(candidate);
    if (!reparsed.errors.length && JSON.stringify(reparsed.toJS()) === expectedJson) return candidate;
  } catch { /* fall through */ }
  return serialised;
}
let pendingRemoved: string[] = [];

/** Merge a `key:` line followed by a comment-only line back into `key: # comment` for comparison purposes. */
function mergedCanonical(lines: string[]): string[] {
  const res: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!, next = lines[i + 1];
    if (next !== undefined && /:\s*$/.test(cur) && /^\s*#/.test(next)) { res.push(canonical(cur + " " + next.trim())); i++; }
    else res.push(canonical(cur));
  }
  return res;
}

function restoreHunk(removed: string[], added: string[]): string[] {
  if (!removed.length) return added;
  // Pure formatting hunk: every line's content is unchanged, so keep the original lines verbatim.
  const r = removed.map(canonical), a = mergedCanonical(added);
  if (r.length === a.length && r.every((x, i) => x === a[i])) return removed;
  // Partial: restore individual lines whose content is unchanged and whose structural prefix (leading
  // whitespace plus any sequence dash and the spacing after it) is identical, so the content column is unchanged.
  const prefix = (l: string) => /^\s*(?:-\s*)?/.exec(l)![0];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const unused = removed.slice();
  const out: string[] = [];
  for (let i = 0; i < added.length; i++) {
    const line = added[i]!, next = added[i + 1];
    // A `key:` line followed by a comment-only line may be the serialiser's split of an original `key: # comment`.
    if (next !== undefined && /:\s*$/.test(line) && /^\s*#/.test(next)) {
      const mergedC = canonical(line + " " + next.trim());
      const idx = unused.findIndex((x) => canonical(x) === mergedC && indentOf(x) === indentOf(line));
      if (idx !== -1) { out.push(unused.splice(idx, 1)[0]!); i++; continue; }
    }
    const c = canonical(line), p = prefix(line);
    // A line with a different dash spacing may only be restored when nothing below continues the same item.
    const continuationSafe = next === undefined || indentOf(next) <= indentOf(line);
    const idx = unused.findIndex((x) => canonical(x) === c && (prefix(x) === p || (continuationSafe && indentOf(x) === indentOf(line))));
    out.push(idx === -1 ? line : unused.splice(idx, 1)[0]!);
  }
  return out;
}

interface BlockScalar { type: string; value: unknown; start: number; end: number }

/** Every block scalar (`|`, `>` and their variants) in a parsed document, keyed by its path from the root. Copied, so a later edit cannot change it. */
function blockScalars(doc: Document): Map<string, BlockScalar> {
  const out = new Map<string, BlockScalar>();
  const walk = (node: unknown, path: unknown[]): void => {
    if (isScalar(node)) {
      if (node.range && (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL")) out.set(JSON.stringify(path), { type: node.type, value: node.value, start: node.range[0], end: node.range[2] });
    } else if (isMap(node)) {
      for (const pair of node.items) if (isPair(pair)) walk(pair.value, [...path, isScalar(pair.key) ? pair.key.value : String(pair.key)]);
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, [...path, i]));
    }
  };
  walk(doc.contents, []);
  return out;
}

const lineIndent = (text: string, offset: number): number => {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^ */.exec(text.slice(start))![0].length;
};

/**
 * The serialiser re-emits block scalars with its own folding, so a folded `if: >-` the fix never touched can come
 * back with its lines joined. Every block scalar with the same path, style and value as in the source gets its
 * original text back, provided its key sits at the same indentation. The result must parse to the same data.
 * `doc` is the parse of `serialised` the caller already made.
 */
function restoreBlockScalars(before: string, original: Map<string, BlockScalar>, serialised: string, doc: Document, expectedJson: string): string {
  const swaps: { from: number; to: number; text: string }[] = [];
  for (const [path, node] of blockScalars(doc)) {
    const src = original.get(path);
    if (!src || src.type !== node.type || src.value !== node.value) continue;
    if (lineIndent(before, src.start) !== lineIndent(serialised, node.start)) continue;
    let text = before.slice(src.start, src.end);
    if (serialised.slice(node.start, node.end).endsWith("\n") && !text.endsWith("\n")) text += "\n";
    swaps.push({ from: node.start, to: node.end, text });
  }
  if (!swaps.length) return serialised;
  let candidate = serialised;
  for (const { from, to, text } of swaps.sort((a, b) => b.from - a.from)) candidate = candidate.slice(0, from) + text + candidate.slice(to);
  const reparsed = parseDocument(candidate);
  return !reparsed.errors.length && JSON.stringify(reparsed.toJS()) === expectedJson ? candidate : serialised;
}

/** Most common indentation step in the file, defaulting to 2. */
export function detectIndent(text: string): number {
  const counts = new Map<number, number>();
  let prev = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const n = line.length - line.trimStart().length;
    if (n > prev) counts.set(n - prev, (counts.get(n - prev) ?? 0) + 1);
    prev = n;
  }
  let best = 2, bestCount = 0;
  for (const [step, c] of counts) if (step > 0 && step <= 8 && c > bestCount) { best = step; bestCount = c; }
  return best;
}

export function countComments(text: string): number {
  return text.split("\n").filter((l) => /(^|\s)#(?!\{)/.test(l)).length;
}

/** Apply an edit to a fresh parse of the content, never to the caller's Document, and return the unified diff. */
export function applyEdit(path: string, content: string, edit: WorkflowEdit): AppliedEdit {
  const doc = parseDocument(content, { keepSourceTokens: true, version: "1.2" });
  const originalBlocks = blockScalars(doc);
  edit(doc);
  // lineWidth 0 never re-wraps; flowCollectionPadding false keeps `[main]` as written instead of `[ main ]`;
  // indent follows the file so a four-space file stays four-space. Remaining churn on oddly spaced files is a known limit.
  const indent = detectIndent(content);
  const serialised = doc.toString({ lineWidth: 0, flowCollectionPadding: false, indent, indentSeq: true });
  const check = parseDocument(serialised);
  if (check.errors.length) throw new Error(`${path}: fix produced invalid YAML: ${check.errors[0]!.message}`);
  const expectedJson = JSON.stringify(check.toJS());
  const after = minimiseChurn(content, restoreBlockScalars(content, originalBlocks, serialised, check, expectedJson), expectedJson);
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, content, after, undefined, undefined, { context: 3 });
  return { before: content, after, diff, commentsBefore: countComments(content), commentsAfter: countComments(after) };
}
