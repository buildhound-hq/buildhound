import { planFixes } from "@buildhound/core";
import type { Finding, FixGroup } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { actionRefResolver } from "../lib/action-refs";
import { audit, resolveSource, selectRules } from "../lib/audit";
import { coveredElsewhere, openFixPullRequest, prepareWrite, writeError as libWriteError } from "../lib/fix-pr";
import type { FixOutcome, FixStatus, Rest } from "../lib/fix-pr";
import { withDefaultTokenPermission } from "../lib/routing";
import { count, done, money, next as nextLine } from "../lib/style";
import { findToken } from "../lib/token";
import { CliError } from "../output";
import { parseDays } from "./scan";
import type { ScanOptions } from "./scan";

export interface ScanFixOptions extends ScanOptions {
  /** `--rule R03`, repeatable: the rules to open pull requests for. */
  rule?: string[] | undefined;
  onePr?: boolean | undefined;
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
}

export interface FixPullRequest {
  branch: string;
  title: string;
  rules: string[];
  files: Array<{ path: string; added: number; removed: number }>;
  findings: number;
  saving_cents_per_month: number;
  status: FixStatus;
  url: string | null;
  number: number | null;
  note?: string;
  body: string;
  diff: string;
}

export interface ScanFixResult {
  repo: string;
  /** plan: nothing written, confirm with --yes; dry_run: nothing written by request; applied: pull requests opened or updated. */
  mode: "plan" | "dry_run" | "applied";
  /** The default branch head the fixes were made against; null until applied. */
  base: { branch: string; sha: string } | null;
  pull_requests: FixPullRequest[];
  no_automatic_fix: Array<{ rule: string; title: string; workflow: string; job: string | null; reason: string }>;
  assumptions: string[];
  next: string;
}

export interface ScanFixDeps {
  /** GitHub client for the writes; built from the token when absent. Tests pass one over a fake GitHub. */
  github?: Rest;
}

const UNKNOWN_REPO = "<owner/name>";

/** The command to run again, with --yes when `yes`. Flags are kept so an agent repeats exactly what it asked for. */
export function fixCommand(path: string, opts: ScanFixOptions, extra: { yes?: boolean; repo?: string } = {}): string {
  const parts = ["buildhound scan"];
  if (path !== ".") parts.push(path);
  parts.push("--fix");
  const repo = extra.repo ?? opts.repo;
  if (repo) parts.push(`--repo ${repo}`);
  for (const r of opts.rule ?? []) parts.push(`--rule ${r}`);
  if (opts.rules) parts.push(`--rules ${opts.rules}`);
  if (opts.onePr) parts.push("--one-pr");
  if (extra.yes) parts.push("--yes");
  return parts.join(" ");
}

function rulesWanted(opts: ScanFixOptions): string[] | undefined {
  if (opts.rule?.length) return opts.rule.flatMap((r) => r.split(",")).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (opts.rules) return opts.rules.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function toPullRequest(g: FixGroup, o: FixOutcome | null): FixPullRequest {
  return {
    branch: g.branch,
    title: g.title,
    rules: g.ruleIds,
    files: g.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
    findings: g.findings.length,
    saving_cents_per_month: g.savingCentsPerMonth,
    status: o?.status ?? "planned",
    url: o?.url ?? null,
    number: o?.number ?? null,
    ...(o?.note ? { note: o.note } : {}),
    body: g.body,
    diff: g.files.map((f) => f.diff).join(""),
  };
}

/** The command a maintainer runs when the person's login cannot push. */
const maintainerFix = (fullName: string, name: string) => `ask a maintainer of ${fullName} to run npx buildhound scan --fix --repo ${fullName} --yes, or fork it and run buildhound scan --fix --repo <your-login>/${name} --yes`;
const writeError = (e: unknown, repo: string, command: string, opened: FixPullRequest[]) => libWriteError(e, repo, command, opened, `npx buildhound scan --fix --repo ${repo} --yes`);

/**
 * `buildhound scan --fix`: the CI report's fixes as pull requests. Without --yes (or with --dry-run) it plans and
 * writes nothing; with --yes it opens one pull request per rule (or one for all with --one-pr) through the GitHub
 * API with the person's token, against the default branch's head, and a rerun updates them instead of duplicating.
 */
export async function runScanFix(path: string, opts: ScanFixOptions, deps: ScanFixDeps = {}): Promise<ScanFixResult> {
  const command = fixCommand(path, opts);
  const apply = Boolean(opts.yes) && !opts.dryRun;
  if (apply && opts.offline) throw new CliError("USAGE", "--offline cannot open pull requests; it never reaches GitHub", `${fixCommand(path, opts)} --dry-run`, EXIT.usage);
  const days = parseDays(opts.days, command);
  const only = rulesWanted(opts);
  const rules = selectRules(only, command);
  let src = await resolveSource({ path, repo: opts.repo, token: opts.token, days, next: command, offline: opts.offline });
  const assumptions: string[] = src.note ? [src.note] : [];

  let gh: Rest | null = null;
  let base: { branch: string; sha: string; treeSha: string } | null = null;
  let owner = "", name = "";
  if (apply) {
    const target = await prepareWrite({ src, repoGiven: Boolean(opts.repo), token: opts.token, github: deps.github, command: fixCommand(path, opts, { yes: true }), unknownRepo: fixCommand(path, opts, { yes: true, repo: UNKNOWN_REPO }), purpose: `opening fix pull requests needs a GitHub token that can push to ${src.repo}`, maintainer: maintainerFix });
    ({ gh, owner, name, base, src } = target);
    assumptions.push(...target.assumptions);
  }
  src = await withDefaultTokenPermission(src, rules, opts.token, gh ?? deps.github);

  const pinning = !opts.offline && opts.resolve !== false && rules.some((r) => r.meta.id === "R17") && !src.config.rules.disabledRules?.includes("R17");
  const resolveActionRef = pinning ? await actionRefResolver(src.workflows, { token: findToken(opts.token) }) : undefined;
  const a = await audit(src, rules, resolveActionRef);
  assumptions.push(...a.assumptions);

  const fixable = [...new Set(a.findings.filter((f) => f.diff).map((f) => f.ruleId))];
  const covered = apply && gh ? await coveredElsewhere(gh, owner, name, Boolean(opts.onePr), fixable).catch((e: unknown) => { throw writeError(e, src.repo, fixCommand(path, opts, { yes: true }), []); }) : new Map<string, { branch: string; url: string; number: number }>();
  const planOnly = covered.size ? fixable.filter((id) => !covered.has(id) && (!only || only.includes(id))) : only;
  const plan = planFixes(a.findings, { workflows: src.workflows, repository: src.repository, history: src.history, rules, ruleConfig: src.config.rules, overrides: src.config.overrides, ...(resolveActionRef ? { resolveActionRef } : {}) }, { only: planOnly, onePr: opts.onePr });

  const pullRequests: FixPullRequest[] = [];
  if (apply && gh && base) {
    for (const g of plan.groups) {
      try {
        pullRequests.push(toPullRequest(g, await openFixPullRequest(gh, owner, name, base, g)));
      } catch (e) {
        throw writeError(e, src.repo, fixCommand(path, opts, { yes: true }), pullRequests);
      }
    }
  } else {
    pullRequests.push(...plan.groups.map((g) => toPullRequest(g, null)));
  }
  for (const [id, c] of [...covered].sort(([x], [y]) => x.localeCompare(y))) {
    const f = a.findings.filter((x) => x.ruleId === id && x.diff);
    pullRequests.push({ branch: c.branch, title: f[0]?.title ?? id, rules: [id], files: [], findings: f.length, saving_cents_per_month: 0, status: "skipped", url: c.url, number: c.number, note: `already in open pull request #${c.number}`, body: "", diff: "" });
  }

  const unknown = src.repo === "local/repo";
  const next = apply
    ? `buildhound scan --repo ${src.repo}`
    : plan.groups.length
      ? fixCommand(path, opts, { yes: true, ...(unknown ? { repo: UNKNOWN_REPO } : {}) })
      : `buildhound scan${path === "." ? "" : ` ${path}`}`;

  return {
    repo: src.repo,
    mode: apply ? "applied" : opts.dryRun ? "dry_run" : "plan",
    base: base ? { branch: base.branch, sha: base.sha } : null,
    pull_requests: pullRequests,
    no_automatic_fix: plan.withoutFix.map(({ finding, reason }) => noFix(finding, reason)),
    assumptions,
    next,
  };
}

function noFix(f: Finding, reason: string) {
  return { rule: f.ruleId, title: f.title, workflow: f.workflowPath, job: f.jobName, reason };
}

const STATUS_WORD: Record<FixStatus, string> = { planned: "Would open", created: "Opened", updated: "Updated", unchanged: "Already open", skipped: "Skipped" };

/** The plan or the result for a person: each pull request with its branch and files, then what has no automatic fix. */
export function prettyFix(r: ScanFixResult, withNext = true): string {
  const lines: string[] = [];
  const n = r.pull_requests.filter((p) => p.status !== "skipped").length;
  if (!r.pull_requests.length) lines.push(`No fixes to open as pull requests for ${r.repo}.`);
  else if (r.mode === "applied") lines.push(`Fix pull requests on ${r.repo}`);
  else lines.push(`${count(n, "pull request")} to open on ${r.repo}${r.mode === "dry_run" ? " (dry run, nothing written)" : ""}`);
  for (const p of r.pull_requests) {
    lines.push("");
    const head = `${STATUS_WORD[p.status]}: ${p.title}${p.url ? `  ${p.url}` : ""}`;
    lines.push(p.status === "skipped" ? `- ${head}` : p.status === "planned" ? `  ${head}` : done(head));
    lines.push(`  ${p.branch}`);
    for (const f of p.files) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
    if (p.saving_cents_per_month > 0) lines.push(`  About ${money(p.saving_cents_per_month)} a month`);
    if (p.note) lines.push(`  ${p.note}`);
  }
  if (r.no_automatic_fix.length) {
    lines.push("", "No automatic fix");
    for (const x of r.no_automatic_fix) lines.push(`  ${x.rule}  ${x.workflow}${x.job ? ` (${x.job})` : ""}  ${x.reason}`);
  }
  if (r.assumptions.length) lines.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  if (withNext) lines.push("", nextLine(r.next));
  return lines.join("\n");
}
