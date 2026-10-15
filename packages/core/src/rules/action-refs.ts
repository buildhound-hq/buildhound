import { loadWorkflow } from "../yaml";
import { isFullSha, parseUses } from "./security";

/** An action or reusable workflow named by a tag or branch, the input R17 asks a commit SHA for. */
export interface ActionRefKey {
  owner: string;
  repo: string;
  ref: string;
}

/** Owner and repository names are case-insensitive on GitHub; the ref is not. */
export const actionRefKey = (owner: string, repo: string, ref: string): string => `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every `uses: owner/repo[/path]@ref` in the workflows whose ref is not already a full commit SHA, once per
 * owner/repo@ref. Local (`./`) and `docker://` references are skipped, and so are refs built from an expression.
 * A workflow that does not parse adds nothing; the audit reports it.
 */
export function collectActionRefs(workflows: ReadonlyArray<{ path: string; content: string }>): ActionRefKey[] {
  const out = new Map<string, ActionRefKey>();
  const add = (uses: unknown) => {
    if (typeof uses !== "string") return;
    const u = uses.trim();
    if (u.startsWith("./") || u.startsWith("docker://")) return;
    const r = parseUses(u);
    if (!r || isFullSha(r.ref) || r.ref.includes("${{")) return;
    const k = actionRefKey(r.owner, r.repo, r.ref);
    if (!out.has(k)) out.set(k, { owner: r.owner, repo: r.repo, ref: r.ref });
  };
  for (const w of workflows) {
    let raw: unknown;
    try {
      raw = loadWorkflow(w.path, w.content).doc.toJS({ mapAsMap: false });
    } catch {
      continue;
    }
    const jobs = isObj(raw) && isObj(raw.jobs) ? raw.jobs : {};
    for (const job of Object.values(jobs)) {
      if (!isObj(job)) continue;
      add(job.uses);
      for (const step of Array.isArray(job.steps) ? job.steps : []) if (isObj(step)) add(step.uses);
    }
  }
  return [...out.values()];
}
