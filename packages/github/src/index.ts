import { verify } from "@octokit/webhooks-methods";

/** Verify X-Hub-Signature-256 with Web Crypto, so apps/api stays portable to Cloudflare Workers. */
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  return verify(secret, payload, signature);
}

/** The label families of GitHub-hosted runners: ubuntu-latest, macos-15, windows-2025 and their sizes. */
const HOSTED_LABEL = /^(ubuntu|macos|windows)-/;

/** Edge filter from ARCHITECTURE.md: actions that carry no data we use are dropped before storage or enqueueing. */
export function shouldDropAtEdge(
  event: string,
  action: string | undefined,
  labels: readonly string[] = [],
): boolean {
  if (
    event === "workflow_job" &&
    (action === "queued" || action === "in_progress" || action === "waiting")
  ) {
    if (labels.some((l) => l.startsWith("buildhound-"))) return false;
    // A job starting on a GitHub-hosted label carries how long it waited for a runner (queue relief).
    return !(action === "in_progress" && labels.some((l) => HOSTED_LABEL.test(l)));
  }
  // A run starting carries its title for its jobs on machines; only its request carries nothing we use.
  if (event === "workflow_run" && action === "requested") return true;
  if (event === "pull_request") {
    return !["opened", "synchronize", "reopened", "ready_for_review", "closed"].includes(
      action ?? "",
    );
  }
  return false;
}

export const INSTALLATION_TOKEN_TTL_SECONDS = 50 * 60;

export {
  createGitHubClient,
  decodeBase64Utf8,
  GitHubApiError,
  RATE_LIMIT_PAUSE_THRESHOLD,
  sinceDate,
  UnreadableFileError,
} from "./client";
export type {
  GitHubActor,
  GitHubClient,
  GitHubClientOptions,
  GitHubJob,
  GitHubRepository,
  GitHubRun,
  GitHubStep,
  GitHubWorkflow,
  QueryParams,
  RateLimitState,
  RequestOptions,
} from "./client";
export { fetchHistory, pool, toJobRecord, toRunRecord } from "./history";
export type { FetchHistoryOptions, HistoryProgress, HistoryResult, SkippedWorkflow, WorkflowFile } from "./history";
export {
  base64UrlDecode,
  base64UrlEncode,
  createAppJwt,
  createScopedInstallationToken,
  getInstallationForAccount,
  importRsaPrivateKey,
  listInstallationRepositories,
  pkcs1ToPkcs8,
} from "./app-auth";
export type {
  AppInstallation,
  AppJwtOptions,
  GitHubFetchOptions,
  InstallationPermissions,
  InstallationRepository,
  ScopedInstallationToken,
} from "./app-auth";
export { deleteVariable, setVariable } from "./variables";
export { cancelRun, dispatchWorkflow, forceCancelRun, getDefaultWorkflowPermission, getFileAtRef, getRepositorySummary, getRun, getRunStatus, listActiveRuns, listBranchNames, listJobAnnotations, listRecentRuns, listRepositoryWorkflows, listRunJobs, rerunFailedJobs, rerunJob } from "./runs";
export type { RepositorySummary, RepositoryWorkflow, RunDetail, RunJob, RunJobStep, RunSummary } from "./runs";
export type { VariableScope } from "./variables";
export { canReadRepository, countUserInstallationRepositories, getPrimaryEmail, getUser, isAdmin, listUserInstallations, listUserOrgs, orgRole, revokeGrant } from "./user";
export type { GitHubUser, UserInstallation } from "./user";
export * as actionsService from "./actions-service";
export { ActionsServiceError, SessionExpiredError } from "./actions-service";
export type { ActionsAdmin, ActionsSession, JitConfig, JobMessage, RunnerGroup, RunnerReference, ScaleSet, ScaleSetMessage } from "./actions-service";
