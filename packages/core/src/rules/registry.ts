export type Severity = "high" | "medium" | "low";
export type RuleKind = "static" | "dynamic" | "both";

export interface RuleMeta {
  id: string;
  slug: string;
  title: string;
  severity: Severity;
  kind: RuleKind;
  /** Fixes that can change behaviour must name their assumption in the PR body (CLAUDE.md rule 14). */
  changesBehaviour: boolean;
}

export const RULES: readonly RuleMeta[] = [
  { id: "R01", slug: "cron-frequency", title: "Cron more frequent than needed", severity: "high", kind: "both", changesBehaviour: false },
  { id: "R02", slug: "double-trigger", title: "Push and pull_request run the same commit twice", severity: "high", kind: "both", changesBehaviour: true },
  { id: "R03", slug: "cancel-in-progress", title: "No cancel-in-progress on branches", severity: "high", kind: "both", changesBehaviour: false },
  { id: "R04", slug: "macos-without-need", title: "macOS runner with no Apple toolchain steps", severity: "high", kind: "both", changesBehaviour: true },
  { id: "R05", slug: "missing-cache", title: "Dependency install with no cache", severity: "medium", kind: "both", changesBehaviour: false },
  { id: "R06", slug: "no-timeout", title: "Job without timeout-minutes", severity: "medium", kind: "both", changesBehaviour: false },
  { id: "R07", slug: "oversized-matrix", title: "Matrix entries whose results never differ", severity: "medium", kind: "both", changesBehaviour: false },
  { id: "R08", slug: "artifact-retention", title: "Artifacts retained 90 days", severity: "low", kind: "static", changesBehaviour: false },
  { id: "R09", slug: "full-depth-checkout", title: "fetch-depth 0 with no history use", severity: "low", kind: "both", changesBehaviour: false },
  { id: "R10", slug: "larger-runner-without-need", title: "Larger runner with no speed benefit", severity: "medium", kind: "dynamic", changesBehaviour: true },
  { id: "R11", slug: "fork-and-draft-runs", title: "Expensive jobs on fork and draft PRs", severity: "medium", kind: "both", changesBehaviour: false },
  { id: "R12", slug: "agent-burst", title: "Agent branches pushing in bursts without protection", severity: "high", kind: "dynamic", changesBehaviour: false },
  { id: "R13", slug: "slim-runner", title: "Light job on a 2-core runner", severity: "low", kind: "both", changesBehaviour: true },
  { id: "R14", slug: "runner-routing", title: "Job cheaper on another runner provider", severity: "medium", kind: "dynamic", changesBehaviour: true },
];

export function ruleById(id: string): RuleMeta | undefined {
  return RULES.find((r) => r.id === id);
}
