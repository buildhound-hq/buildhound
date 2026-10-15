/**
 * R17 unpinned-actions (RULES.md, SECURITY.md). An action or reusable workflow referenced by a tag or branch
 * runs whatever its owner points that name at next. Risk medium; high when the step receives secrets; low for
 * first-party `actions/*` and `github/*`. One finding per job, listing every unpinned reference.
 *
 * Fix: pin each reference to the commit its tag resolves to now, with the tag kept as a trailing comment
 * (`uses: owner/action@<sha> # v4`). Core has no network, so the SHA comes from `ctx.resolveActionRef`;
 * without it, or when it returns null, the finding is still reported with no diff.
 */
import { isScalar } from "yaml";
import { ruleById } from "./registry";
import { isFullSha, maxRisk, parseUses, readWorkflow, SECURITY_ESTIMATE, severityFor, stepLabel, stepSecrets, type ActionRef, type Risk } from "./security";
import type { Detection, Rule, RuleContext } from "./types";

const FIRST_PARTY = ["actions", "github"];

interface Reference {
  /** Path of the `uses:` scalar in the document. */
  path: (string | number)[];
  step: string;
  uses: string;
  ref: ActionRef;
  secrets: string[];
  risk: Risk;
  sha: string | null;
}

export const R17: Rule = {
  meta: ruleById("R17")!,
  detect(ctx: RuleContext): Detection[] {
    const wf = readWorkflow(ctx);
    const out: Detection[] = [];
    const resolve = (r: ActionRef): string | null => {
      const sha = ctx.resolveActionRef?.(r.owner, r.repo, r.ref) ?? null;
      return sha && isFullSha(sha) ? sha.toLowerCase() : null;
    };
    for (const job of wf.jobs) {
      const candidates: Omit<Reference, "risk" | "sha">[] = [];
      if (job.uses) {
        const ref = parseUses(job.uses);
        if (ref) candidates.push({ path: ["jobs", job.id, "uses"], step: "reusable workflow", uses: job.uses, ref, secrets: job.raw.secrets === "inherit" ? ["inherit"] : [] });
      }
      for (const s of job.steps) {
        const ref = s.uses ? parseUses(s.uses) : null;
        if (ref) candidates.push({ path: ["jobs", job.id, "steps", s.index, "uses"], step: stepLabel(s), uses: s.uses!, ref, secrets: stepSecrets(s) });
      }
      const refs: Reference[] = candidates
        .filter((c) => !isFullSha(c.ref.ref))
        .map((c) => {
          const firstParty = FIRST_PARTY.includes(c.ref.owner.toLowerCase());
          const risk: Risk = firstParty ? "low" : c.secrets.length ? "high" : "medium";
          return { ...c, risk, sha: resolve(c.ref) };
        });
      if (!refs.length) continue;
      const risk = maxRisk(refs.map((r) => r.risk));
      const resolved = refs.filter((r) => r.sha);
      const names = [...new Set(refs.map((r) => r.uses))];
      out.push({
        jobId: job.id,
        severity: severityFor(risk),
        evidence: {
          risk,
          references: refs.map((r) => ({
            step: r.step,
            uses: r.uses,
            ref: r.ref.ref,
            firstParty: FIRST_PARTY.includes(r.ref.owner.toLowerCase()),
            secrets: r.secrets,
            risk: r.risk,
            sha: r.sha,
          })),
          resolved: resolved.length,
          unresolved: refs.length - resolved.length,
          ...(resolved.length < refs.length
            ? { unresolvedNote: ctx.resolveActionRef ? "GitHub did not return a commit for these references." : "The commit SHA could not be resolved offline; scan with GitHub access to get the pinning diff." }
            : {}),
        },
        estimate: SECURITY_ESTIMATE,
        summary: `Job "${job.id}" uses ${names.length === 1 ? names[0] : `${names.length} actions`} by tag or branch; pin to a full commit SHA`,
        fix: resolved.length
          ? (doc) => {
              for (const r of resolved) {
                const node = doc.getIn(r.path, true);
                if (!isScalar(node)) continue;
                node.value = `${r.ref.owner}/${r.ref.repo}${r.ref.path}@${r.sha}`;
                node.comment = ` ${r.ref.ref}${node.comment ? ` ${node.comment.trim()}` : ""}`;
              }
            }
          : null,
      });
    }
    return out;
  },
};
