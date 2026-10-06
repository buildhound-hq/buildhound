import { isMap, isNode, isScalar, isSeq, type Document, type Node } from "yaml";
import type { History, NormalisedWorkflow } from "../model/types";
import { ruleById } from "./registry";
import type { Detection, Rule, RuleContext } from "./types";

const MAX_BRANCHES_NAMED = 10;

/** GitHub branch filter glob: `*` stops at a slash, `**` crosses it. */
function globToRegExp(pattern: string): RegExp {
  const src = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${src}$`);
}

function filtersOverlap(a: string, b: string): boolean {
  return a === b || globToRegExp(a).test(b) || globToRegExp(b).test(a);
}

/** True when the push filter will run on commits that a pull_request run also covers. */
function pushOverlapsPullRequest(model: NormalisedWorkflow, defaultBranch: string): boolean {
  if (model.pushBranches === null) return model.pushTags === null; // a tags-only push filter never runs on branch pushes
  const extras = model.pushBranches.filter((b) => b !== defaultBranch);
  if (!extras.length) return false;
  if (model.pullRequestBranches === null) return true;
  return extras.some((b) => model.pullRequestBranches!.some((p) => filtersOverlap(b, p)));
}

interface Observed {
  pushRuns: number;
  pullRequestRuns: number;
  duplicatedShas: number;
  branchesLosingPushRuns: string[];
}

function observe(history: History, workflowPath: string, defaultBranch: string): Observed {
  const runs = history.runs.filter((r) => r.workflowPath === workflowPath);
  const pushShas = new Set<string>();
  const prShas = new Set<string>();
  const branches = new Map<string, number>();
  let pushRuns = 0, pullRequestRuns = 0;
  for (const r of runs) {
    if (r.event === "push") {
      pushRuns++;
      if (r.headSha) pushShas.add(r.headSha);
      if (r.headBranch && r.headBranch !== defaultBranch) branches.set(r.headBranch, (branches.get(r.headBranch) ?? 0) + 1);
    } else if (r.event === "pull_request") {
      pullRequestRuns++;
      if (r.headSha) prShas.add(r.headSha);
    }
  }
  let duplicatedShas = 0;
  for (const sha of prShas) if (pushShas.has(sha)) duplicatedShas++;
  const branchesLosingPushRuns = [...branches.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b);
  return { pushRuns, pullRequestRuns, duplicatedShas, branchesLosingPushRuns };
}

function copyComments(from: Node, to: Node): void {
  if (from.comment) to.comment = from.comment;
  if (from.commentBefore) to.commentBefore = from.commentBefore;
  if (from.spaceBefore) to.spaceBefore = from.spaceBefore;
}

/** Restrict `push` to the default branch; `tags` and every other event stay as they were. */
function restrictPush(doc: Document, defaultBranch: string): void {
  const on = doc.get("on", true);
  if (isSeq(on)) {
    const events: Record<string, unknown> = {};
    for (const item of on.items) {
      const name = isScalar(item) ? String(item.value) : String(item);
      events[name] = name === "push" ? { branches: [defaultBranch] } : null;
    }
    const replacement = doc.createNode(events);
    copyComments(on, replacement);
    doc.set("on", replacement);
    return;
  }
  if (!isMap(on)) return;
  const push = on.get("push", true);
  if (isMap(push)) {
    const branches = doc.createNode([defaultBranch]);
    const old = push.get("branches", true);
    if (isNode(old)) {
      copyComments(old, branches);
      if (isSeq(old) && old.flow) branches.flow = true;
      push.set("branches", branches);
    } else push.items.unshift(doc.createPair("branches", branches));
    return;
  }
  const replacement = doc.createNode({ branches: [defaultBranch] });
  if (isScalar(push)) copyComments(push, replacement);
  on.set("push", replacement);
}

export const R02: Rule = {
  meta: ruleById("R02")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, path, doc } = ctx.workflow;
    const defaultBranch = ctx.repository.defaultBranch;
    if (!model.events.includes("push") || !model.events.includes("pull_request")) return [];
    if (!pushOverlapsPullRequest(model, defaultBranch)) return [];
    // `branches` cannot be combined with `branches-ignore`; such a push block needs a human.
    if (doc.hasIn(["on", "push", "branches-ignore"])) return [];

    const observed = ctx.history ? observe(ctx.history, path, defaultBranch) : null;
    const hasRuns = observed !== null && observed.pushRuns + observed.pullRequestRuns > 0;
    if (hasRuns && observed.duplicatedShas === 0) return [];

    const estimate = ctx.estimator.estimateWorkflow(model, ctx.history, path);
    const minutesPerRun = estimate.jobs.reduce((a, j) => a + j.minutesPerRun * j.entries, 0);
    const centsPerRun = estimate.jobs.reduce((a, j) => a + j.minutesPerRun * j.entries * j.pricePerMinute * 100, 0);
    const scale = ctx.history ? 30 / Math.max(1, ctx.history.days) : 1;
    const duplicateRunsPerMonth = hasRuns ? Math.round(observed.duplicatedShas * scale) : (estimate.runsByEvent.pull_request ?? 0);
    const confidence = hasRuns ? 0.85 : 0.5;

    const losing = observed?.branchesLosingPushRuns ?? [];
    const named = losing.length ? ` In the last ${ctx.history!.days} days that was: ${losing.slice(0, MAX_BRANCHES_NAMED).join(", ")}${losing.length > MAX_BRANCHES_NAMED ? ` and ${losing.length - MAX_BRANCHES_NAMED} more` : ""}.` : "";
    const confirmBeforeMerging = `Pushes to branches other than ${defaultBranch} will no longer trigger this workflow; only pull_request runs will cover them.${named} Confirm that no deploy, preview or status check depends on push runs from those branches.`;

    return [
      {
        jobId: null,
        evidence: {
          defaultBranch,
          pushBranches: model.pushBranches,
          pushTags: model.pushTags,
          pullRequestBranches: model.pullRequestBranches,
          pushRunsInWindow: observed?.pushRuns ?? null,
          pullRequestRunsInWindow: observed?.pullRequestRuns ?? null,
          duplicatedShasInWindow: observed?.duplicatedShas ?? null,
          windowDays: ctx.history?.days ?? null,
          branchesLosingPushRuns: losing.slice(0, MAX_BRANCHES_NAMED),
          duplicateRunsPerMonth,
          minutesPerRun,
        },
        estimate: {
          minutesPerMonth: Math.round(duplicateRunsPerMonth * minutesPerRun),
          centsPerMonth: Math.round(duplicateRunsPerMonth * centsPerRun),
          confidence,
        },
        summary: hasRuns
          ? `${observed.duplicatedShas} commits ran under both push and pull_request in ${ctx.history!.days} days; filter push to ${defaultBranch}`
          : `push and pull_request both run on every pull request commit; filter push to ${defaultBranch}`,
        confirmBeforeMerging,
        fix: (d) => restrictPush(d, defaultBranch),
      },
    ];
  },
};
