import { ALL_RULES, Estimator, makeContext, runRules } from "@buildhound/core";
import type { Finding, History, NormalisedWorkflow, RepositoryInfo, Rule, WorkflowEstimate } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";
import type { CliConfig } from "./config";
import { loadConfig } from "./config";
import { fetchRemoteRepo } from "./github";
import { resolveToken } from "./token";
import { localRepoName, parseRepo, readLocalWorkflows, resolveUserPath } from "./workflows";
import type { WorkflowFile } from "./workflows";

export interface Source {
  repo: string;
  repository: RepositoryInfo;
  workflows: WorkflowFile[];
  history: History | null;
  config: CliConfig;
}

/**
 * Workflows and history either from a local directory (static, no history) or from GitHub with --repo.
 * `next` is the command to repeat once the user has fixed what the error names.
 */
export async function resolveSource(i: { path: string; repo?: string | undefined; token?: string | undefined; days: number; next: string }): Promise<Source> {
  const config = loadConfig(resolveUserPath(i.path));
  if (i.repo) {
    const { owner, name } = parseRepo(i.repo, i.next);
    const token = resolveToken(i.token, i.next);
    const remote = await fetchRemoteRepo({ token, owner, name, days: i.days, next: i.next });
    return { repo: remote.repository.fullName, repository: remote.repository, workflows: remote.workflows, history: remote.history, config };
  }
  const workflows = readLocalWorkflows(i.path);
  const repo = localRepoName(i.path);
  return { repo, repository: { fullName: repo, private: true, defaultBranch: "main" }, workflows, history: null, config };
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
}

/** Rules to run: the --rules subset when given, else every shipped rule. Unknown ids are a usage error. */
export function selectRules(only: string[] | undefined, next: string): readonly Rule[] {
  if (!only || !only.length) return ALL_RULES;
  const rules = only.map((id) => {
    const rule = ALL_RULES.find((r) => r.meta.id === id);
    if (!rule) throw new CliError("UNKNOWN_RULE", `no rule ${id}; shipped rules are ${ALL_RULES.map((r) => r.meta.id).join(", ")}`, next, EXIT.usage);
    return rule;
  });
  return rules;
}

/** Estimate every workflow and run the rules over it. Workflows that fail to parse become a finding-free entry with an assumption. */
export async function audit(src: Source, rules: readonly Rule[]): Promise<Audit> {
  const estimator = new Estimator(src.config.overrides, !src.repository.private);
  const disabled = src.config.rules.disabledRules ?? [];
  const enabled = rules.filter((r) => !disabled.includes(r.meta.id));
  const workflows: AuditedWorkflow[] = [];
  const findings: Finding[] = [];
  const assumptions: string[] = [];
  if (!src.history) assumptions.push("no run history: runs per month and minutes per run are the defaults from COST_MODEL.md");
  if (src.config.path) assumptions.push(`configuration read from ${src.config.path}`);
  for (const w of src.workflows) {
    let ctx;
    try {
      ctx = makeContext({ path: w.path, content: w.content, repository: src.repository, history: src.history, config: src.config.rules, estimator });
    } catch (e) {
      assumptions.push(`${w.path}: skipped, could not parse (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const estimate = estimator.estimateWorkflow(ctx.workflow.model, src.history, w.path);
    for (const a of estimate.assumptions) assumptions.push(`${w.path}: ${a}`);
    const found = await runRules(enabled, ctx);
    findings.push(...found);
    workflows.push({ path: w.path, model: ctx.workflow.model, estimate, findings: found });
  }
  return { workflows, findings, assumptions, rules: enabled.map((r) => r.meta.id), estimator };
}
