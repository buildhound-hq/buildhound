import { createTwoFilesPatch } from "diff";
import type { RateOverrides } from "../cost/classify";
import { Estimator } from "../estimate/estimator";
import type { History, RepositoryInfo } from "../model/types";
import { makeContext } from "../rules/context";
import { RULES, ruleById } from "../rules/registry";
import { FixLostCommentsError } from "../rules/runner";
import type { ActionRefResolver, Finding, Rule, RuleConfig } from "../rules/types";
import { applyEdit } from "../yaml";

/**
 * Fix pull requests from the CI report (`buildhound scan --fix`). Pure: plans which pull requests to open, what
 * each changes and what its body says. Opening them on GitHub is the caller's job (apps/cli/src/lib/fix-pr.ts).
 * Every file is edited through `applyEdit` only (CLAUDE.md rule 1), so it stays byte-identical except the fix.
 */

/** Branches Buildhound opens fix pull requests from. Nothing else writes under this prefix. */
export const FIX_BRANCH_PREFIX = "buildhound/fix-";
/** The branch for `--one-pr`, every fix together. */
export const COMBINED_FIX_BRANCH = `${FIX_BRANCH_PREFIX}ci-report`;
/** Commit trailer that marks a commit as Buildhound's own, so a rerun updates its branch and never one a person changed. */
export const FIX_TRAILER = "Buildhound-Fix";
/** Hidden marker in a pull request body naming the rules it fixes, so the per-rule and combined modes never duplicate each other. */
export const FIX_MARKER = "buildhound-fix";
/** GitHub refuses a pull request body over 65,536 characters; keep well under it. */
const MAX_BODY = 60_000;

export interface FixSource {
  workflows: ReadonlyArray<{ path: string; content: string }>;
  repository: RepositoryInfo;
  history: History | null;
  /** The rules the scan ran; each finding's rule must be among them. */
  rules: readonly Rule[];
  ruleConfig?: Partial<RuleConfig>;
  overrides?: RateOverrides;
  /** Commit SHAs for action tags (R17), looked up before planning; without it R17 has no fix. */
  resolveActionRef?: ActionRefResolver;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
  /** Unified diff of this file. */
  diff: string;
  added: number;
  removed: number;
}

export interface FixGroup {
  /** `r03` for one rule, `ci-report` for `--one-pr`. */
  key: string;
  branch: string;
  title: string;
  ruleIds: string[];
  /** The findings this pull request fixes, each applied to the files below. */
  findings: Finding[];
  files: FileChange[];
  body: string;
  commitMessage: string;
  savingCentsPerMonth: number;
  savingMinutesPerMonth: number;
}

export interface FixPlan {
  groups: FixGroup[];
  /** Findings with no automatic fix (no diff), each with the reason. */
  withoutFix: Array<{ finding: Finding; reason: string }>;
}

export interface PlanOptions {
  /** Rule ids to fix; every rule with a fix when absent, none when empty. */
  only?: readonly string[] | undefined;
  /** One pull request for every fix instead of one per rule. */
  onePr?: boolean | undefined;
}

const keyOf = (ruleId: string, path: string, jobId: string | null) => `${ruleId}\u0000${path}\u0000${jobId ?? ""}`;

/** The branch a rule's fix pull request comes from, for example `buildhound/fix-r03-cancel-in-progress`. */
export function fixBranch(ruleId: string): string {
  const meta = ruleById(ruleId);
  return `${FIX_BRANCH_PREFIX}${ruleId.toLowerCase()}${meta ? `-${meta.slug}` : ""}`;
}

function why(f: Finding): string {
  const note = f.evidence.unresolvedNote;
  if (typeof note === "string") return note;
  return "This finding has no automatic fix; the CI report describes what to change by hand.";
}

/**
 * Apply every wanted fix of `ruleIds` to one file, rule by rule. Each fix is detected again on the file as the
 * previous fix left it, so fixes from different rules on the same lines compose (`--one-pr`), and a finding an
 * earlier fix made moot is left out. Returns the new content and which findings were applied.
 */
export function applyFixesToFile(
  path: string,
  content: string,
  ruleIds: readonly string[],
  wanted: ReadonlySet<string>,
  src: FixSource,
  estimator: Estimator,
): { after: string; applied: Set<string> } {
  let current = content;
  const applied = new Set<string>();
  for (const id of ruleIds) {
    const rule = src.rules.find((r) => r.meta.id === id);
    if (!rule) continue;
    const tried = new Set<string>();
    // One fix at a time, detected again on the result: a rule may emit several findings in one file.
    for (let guard = 0; guard < 200; guard++) {
      const ctx = makeContext({ path, content: current, repository: src.repository, history: src.history, config: src.ruleConfig ?? {}, estimator, ...(src.resolveActionRef ? { resolveActionRef: src.resolveActionRef } : {}) });
      const d = rule.detect(ctx).find((x) => x.fix && wanted.has(keyOf(id, path, x.jobId)) && !tried.has(`${x.jobId ?? ""}\u0000${x.summary}`));
      if (!d) break;
      tried.add(`${d.jobId ?? ""}\u0000${d.summary}`);
      const edit = applyEdit(path, current, d.fix!);
      if (edit.commentsAfter < edit.commentsBefore) throw new FixLostCommentsError(id, edit.commentsBefore, edit.commentsAfter);
      if (edit.after === current) continue;
      current = edit.after;
      applied.add(keyOf(id, path, d.jobId));
    }
  }
  return { after: current, applied };
}

function lineCounts(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Plan the fix pull requests for a scan's findings: one per rule by default, or one for everything. Findings without
 * a diff are listed with the reason and skipped. Files are changed only through the YAML editor.
 */
export function planFixes(findings: readonly Finding[], src: FixSource, opts: PlanOptions = {}): FixPlan {
  // An empty list chooses nothing (every rule already has its pull request); absent chooses every rule.
  const only = opts.only ? new Set(opts.only) : null;
  const chosen = findings.filter((f) => !only || only.has(f.ruleId));
  const withoutFix = chosen.filter((f) => !f.diff).map((finding) => ({ finding, reason: why(finding) }));
  const fixable = chosen.filter((f) => f.diff);
  const order = (id: string) => RULES.findIndex((r) => r.id === id);
  const ruleIds = [...new Set(fixable.map((f) => f.ruleId))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const estimator = new Estimator(src.overrides ?? {}, !src.repository.private);
  const buckets: Array<{ key: string; branch: string; ruleIds: string[] }> = opts.onePr
    ? ruleIds.length ? [{ key: "ci-report", branch: COMBINED_FIX_BRANCH, ruleIds }] : []
    : ruleIds.map((id) => ({ key: id.toLowerCase(), branch: fixBranch(id), ruleIds: [id] }));

  const groups: FixGroup[] = [];
  for (const b of buckets) {
    const mine = fixable.filter((f) => b.ruleIds.includes(f.ruleId));
    const wanted = new Set(mine.map((f) => keyOf(f.ruleId, f.workflowPath, f.jobName)));
    const paths = [...new Set(mine.map((f) => f.workflowPath))].sort();
    const files: FileChange[] = [];
    const applied = new Set<string>();
    for (const path of paths) {
      const content = src.workflows.find((w) => w.path === path)?.content;
      if (content === undefined) continue;
      const r = applyFixesToFile(path, content, b.ruleIds, wanted, src, estimator);
      for (const k of r.applied) applied.add(k);
      if (r.after === content) continue;
      const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, content, r.after, undefined, undefined, { context: 3 });
      files.push({ path, before: content, after: r.after, diff, ...lineCounts(diff) });
    }
    const done = mine.filter((f) => applied.has(keyOf(f.ruleId, f.workflowPath, f.jobName)));
    if (!files.length || !done.length) continue;
    const title = b.ruleIds.length === 1 ? `Fix: ${ruleById(b.ruleIds[0]!)?.title ?? b.ruleIds[0]!}` : `Fix ${done.length} findings from the Buildhound CI report`;
    const group: FixGroup = {
      key: b.key,
      branch: b.branch,
      title,
      ruleIds: [...new Set(done.map((f) => f.ruleId))],
      findings: done,
      files,
      body: "",
      commitMessage: commitMessage(b.ruleIds, done),
      savingCentsPerMonth: done.reduce((a, f) => a + f.estimate.centsPerMonth, 0),
      savingMinutesPerMonth: done.reduce((a, f) => a + f.estimate.minutesPerMonth, 0),
    };
    group.body = fixPullRequestBody(group, src.repository);
    groups.push(group);
  }
  return { groups, withoutFix };
}

function commitMessage(ruleIds: readonly string[], done: readonly Finding[]): string {
  const head = ruleIds.length === 1 ? `ci: apply the Buildhound fix for ${ruleIds[0]} (${ruleById(ruleIds[0]!)?.slug ?? ruleIds[0]})` : `ci: apply ${done.length} Buildhound fixes (${ruleIds.join(", ")})`;
  return `${head}\n\nFrom Buildhound's CI report (npx buildhound scan --fix).\n\n${FIX_TRAILER}: ${ruleIds.join(",")}`;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const confidenceWord = (c: number) => (c >= 0.75 ? "high" : c >= 0.5 ? "medium" : "low");

function estimateLine(f: Finding, repository: RepositoryInfo): string {
  const conf = `confidence ${confidenceWord(f.estimate.confidence)} (${f.estimate.confidence})`;
  const risk = typeof f.evidence.risk === "string" ? f.evidence.risk : null;
  if (f.estimate.centsPerMonth > 0) return `Estimated saving: about ${dollars(f.estimate.centsPerMonth)} a month (${f.estimate.minutesPerMonth} minutes), ${conf}.`;
  if (risk) return `Risk: ${risk}. A security fix, so no dollar estimate; ${conf}.`;
  if (f.estimate.minutesPerMonth > 0) return `Estimated saving: about ${f.estimate.minutesPerMonth} runner minutes a month${repository.private ? "" : ", no dollar saving on a public repository"}, ${conf}.`;
  return `Estimated saving: none measured, ${conf}.`;
}

function where(f: Finding): string {
  return `\`${f.workflowPath}\`${f.jobName ? `, job \`${f.jobName}\`` : ""}`;
}

/**
 * The pull request body: evidence, the estimate and confidence, what changed, an Assumption section for the
 * fixes that can change behaviour (CLAUDE.md rule 14), and a footer naming Buildhound and the CI report.
 */
export function fixPullRequestBody(group: Pick<FixGroup, "ruleIds" | "findings" | "files" | "savingCentsPerMonth" | "savingMinutesPerMonth">, repository: RepositoryInfo, detail: { evidence?: boolean; diff?: boolean } = {}): string {
  const showEvidence = detail.evidence ?? true;
  const showDiff = detail.diff ?? true;
  const n = group.findings.length;
  const out: string[] = [`<!-- ${FIX_MARKER}: ${group.ruleIds.join(",")} -->`];
  out.push(`This pull request applies the fix for ${n === 1 ? "one finding" : `${n} findings`} from Buildhound's CI report. Nothing else in the file${group.files.length === 1 ? "" : "s"} changes: comments and formatting are kept.`);
  if (n > 1 && group.savingCentsPerMonth > 0) out.push("", `**Estimated saving:** about ${dollars(group.savingCentsPerMonth)} a month (${group.savingMinutesPerMonth} minutes).`);

  for (const id of group.ruleIds) {
    const meta = ruleById(id);
    out.push("", `### ${id}: ${meta?.title ?? id}`);
    for (const f of group.findings.filter((x) => x.ruleId === id)) {
      out.push("", `${where(f)}: ${f.summary}.`.replace(/\.\.$/, "."), "", `- ${estimateLine(f, repository)}`, `- Severity: ${f.severity}.`);
      if (showEvidence) {
        const json = JSON.stringify(f.evidence, null, 2);
        out.push("", "<details><summary>Evidence</summary>", "", "```json", json.length > 4000 ? `${json.slice(0, 4000)}\n...` : json, "```", "", "</details>");
      }
    }
  }

  // Rules write the line as "Confirm before merging: ..."; the section says that once.
  const assumptions = [...new Set(group.findings.filter((f) => ruleById(f.ruleId)?.changesBehaviour).map((f) => (f.confirmBeforeMerging ?? "").replace(/^\s*confirm before merging:\s*/i, "").trim()).filter(Boolean))];
  const behaviour = group.ruleIds.filter((id) => ruleById(id)?.changesBehaviour);
  if (behaviour.length) {
    out.push("", "### Assumption", "", `This fix can change how the workflow behaves (${behaviour.join(", ")}). Confirm before merging:`);
    for (const a of assumptions.length ? assumptions : ["the change matches how this workflow is meant to run."]) out.push(`- ${a}`);
  }

  out.push("", "### Change", "");
  for (const file of group.files) out.push(`- \`${file.path}\`: ${file.added} line${file.added === 1 ? "" : "s"} added, ${file.removed} removed.`);
  if (showDiff) {
    const diff = group.files.map((f) => f.diff.trimEnd().split("\n").filter((l) => !/^=+$/.test(l)).join("\n"));
    out.push("", "<details><summary>Diff</summary>", "", "```diff", ...diff, "```", "", "</details>");
  }

  out.push("", "---", "", "Opened by [Buildhound](https://buildhound.sh) from its free CI report (`npx buildhound scan --fix`). Review it like any other change; running the command again updates this pull request instead of opening another.");
  const body = out.join("\n");
  if (body.length > MAX_BODY) {
    if (showDiff) return fixPullRequestBody(group, repository, { evidence: showEvidence, diff: false });
    if (showEvidence) return fixPullRequestBody(group, repository, { evidence: false, diff: false });
    return body.slice(0, MAX_BODY);
  }
  return body;
}

/** The rule ids a pull request body says it fixes, from its hidden marker; empty when it has none. */
export function fixMarkerRules(body: string | null | undefined): string[] {
  const m = new RegExp(`<!-- ${FIX_MARKER}: ([A-Z0-9,]+) -->`).exec(body ?? "");
  return m ? m[1]!.split(",").filter(Boolean) : [];
}
