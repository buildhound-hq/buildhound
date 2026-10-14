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
    return !labels.some((l) => l.startsWith("buildhound-"));
  }
  if (event === "workflow_run" && (action === "requested" || action === "in_progress")) return true;
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
export type { FetchHistoryOptions, HistoryProgress, HistoryResult, WorkflowFile } from "./history";
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
export { cancelRun, forceCancelRun, getDefaultWorkflowPermission, getFileAtRef, getRun, getRunStatus, listActiveRuns, listRunJobs, rerunFailedJobs, rerunJob } from "./runs";
export type { RunJob, RunSummary } from "./runs";
export type { VariableScope } from "./variables";
export { getUser, isAdmin } from "./user";
export type { GitHubUser } from "./user";
