/**
 * R18 agent-on-untrusted-input (RULES.md, SECURITY.md). An AI agent (agent-actions.ts) in a job that any GitHub
 * user can trigger (an issue, a comment, a fork pull request, a discussion), with write permissions or secrets in
 * reach and no author check, can be told by that text to push code or print secrets. Risk critical when it can
 * push or reach deployment secrets, high otherwise.
 *
 * Fix: a job-level `if:` that lets only OWNER, MEMBER and COLLABORATOR authors through on those events, and the
 * job's permissions narrowed to what its steps need when every step is in action-permissions.ts. Changes behaviour.
 */
import { isScalar } from "yaml";
import { jobNeeds, narrowScopes, proposedScopes } from "./action-permissions";
import { agentOf } from "./agent-actions";
import { ruleById } from "./registry";
import {
  bareExpression, canWrite, describePermissions, effectivePermissions, insertPair, jobSecrets, mapAt, readWorkflow, sameScopes, SECURITY_ESTIMATE, setPermissions, severityFor, stepLabel,
  type Risk, type Scopes,
} from "./security";
import type { Detection, Rule, RuleContext } from "./types";

/** Events whose text any GitHub user can write, and where each carries its author's association. */
const UNTRUSTED: Record<string, string> = {
  issue_comment: "github.event.comment.author_association",
  discussion_comment: "github.event.comment.author_association",
  pull_request_target: "github.event.pull_request.author_association",
  issues: "github.event.issue.author_association",
  discussion: "github.event.discussion.author_association",
};
const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** An existing check on who triggered the run. */
const AUTHOR_CHECK = /author_association|github\.(triggering_)?actor\b|sender\.login|\.user\.login/;
/** Scopes whose write access can push code, publish packages or deploy. */
const PUSH_SCOPES = ["contents", "packages", "actions", "deployments"];
/** Secret names that usually unlock a deployment or a publish rather than the agent's own model key. */
const DEPLOYMENT_SECRET = /deploy|aws|azure|gcp|gcloud|google_credentials|npm_token|pypi|docker|kube|vercel|netlify|cloudflare|fly_api|heroku|ssh|private_key|signing|certificate|apple|fastlane|app_store|prod|release|publish|_pat$|^pat_|gh_token|^inherit$|^toJSON\(secrets\)$/i;

function authorCondition(events: string[]): string {
  const fields = [...new Set(events.map((e) => UNTRUSTED[e]).filter((f): f is string => Boolean(f)))];
  const check = `contains(fromJSON('${JSON.stringify(TRUSTED_ASSOCIATIONS)}'), ${fields.join(" || ")})`;
  const untrusted = events.filter((e) => UNTRUSTED[e]);
  // Events that are not in the list (push, workflow_dispatch) keep running as before.
  if (untrusted.length === events.length) return check;
  return `!contains(fromJSON('${JSON.stringify(untrusted)}'), github.event_name) || ${check}`;
}

export const R18: Rule = {
  meta: ruleById("R18")!,
  detect(ctx: RuleContext): Detection[] {
    const wf = readWorkflow(ctx);
    const triggers = wf.events.filter((e) => UNTRUSTED[e]);
    if (!triggers.length) return [];
    const out: Detection[] = [];
    for (const job of wf.jobs) {
      const agentSteps = job.steps.map((s) => ({ s, agent: agentOf(s) })).filter((x): x is { s: (typeof job.steps)[number]; agent: string } => x.agent !== null);
      if (!agentSteps.length) continue;
      if (AUTHOR_CHECK.test(job.if ?? "") || agentSteps.every(({ s }) => AUTHOR_CHECK.test(s.if ?? ""))) continue;
      const secrets = jobSecrets(wf, job);
      const { perms, source } = effectivePermissions(wf, job);
      const writes = canWrite(perms);
      if (!secrets.length && !writes) continue;

      const environment = job.raw.environment ?? null;
      const canPush = PUSH_SCOPES.some((scope) => canWrite(perms, scope));
      const deploymentSecrets = secrets.filter((n) => DEPLOYMENT_SECRET.test(n));
      const risk: Risk = canPush || deploymentSecrets.length || environment ? "critical" : "high";

      const needs = jobNeeds(job);
      const known = !needs.reusable && !needs.unknownSteps.length;
      let narrowed: Scopes | null = null;
      if (known) {
        const wanted = proposedScopes(needs.scopes);
        if (perms.kind === "default" || perms.kind === "write-all") narrowed = wanted;
        else if (perms.kind === "scopes") {
          const n = narrowScopes(perms.scopes, needs.scopes);
          if (!sameScopes(n, perms.scopes)) narrowed = n;
        }
      }
      const condition = authorCondition(wf.events);
      const combined = job.if ? `(${bareExpression(job.if)}) && (${condition})` : condition;
      const agents = [...new Set(agentSteps.map((x) => x.agent))];
      out.push({
        jobId: job.id,
        severity: severityFor(risk),
        evidence: {
          risk,
          triggers,
          agents,
          agentSteps: agentSteps.map(({ s }) => stepLabel(s)),
          permissions: describePermissions(perms),
          permissionsSource: source,
          canPush,
          secrets,
          deploymentSecrets,
          environment,
          authorCheck: null,
          proposedIf: combined,
          proposedPermissions: narrowed,
          ...(known ? {} : { permissionsNotNarrowed: needs.reusable ? "the job calls a reusable workflow" : `scopes not inferred for: ${needs.unknownSteps.join("; ")}` }),
        },
        estimate: SECURITY_ESTIMATE,
        summary: `Job "${job.id}" runs ${agents.join(" and ")} on ${triggers.join(", ")} from any GitHub user, with ${canPush ? "push access" : writes ? "a write token" : "secrets"} in reach and no author check`,
        confirmBeforeMerging: `Confirm before merging: outside contributors can no longer trigger the agent in job "${job.id}"; only ${TRUSTED_ASSOCIATIONS.join(", ")} authors can.${narrowed ? " The job's GITHUB_TOKEN is limited to the scopes in its new permissions block." : ""}`,
        fix: (doc) => {
          const map = mapAt(doc, ["jobs", job.id]);
          if (!map) return;
          const existing = map.get("if", true);
          if (isScalar(existing)) existing.value = combined;
          else if (existing !== undefined) map.set("if", combined);
          else insertPair(doc, map, "if", combined, ["needs", "name"], "start");
          if (narrowed) setPermissions(doc, ["jobs", job.id], narrowed);
        },
      });
    }
    return out;
  },
};
