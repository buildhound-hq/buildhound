import type { RateOverrides } from "../cost/classify";
import { Estimator, type WorkflowEstimate } from "../estimate/estimator";
import type { History, NormalisedWorkflow, RepositoryInfo } from "../model/types";
import { makeContext } from "./context";
import { ALL_RULES } from "./index";
import { runRules } from "./runner";
import type { ActionRefResolver, Finding, Rule, RuleConfig } from "./types";

export interface AuditInput {
  workflows: ReadonlyArray<{ path: string; content: string }>;
  repository: RepositoryInfo;
  history: History | null;
  /** Rules to run; every shipped rule when absent. `ruleConfig.disabledRules` still applies. */
  rules?: readonly Rule[];
  ruleConfig?: Partial<RuleConfig>;
  overrides?: RateOverrides;
  /** Commit SHAs for action tags, looked up before the audit by the caller (R17). */
  resolveActionRef?: ActionRefResolver;
  /**
   * Awaited before each workflow's rules. False skips the rules for this workflow and every later one, which are
   * still estimated and listed in `unaudited`. A caller on a shared runtime can yield here so a long audit does not
   * hold it, and stop when its time budget runs out.
   */
  proceed?: () => Promise<boolean>;
}

export interface AuditedWorkflow {
  path: string;
  model: NormalisedWorkflow;
  estimate: WorkflowEstimate;
  findings: Finding[];
}

export interface Audit {
  workflows: AuditedWorkflow[];
  findings: Finding[];
  assumptions: string[];
  rules: string[];
  estimator: Estimator;
  /** Workflows estimated without running the rules: `proceed` said stop, or a rule failed on the file. */
  unaudited: string[];
}

/**
 * Estimate every workflow and run the rules over it: the audit the CLI's `scan` and the website's public scan
 * share. A workflow that fails to parse is skipped with an assumption, never a thrown error.
 */
export async function auditWorkflows(i: AuditInput): Promise<Audit> {
  const estimator = new Estimator(i.overrides ?? {}, !i.repository.private);
  const disabled = i.ruleConfig?.disabledRules ?? [];
  const enabled = (i.rules ?? ALL_RULES).filter((r) => !disabled.includes(r.meta.id));
  const workflows: AuditedWorkflow[] = [];
  const findings: Finding[] = [];
  const assumptions: string[] = [];
  const unaudited: string[] = [];
  let stopped = false;
  if (!i.history) assumptions.push("no run history: runs per month and minutes per run are the defaults from COST_MODEL.md");
  for (const w of i.workflows) {
    let ctx;
    try {
      ctx = makeContext({ path: w.path, content: w.content, repository: i.repository, history: i.history, config: i.ruleConfig ?? {}, estimator, ...(i.resolveActionRef ? { resolveActionRef: i.resolveActionRef } : {}) });
    } catch (e) {
      assumptions.push(`${w.path}: skipped, could not parse (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const estimate = estimator.estimateWorkflow(ctx.workflow.model, i.history, w.path);
    for (const a of estimate.assumptions) assumptions.push(`${w.path}: ${a}`);
    if (!stopped && i.proceed && !(await i.proceed())) stopped = true;
    let found: Finding[] = [];
    if (stopped) {
      unaudited.push(w.path);
    } else {
      try {
        found = await runRules(enabled, ctx);
      } catch (e) {
        // A rule that fails on one file costs that file its findings, never the whole audit.
        unaudited.push(w.path);
        assumptions.push(`${w.path}: rules not run, a rule failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    findings.push(...found);
    workflows.push({ path: w.path, model: ctx.workflow.model, estimate, findings: found });
  }
  if (stopped) assumptions.push(`rules not run on ${unaudited.length} workflow${unaudited.length === 1 ? "" : "s"} for time: ${unaudited.join(", ")}`);
  return { workflows, findings, assumptions, rules: enabled.map((r) => r.meta.id), estimator, unaudited };
}
