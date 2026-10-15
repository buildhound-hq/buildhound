/**
 * Shared reading and editing helpers for the security rules R15 to R19 (RULES.md, SECURITY.md).
 * Security findings save no money: the estimate is zero minutes and zero cents with high confidence,
 * and `evidence.risk` carries the rating (critical, high, medium or low) the report sorts by.
 * The normalised model has no permissions, env or secrets, so these rules read the parsed document.
 */
import { isCollection, isMap, isNode, isPair, isScalar, type Document, type Pair, type YAMLMap } from "yaml";
import type { Severity } from "./registry";
import type { Estimate, RuleContext } from "./types";

export type Risk = "critical" | "high" | "medium" | "low";

const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];

/** Zero saving, high confidence: the finding is about exposure, not spend. */
export const SECURITY_ESTIMATE: Estimate = { minutesPerMonth: 0, centsPerMonth: 0, confidence: 0.9 };

export function severityFor(risk: Risk): Severity {
  return risk === "critical" || risk === "high" ? "high" : risk;
}

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, r) => (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(a) ? r : a), "low");
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

export interface RawStep {
  index: number;
  name: string | null;
  uses: string | null;
  run: string | null;
  if: string | null;
  with: Obj;
  env: Obj;
  raw: Obj;
}

export interface RawJob {
  id: string;
  raw: Obj;
  /** Reusable workflow called by the job (`jobs.<id>.uses`). */
  uses: string | null;
  if: string | null;
  steps: RawStep[];
}

export interface RawWorkflow {
  raw: Obj;
  events: string[];
  jobs: RawJob[];
}

export function readWorkflow(ctx: RuleContext): RawWorkflow {
  const raw = ctx.workflow.doc.toJS({ mapAsMap: false }) as unknown;
  const w = isObj(raw) ? raw : {};
  const jobsRaw = isObj(w.jobs) ? w.jobs : {};
  const jobs: RawJob[] = Object.entries(jobsRaw)
    .filter((e): e is [string, Obj] => isObj(e[1]))
    .map(([id, j]) => ({
      id,
      raw: j,
      uses: str(j.uses),
      if: str(j.if),
      steps: (Array.isArray(j.steps) ? j.steps : []).map((s, index): RawStep | null =>
        isObj(s) ? { index, name: str(s.name), uses: str(s.uses), run: str(s.run), if: str(s.if), with: isObj(s.with) ? s.with : {}, env: isObj(s.env) ? s.env : {}, raw: s } : null,
      ).filter((s): s is RawStep => s !== null),
    }));
  return { raw: w, events: ctx.workflow.model.events, jobs };
}

export function stepLabel(s: RawStep): string {
  return s.name ?? s.uses ?? (s.run ?? "").trim().split("\n")[0] ?? `step ${s.index + 1}`;
}

// ---------------------------------------------------------------------------------------------
// Secrets

const SECRET_REF = /secrets\.([A-Za-z_][A-Za-z0-9_]*)|secrets\[\s*['"]([^'"]+)['"]\s*\]/g;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}

/** Secret names referenced anywhere in a value, without GITHUB_TOKEN (CLAUDE.md rule 19 treats it apart). */
export function secretsIn(value: unknown): string[] {
  const names = new Set<string>();
  for (const s of strings(value)) {
    for (const m of s.matchAll(SECRET_REF)) names.add(m[1] ?? m[2]!);
    if (/toJSON\(\s*secrets\s*\)/.test(s)) names.add("toJSON(secrets)");
  }
  names.delete("GITHUB_TOKEN");
  return [...names].sort();
}

/** Secrets a job can read: workflow env, the job itself, and every repository secret under `secrets: inherit`. */
export function jobSecrets(wf: RawWorkflow, job: RawJob): string[] {
  const names = secretsIn([wf.raw.env, job.raw]);
  if (job.raw.secrets === "inherit") names.push("inherit");
  return names;
}

/** Secret names a single step passes in through `with:` or `env:`. */
export function stepSecrets(s: RawStep): string[] {
  return secretsIn([s.with, s.env]);
}

// ---------------------------------------------------------------------------------------------
// GITHUB_TOKEN permissions

export type Access = "read" | "write" | "none";
export type Scopes = Record<string, Access>;
export type Permissions =
  | { kind: "default" }
  | { kind: "read-all" }
  | { kind: "write-all" }
  | { kind: "scopes"; scopes: Scopes }
  | { kind: "expression"; text: string };

export function parsePermissions(v: unknown): Permissions {
  if (v === undefined || v === null) return { kind: "default" };
  if (v === "read-all") return { kind: "read-all" };
  if (v === "write-all") return { kind: "write-all" };
  if (isObj(v)) {
    const scopes: Scopes = {};
    for (const [k, a] of Object.entries(v)) scopes[k] = a === "write" ? "write" : a === "read" ? "read" : "none";
    return { kind: "scopes", scopes };
  }
  return { kind: "expression", text: String(v) };
}

export interface EffectivePermissions {
  perms: Permissions;
  /** Where the permissions come from: the job's own block, the workflow's, or the repository default. */
  source: "job" | "workflow" | "default";
}

export function effectivePermissions(wf: RawWorkflow, job: RawJob): EffectivePermissions {
  const own = parsePermissions(job.raw.permissions);
  if (own.kind !== "default") return { perms: own, source: "job" };
  const top = parsePermissions(wf.raw.permissions);
  return { perms: top, source: top.kind === "default" ? "default" : "workflow" };
}

/** Human-readable form for evidence. */
export function describePermissions(p: Permissions): string | Scopes {
  switch (p.kind) {
    case "default": return "repository default (may include write)";
    case "read-all": return "read-all";
    case "write-all": return "write-all";
    case "scopes": return p.scopes;
    case "expression": return p.text;
  }
}

/** True when the token may hold write access to `scope` (any scope when omitted). The repository default counts: it is write on older repositories. */
export function canWrite(p: Permissions, scope?: string): boolean {
  if (p.kind === "default" || p.kind === "write-all" || p.kind === "expression") return true;
  if (p.kind === "read-all") return false;
  return scope ? p.scopes[scope] === "write" : Object.values(p.scopes).some((a) => a === "write");
}

const ACCESS_ORDER: Access[] = ["none", "read", "write"];

/** Union of scope sets; the wider access wins. */
export function mergeScopes(...sets: Scopes[]): Scopes {
  const out: Scopes = {};
  for (const set of sets) for (const [k, a] of Object.entries(set)) if (!out[k] || ACCESS_ORDER.indexOf(a) > ACCESS_ORDER.indexOf(out[k])) out[k] = a;
  return out;
}

export function sameScopes(a: Scopes, b: Scopes): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== "none").sort(), kb = Object.keys(b).filter((k) => b[k] !== "none").sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// ---------------------------------------------------------------------------------------------
// Action references

export interface ActionRef {
  owner: string;
  repo: string;
  /** Subdirectory inside the repository, with its leading slash, or "". */
  path: string;
  ref: string;
  /** owner/repo in lower case, the key for the maintained action lists. */
  key: string;
}

/** `owner/repo[/path]@ref`; null for local (`./`) and `docker://` references. */
export function parseUses(uses: string): ActionRef | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@\s]*)?)@(\S+)$/.exec(uses.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, path: m[3] ?? "", ref: m[4]!, key: `${m[1]}/${m[2]}`.toLowerCase() };
}

export const isFullSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

/** Strip a `${{ }}` wrapper so an `if:` can be combined with another condition. */
export function bareExpression(text: string): string {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text);
  return (m ? m[1]! : text).trim();
}

// ---------------------------------------------------------------------------------------------
// Comment-preserving edits

/** Every comment in a node's subtree, in document order. */
function commentsOf(item: unknown, out: string[] = []): string[] {
  if (isPair(item)) {
    commentsOf(item.key, out);
    commentsOf(item.value, out);
    return out;
  }
  if (!isNode(item)) return out;
  if (item.commentBefore) out.push(item.commentBefore);
  if (isCollection(item)) for (const child of item.items) commentsOf(child, out);
  if (item.comment) out.push(item.comment);
  return out;
}

function prependCommentBefore(item: unknown, lines: string[]): void {
  const node = isPair(item) ? item.key : item;
  if (!isNode(node)) return;
  node.commentBefore = [...lines, node.commentBefore].filter(Boolean).join("\n");
}

/**
 * Remove a key from a map without losing its comments: they become comment lines before the next key,
 * or after the map when the key was last (CLAUDE.md rule 1).
 */
export function deleteKeepingComments(map: YAMLMap, key: string): void {
  const index = map.items.findIndex((p) => keyOf(p) === key);
  if (index === -1) return;
  const lines = commentsOf(map.items[index]);
  map.items.splice(index, 1);
  if (!lines.length) return;
  const next = map.items[index];
  if (next) prependCommentBefore(next, lines);
  else map.comment = [map.comment, ...lines].filter(Boolean).join("\n");
}

export function keyOf(p: Pair): string {
  return isScalar(p.key) ? String(p.key.value) : String(p.key);
}

/** The map at `path`, or the document root for an empty path. */
export function mapAt(doc: Document, path: (string | number)[]): YAMLMap | null {
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  return isMap(node) ? node : null;
}

/** Insert a pair after the first of `afterKeys` present (in order of preference), else at `fallback`. */
export function insertPair(doc: Document, map: YAMLMap, key: string, value: unknown, afterKeys: (string | true)[], fallback: "start" | "end" = "end"): void {
  const pair = doc.createPair(key, value);
  for (const k of afterKeys) {
    const i = map.items.findIndex((p) => (isScalar(p.key) ? p.key.value === k : false));
    if (i === -1) continue;
    // Keep the file's blank-line rhythm: when the next key is set apart by a blank line, set the new one apart too.
    const next = map.items[i + 1];
    if (next && isNode(next.key) && next.key.spaceBefore && isNode(pair.key)) pair.key.spaceBefore = true;
    map.items.splice(i + 1, 0, pair);
    return;
  }
  if (fallback === "start") map.items.unshift(pair);
  else map.items.push(pair);
}

/**
 * Set `permissions:` on the workflow (empty path) or a job (["jobs", id]) to exactly `scopes`, editing an
 * existing block in place so comments on kept scopes stay where they are.
 */
export function setPermissions(doc: Document, path: (string | number)[], scopes: Scopes): void {
  const container = mapAt(doc, path);
  if (!container) return;
  const existing = container.get("permissions", true);
  if (isMap(existing)) {
    for (const p of [...existing.items]) if (!(keyOf(p) in scopes)) deleteKeepingComments(existing, keyOf(p));
    for (const [k, a] of Object.entries(scopes)) {
      const v = existing.get(k, true);
      if (isScalar(v)) v.value = a;
      else existing.set(k, a);
    }
    return;
  }
  const block = doc.createNode(scopes);
  if (isNode(existing)) {
    // A `write-all` or `read-all` scalar becomes a map; its comment moves to the first scope.
    const first = isMap(block) ? block.items[0] : undefined;
    const lines = commentsOf(existing);
    if (first && isNode(first.value) && lines.length) first.value.comment = lines.join(" ");
    container.set("permissions", block);
    return;
  }
  if (path.length) insertPair(doc, container, "permissions", block, ["runs-on", "name", "needs"], "start");
  else insertPair(doc, container, "permissions", block, ["on", true, "name"], "start");
}
