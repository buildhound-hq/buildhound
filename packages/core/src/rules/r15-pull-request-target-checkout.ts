/**
 * R15 pull-request-target-checkout (RULES.md, SECURITY.md). A `pull_request_target` workflow, or a `workflow_run`
 * workflow, that checks out the pull request's head and then runs it while secrets or a write token are in reach
 * hands those secrets to anyone who opens a pull request. Risk critical.
 *
 * Fix: the safe split (an unprivileged pull_request workflow plus a privileged workflow_run reader) cannot be
 * generated reliably, so the diff takes the fallback RULES.md allows: drop the head ref from the checkout, which
 * then checks out the base branch, and the finding explains the two-workflow pattern. Changes behaviour.
 */
import { isMap } from "yaml";
import { ruleById } from "./registry";
import { canWrite, deleteKeepingComments, describePermissions, effectivePermissions, jobSecrets, mapAt, parseUses, readWorkflow, SECURITY_ESTIMATE, severityFor, stepLabel, type RawStep } from "./security";
import type { Detection, Rule, RuleContext } from "./types";

const PRIVILEGED_EVENTS = ["pull_request_target", "workflow_run"];

/** Expressions that point at the pull request's code rather than the base branch. */
const HEAD_REF = /pull_request\.head\.(sha|ref|repo)|github\.head_ref|workflow_run\.head_(sha|branch|repository)|refs\/pull\/|github\.event\.number|pull_request\.number|pull_request\.merge_commit_sha/;
/** Shell commands that fetch the pull request's code by hand. */
const HEAD_FETCH = /\bgh\s+pr\s+checkout\b|\bgit\s+(fetch|checkout|pull|switch)\b[^\n]*(pull\/|head\.sha|head\.ref|head_ref|workflow_run\.head|pull_request\.number|github\.event\.number)/;

const TWO_WORKFLOWS =
  "Split the job in two: an unprivileged pull_request workflow builds and tests the pull request's code and uploads the results as an artifact, and a privileged workflow_run workflow only downloads that artifact and posts the results, without running anything from it.";

function checksOutHead(s: RawStep): boolean {
  const ref = parseUses(s.uses ?? "");
  if (ref?.key === "actions/checkout") return HEAD_REF.test(String(s.with.ref ?? "")) || HEAD_REF.test(String(s.with.repository ?? ""));
  return HEAD_FETCH.test(s.run ?? "");
}

/** Steps that execute code from the checkout: shell steps and local actions. */
const executes = (s: RawStep): boolean => s.run !== null || (s.uses ?? "").startsWith("./");

export const R15: Rule = {
  meta: ruleById("R15")!,
  detect(ctx: RuleContext): Detection[] {
    const wf = readWorkflow(ctx);
    const triggers = wf.events.filter((e) => PRIVILEGED_EVENTS.includes(e));
    if (!triggers.length) return [];
    const out: Detection[] = [];
    for (const job of wf.jobs) {
      const headSteps = job.steps.filter(checksOutHead);
      if (!headSteps.length) continue;
      const first = headSteps[0]!;
      const executing = job.steps.filter((s) => s.index > first.index && executes(s));
      if (!executing.length) continue;
      const secrets = jobSecrets(wf, job);
      const { perms, source } = effectivePermissions(wf, job);
      const writeToken = canWrite(perms);
      if (!secrets.length && !writeToken) continue;

      const fixable = headSteps.filter((s) => parseUses(s.uses ?? "")?.key === "actions/checkout");
      const byHand = headSteps.filter((s) => !fixable.includes(s)).map(stepLabel);
      const reach = [secrets.length ? `secrets ${secrets.join(", ")}` : null, writeToken ? "a GITHUB_TOKEN that can write" : null].filter(Boolean).join(" and ");
      out.push({
        jobId: job.id,
        severity: severityFor("critical"),
        evidence: {
          risk: "critical",
          triggers,
          workflowRunSources: triggers.includes("workflow_run") ? (wf.raw.on as { workflow_run?: { workflows?: unknown } } | undefined)?.workflow_run?.workflows ?? null : null,
          checkoutSteps: headSteps.map((s) => ({ step: stepLabel(s), ref: s.with.ref ?? null, repository: s.with.repository ?? null, run: s.run ? s.run.trim().split("\n")[0] : null })),
          executingSteps: executing.map(stepLabel),
          secrets,
          permissions: describePermissions(perms),
          permissionsSource: source,
          headFetchedByHand: byHand,
          splitGenerated: false,
          twoWorkflowPattern: TWO_WORKFLOWS,
        },
        estimate: SECURITY_ESTIMATE,
        summary: `Job "${job.id}" runs pull request code on ${triggers.join(" and ")} with ${reach} in reach`,
        confirmBeforeMerging: `Confirm before merging: job "${job.id}" will check out and run the base branch instead of the pull request's code, so it no longer tests the pull request.${byHand.length ? ` These steps fetch the pull request by hand and need the same change: ${byHand.join("; ")}.` : ""} ${TWO_WORKFLOWS}`,
        fix: fixable.length
          ? (doc) => {
              for (const s of fixable) {
                const step = mapAt(doc, ["jobs", job.id, "steps", s.index]);
                const w = step?.get("with", true);
                if (!step || !isMap(w)) continue;
                if (HEAD_REF.test(String(s.with.ref ?? ""))) deleteKeepingComments(w, "ref");
                if (HEAD_REF.test(String(s.with.repository ?? ""))) deleteKeepingComments(w, "repository");
                if (!w.items.length) deleteKeepingComments(step, "with");
              }
            }
          : null,
      });
    }
    return out;
  },
};
