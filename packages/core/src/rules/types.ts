import type { Document } from "yaml";
import type { History, NormalisedWorkflow, RepositoryInfo } from "../model/types";
import type { Estimator } from "../estimate/estimator";
import type { RuleMeta, Severity } from "./registry";

export interface Estimate {
  minutesPerMonth: number;
  centsPerMonth: number;
  /** 0 to 1 */
  confidence: number;
}

export interface RuleConfig {
  agentPrefixes: string[];
  disabledRules: string[];
  routing: { providers: string[]; installed: string[]; minSavingPercent: number; minJobCentsPerMonth: number };
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  agentPrefixes: ["claude/", "codex/", "copilot/", "cursor/", "devin/"],
  disabledRules: [],
  routing: { providers: ["github", "blacksmith", "depot", "warpbuild", "ubicloud", "jog", "buildhound"], installed: [], minSavingPercent: 25, minJobCentsPerMonth: 2000 },
};

export interface RuleContext {
  workflow: { path: string; content: string; doc: Document; model: NormalisedWorkflow };
  repository: RepositoryInfo;
  history: History | null;
  estimator: Estimator;
  config: RuleConfig;
  /**
   * Resolves an action's tag or branch to the full commit SHA it points at now, or null when unknown (R17).
   * Core has no network: the caller supplies this from the GitHub API, typically from refs fetched before the scan.
   */
  resolveActionRef?: ActionRefResolver;
}

export type ActionRefResolver = (owner: string, repo: string, ref: string) => string | null;

export interface Detection {
  jobId: string | null;
  severity?: Severity;
  evidence: Record<string, unknown>;
  estimate: Estimate;
  /** One sentence for the finding list and the PR title. */
  summary: string;
  /** Required for rules that can change behaviour (CLAUDE.md rule 14). */
  confirmBeforeMerging?: string;
  /** Mutates a fresh Document. null when no automatic fix exists (R07). */
  fix: ((doc: Document) => void) | null;
}

export interface Rule {
  meta: RuleMeta;
  detect(ctx: RuleContext): Detection[];
}

export interface Finding {
  ruleId: string;
  slug: string;
  title: string;
  workflowPath: string;
  jobName: string | null;
  severity: Severity;
  evidence: Record<string, unknown>;
  estimate: Estimate;
  summary: string;
  confirmBeforeMerging: string | null;
  diff: string | null;
  fingerprint: string;
}
