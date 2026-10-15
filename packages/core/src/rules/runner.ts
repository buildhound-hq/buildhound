import { applyEdit } from "../yaml";
import type { Finding, Rule, RuleContext } from "./types";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FixLostCommentsError extends Error {
  constructor(ruleId: string, before: number, after: number) {
    super(`${ruleId}: fix lost comments (${before} before, ${after} after)`);
  }
}

/**
 * Run every enabled rule on one workflow. Fixes are serialised to diffs here, never by the rules. `beforeFix`, when
 * given, is asked before each diff with the file's size; false leaves that finding's diff null.
 */
export async function runRules(rules: readonly Rule[], ctx: RuleContext, beforeFix?: (bytes: number) => Promise<boolean>): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const rule of rules) {
    if (ctx.config.disabledRules.includes(rule.meta.id)) continue;
    for (const d of rule.detect(ctx)) {
      let diff: string | null = null;
      if (d.fix && (!beforeFix || (await beforeFix(ctx.workflow.content.length)))) {
        const applied = applyEdit(ctx.workflow.path, ctx.workflow.content, d.fix);
        if (applied.commentsAfter < applied.commentsBefore) throw new FixLostCommentsError(rule.meta.id, applied.commentsBefore, applied.commentsAfter);
        diff = applied.after === applied.before ? null : applied.diff;
      }
      if (rule.meta.changesBehaviour && !d.confirmBeforeMerging) throw new Error(`${rule.meta.id}: behaviour-changing rule without confirmBeforeMerging`);
      out.push({
        ruleId: rule.meta.id,
        slug: rule.meta.slug,
        title: rule.meta.title,
        workflowPath: ctx.workflow.path,
        jobName: d.jobId,
        severity: d.severity ?? rule.meta.severity,
        evidence: d.evidence,
        estimate: d.estimate,
        summary: d.summary,
        confirmBeforeMerging: d.confirmBeforeMerging ?? null,
        diff,
        fingerprint: await sha256Hex([rule.meta.id, ctx.repository.fullName, ctx.workflow.path, d.jobId ?? ""].join("\n")),
      });
    }
  }
  return out;
}
