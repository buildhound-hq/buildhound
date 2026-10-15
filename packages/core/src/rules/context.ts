import { Estimator } from "../estimate/estimator";
import type { History, RepositoryInfo } from "../model/types";
import { loadWorkflow } from "../yaml";
import { DEFAULT_RULE_CONFIG, type ActionRefResolver, type RuleConfig, type RuleContext } from "./types";

export interface MakeContextInput {
  path: string;
  content: string;
  repository?: Partial<RepositoryInfo>;
  history?: History | null;
  config?: Partial<RuleConfig>;
  estimator?: Estimator;
  resolveActionRef?: ActionRefResolver;
}

/** Build a RuleContext for tests and for the CLI. */
export function makeContext(i: MakeContextInput): RuleContext {
  const w = loadWorkflow(i.path, i.content);
  const repository: RepositoryInfo = { fullName: "acme/app", private: true, defaultBranch: "main", ...i.repository };
  return {
    workflow: { path: w.path, content: w.content, doc: w.doc, model: w.model },
    repository,
    history: i.history ?? null,
    estimator: i.estimator ?? new Estimator({}, !repository.private),
    config: { ...DEFAULT_RULE_CONFIG, ...i.config },
    ...(i.resolveActionRef ? { resolveActionRef: i.resolveActionRef } : {}),
  };
}
