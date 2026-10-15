export interface NormalisedStep {
  name: string | null;
  uses: string | null;
  run: string | null;
  with: Record<string, unknown>;
}

export interface NormalisedMatrix {
  axes: Record<string, unknown[]>;
  include: unknown[];
  exclude: unknown[];
  /** Entries after expansion, honouring include and exclude where they are literal. */
  size: number;
}

export interface NormalisedConcurrency {
  group: string | null;
  cancelInProgress: boolean | string | null;
}

export interface NormalisedJob {
  id: string;
  name: string | null;
  /** Labels after resolving literal matrix references where possible; expressions are kept verbatim. */
  runsOn: string[];
  needs: string[];
  timeoutMinutes: number | null;
  steps: NormalisedStep[];
  matrix: NormalisedMatrix | null;
  concurrency: NormalisedConcurrency | null;
  if: string | null;
  usesContainer: boolean;
  usesServices: boolean;
}

export interface NormalisedWorkflow {
  name: string | null;
  events: string[];
  schedules: string[];
  pushBranches: string[] | null;
  pushTags: string[] | null;
  pullRequestBranches: string[] | null;
  pullRequestTypes: string[] | null;
  concurrency: NormalisedConcurrency | null;
  jobs: NormalisedJob[];
}

export type ActorKind = "human" | "agent" | "bot" | "scheduled" | "unknown";

export interface RunRecord {
  id: number;
  workflowPath: string;
  event: string;
  headBranch: string | null;
  headSha: string | null;
  actorLogin: string | null;
  actorKind: ActorKind;
  agentName: string | null;
  createdAt: Date;
  runStartedAt: Date | null;
  conclusion: string | null;
  isFork: boolean;
  isDraft: boolean;
}

export interface StepRecord {
  name: string;
  durationSeconds: number;
  conclusion: string | null;
}

export interface JobRecord {
  id: number;
  runId: number;
  name: string;
  labels: string[];
  /** When GitHub created the job, which is when it began to wait for a runner; absent from older records. */
  queuedAt?: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  conclusion: string | null;
  steps: StepRecord[];
}

export interface History {
  /** Window covered by the records, in days. */
  days: number;
  runs: RunRecord[];
  jobs: JobRecord[];
}

export interface RepositoryInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}
