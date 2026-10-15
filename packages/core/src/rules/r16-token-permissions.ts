/**
 * R16 token-permissions (RULES.md, SECURITY.md). A workflow or job whose GITHUB_TOKEN is wider than its steps
 * need: no `permissions:` block (the repository default, write on older repositories), `write-all`, or write
 * scopes no step uses. Risk high for write-all, medium otherwise. One finding per workflow.
 *
 * Fix: a top-level `permissions: contents: read`, and per-job blocks with the scopes the job's steps need,
 * inferred from the maintained map in action-permissions.ts. Jobs with steps the map does not know keep an
 * explicit block they already had; when they had none, the finding names those steps. Changes behaviour.
 */
import { jobNeeds, narrowScopes, proposedScopes, type JobNeeds } from "./action-permissions";
import { ruleById } from "./registry";
import {
  describePermissions, effectivePermissions, parsePermissions, readWorkflow, sameScopes, SECURITY_ESTIMATE, setPermissions, severityFor,
  type Permissions, type RawJob, type Risk, type Scopes,
} from "./security";
import type { Detection, Rule, RuleContext } from "./types";

const TOP: Scopes = { contents: "read" };

/** Write scopes the token holds that the job's steps do not need. Empty when a step's needs are unknown. */
function unusedWrites(p: Permissions, needs: JobNeeds): string[] {
  if (p.kind !== "scopes" || needs.reusable || needs.unknownSteps.length) return [];
  return Object.entries(p.scopes).filter(([k, a]) => a === "write" && needs.scopes[k] !== "write").map(([k]) => k);
}

interface JobPlan {
  job: RawJob;
  needs: JobNeeds;
  problem: "repository default" | "write-all" | "unused write scopes" | null;
  unused: string[];
  /** Scopes for a job-level block, "inherit" to rely on the new top level, "keep" to leave the job untouched. */
  proposed: Scopes | "inherit" | "keep";
}

export const R16: Rule = {
  meta: ruleById("R16")!,
  detect(ctx: RuleContext): Detection[] {
    const wf = readWorkflow(ctx);
    if (!wf.jobs.length) return [];
    const top = parsePermissions(wf.raw.permissions);
    const topNeedsChange = top.kind === "default" || top.kind === "write-all" || (top.kind === "scopes" && Object.values(top.scopes).includes("write"));

    const plans: JobPlan[] = wf.jobs.map((job) => {
      const needs = jobNeeds(job);
      const { perms, source } = effectivePermissions(wf, job);
      const unused = unusedWrites(perms, needs);
      const problem = perms.kind === "write-all" ? "write-all" : perms.kind === "default" ? "repository default" : unused.length ? "unused write scopes" : null;
      const known = !needs.reusable && !needs.unknownSteps.length;
      const wanted = proposedScopes(needs.scopes);
      let proposed: JobPlan["proposed"];
      if (source === "job") {
        // The job's own block: replace write-all, narrow unused writes, otherwise leave it.
        if (perms.kind === "write-all" && !needs.reusable) proposed = wanted;
        else if (unused.length && perms.kind === "scopes") proposed = narrowScopes(perms.scopes, needs.scopes);
        else proposed = "keep";
      } else if (!topNeedsChange) proposed = "keep";
      else if (!known && top.kind === "scopes") proposed = top.scopes; // unknown steps keep exactly what they had
      else if (needs.reusable) proposed = "keep";
      else proposed = sameScopes(wanted, TOP) ? "inherit" : wanted;
      return { job, needs, problem, unused, proposed };
    });
    const flagged = plans.filter((p) => p.problem);
    if (!flagged.length) return [];

    // A reusable workflow that inherited the repository default or write-all cannot be narrowed blind.
    const blocked = topNeedsChange && top.kind !== "scopes" ? plans.filter((p) => p.needs.reusable && effectivePermissions(wf, p.job).source !== "job").map((p) => p.job.id) : [];
    const risk: Risk = flagged.some((p) => p.problem === "write-all") ? "high" : "medium";
    const narrowedBlind = plans.filter((p) => p.problem && p.proposed !== "keep" && p.needs.unknownSteps.length && !(top.kind === "scopes" && p.proposed === top.scopes));
    const unknownSteps = narrowedBlind.flatMap((p) => p.needs.unknownSteps.map((s) => `${p.job.id}: ${s}`));
    const addTop = topNeedsChange;

    const reasons = [...new Set(flagged.map((p) => p.problem))].join(", ");
    return [
      {
        jobId: null,
        severity: severityFor(risk),
        evidence: {
          risk,
          workflowPermissions: describePermissions(top),
          jobs: plans.map((p) => ({
            job: p.job.id,
            effective: describePermissions(effectivePermissions(wf, p.job).perms),
            problem: p.problem,
            unusedWriteScopes: p.unused,
            neededScopes: p.needs.reusable ? null : p.needs.scopes,
            unknownSteps: p.needs.unknownSteps,
            reusableWorkflow: p.needs.reusable,
            proposed: p.proposed,
          })),
          proposedWorkflowPermissions: addTop ? TOP : describePermissions(top),
          notFixedReusableWorkflows: blocked,
        },
        estimate: SECURITY_ESTIMATE,
        summary: `The GITHUB_TOKEN in this workflow is wider than its jobs need (${reasons}); limit it to contents: read plus what each job uses`,
        confirmBeforeMerging: `Confirm before merging: each job's GITHUB_TOKEN is limited to the scopes listed in its permissions block, and a step that needs more fails with a 403.${unknownSteps.length ? ` Scopes for these steps were not inferred, so check them: ${unknownSteps.join("; ")}.` : ""}`,
        fix: blocked.length
          ? null
          : (doc) => {
              if (addTop) setPermissions(doc, [], TOP);
              for (const p of plans) if (typeof p.proposed === "object") setPermissions(doc, ["jobs", p.job.id], p.proposed);
            },
      },
    ];
  },
};
