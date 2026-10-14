import type { GitHubFetchOptions } from "./app-auth";

// The Actions service's runner scale set API, as GitHub's `actions/scaleset` client speaks it (MIT), for the
// control plane to broker on a machine's behalf (ADR-026). A registration token, minted with an installation
// token, buys an admin connection: the service's URL and a JWT that manages scale sets and registers runners.
// A message session's own token reads the job queue and acquires jobs. None of these ever leaves the
// control plane.

const SCALE_SETS = "_apis/runtime/runnerscalesets";
const RUNNERS = "_apis/distributedtask/pools/0/agents";

export interface ActionsAdmin {
  url: string;
  token: string;
  /** ISO time the admin token expires, from its JWT. */
  expiresAt: string;
}

export interface ScaleSetLabel {
  name: string;
  type?: string;
}

/** A scale set as the service returns it; fields the control plane does not read pass through. */
export interface ScaleSet {
  id: number;
  name: string;
  runnerGroupId?: number;
  runnerGroupName?: string;
  labels?: ScaleSetLabel[];
  [key: string]: unknown;
}

export interface RunnerGroup {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface ActionsSession {
  sessionId: string;
  ownerName?: string;
  runnerScaleSet?: ScaleSet;
  messageQueueUrl: string;
  messageQueueAccessToken: string;
  statistics?: unknown;
}

/** One job message from the queue: JobAvailable, JobAssigned, JobStarted or JobCompleted. */
export interface JobMessage {
  messageType: string;
  runnerRequestId: number;
  repositoryName?: string;
  ownerName?: string;
  jobDisplayName?: string;
  workflowRunId?: number;
  requestLabels?: string[];
  runnerName?: string;
  [key: string]: unknown;
}

export interface ScaleSetMessage {
  messageId: number;
  statistics: unknown;
  jobs: JobMessage[];
}

export interface RunnerReference {
  id: number;
  name: string;
  runnerScaleSetId: number;
}

export interface JitConfig {
  runner: RunnerReference;
  encodedJITConfig: string;
}

/** The service answered with an unexpected status; `status` is GitHub's. */
export class ActionsServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionsServiceError";
  }
}

/** The session's token expired; refresh the session and try once more. */
export class SessionExpiredError extends ActionsServiceError {
  constructor() {
    super(401, "message session token expired");
    this.name = "SessionExpiredError";
  }
}

function apiBase(configUrl: string, options: GitHubFetchOptions): string {
  return options.baseUrl ?? (new URL(configUrl).host === "github.com" ? "https://api.github.com" : `${new URL(configUrl).origin}/api/v3`);
}

/** The registration token path for an organisation (`https://github.com/org`) or repository config URL. */
function registrationPath(configUrl: string): string {
  const parts = new URL(configUrl).pathname.split("/").filter(Boolean);
  if (parts.length === 1) return `/orgs/${parts[0]}/actions/runners/registration-token`;
  if (parts.length === 2) return `/repos/${parts[0]}/${parts[1]}/actions/runners/registration-token`;
  throw new ActionsServiceError(400, `not an organisation or repository URL: ${configUrl}`);
}

async function readJson(res: Response): Promise<unknown> {
  // The service can prefix a UTF-8 byte order mark.
  const text = (await res.text()).replace(/^\uFEFF/, "");
  return text ? JSON.parse(text) : null;
}

async function fail(res: Response, what: string): Promise<never> {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  throw new ActionsServiceError(res.status, `${what}: ${res.status}${text ? ` ${text}` : ""}`);
}

function jwtExpiry(jwt: string): string {
  const payload = jwt.split(".")[1] ?? "";
  const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
  return new Date((json.exp ?? 0) * 1000).toISOString();
}

/** Mints a registration token with the installation token and trades it for an admin connection. */
export async function getActionsAdmin(installationToken: string, configUrl: string, options: GitHubFetchOptions = {}): Promise<ActionsAdmin> {
  const f = options.fetch ?? fetch;
  const base = apiBase(configUrl, options);
  const reg = await f(`${base}${registrationPath(configUrl)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${installationToken}`, accept: "application/vnd.github+json", "user-agent": "buildhound" },
  });
  if (reg.status !== 201) await fail(reg, "registration token");
  const { token: registrationToken } = (await readJson(reg)) as { token: string };
  const conn = await f(`${base}/actions/runner-registration`, {
    method: "POST",
    headers: { authorization: `RemoteAuth ${registrationToken}`, "content-type": "application/json", "user-agent": "buildhound" },
    body: JSON.stringify({ url: configUrl, runner_event: "register" }),
  });
  if (!conn.ok) await fail(conn, "admin connection");
  const { url, token } = (await readJson(conn)) as { url?: string; token?: string };
  if (!url || !token) throw new ActionsServiceError(502, "admin connection without a URL or token");
  return { url, token, expiresAt: jwtExpiry(token) };
}

function serviceUrl(admin: Pick<ActionsAdmin, "url">, path: string, query: Record<string, string | number> = {}): string {
  const u = new URL(admin.url.replace(/\/?$/, "/") + path.replace(/^\//, ""));
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  if (!u.searchParams.has("api-version")) u.searchParams.set("api-version", "6.0-preview");
  return u.toString();
}

async function call(admin: ActionsAdmin, method: string, path: string, options: GitHubFetchOptions, init: { query?: Record<string, string | number>; body?: unknown; bearer?: string } = {}): Promise<Response> {
  const f = options.fetch ?? fetch;
  return f(serviceUrl(admin, path, init.query), {
    method,
    headers: { authorization: `Bearer ${init.bearer ?? admin.token}`, "content-type": "application/json", "user-agent": "buildhound" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

export async function getRunnerGroupByName(admin: ActionsAdmin, name: string, options: GitHubFetchOptions = {}): Promise<RunnerGroup | null> {
  const res = await call(admin, "GET", "_apis/runtime/runnergroups/", options, { query: { groupName: name } });
  if (res.status !== 200) await fail(res, "runner group");
  const list = (await readJson(res)) as { count: number; value: RunnerGroup[] };
  return list.count === 1 ? list.value[0]! : null;
}

export async function getScaleSetByName(admin: ActionsAdmin, runnerGroupId: number, name: string, options: GitHubFetchOptions = {}): Promise<ScaleSet | null> {
  const res = await call(admin, "GET", SCALE_SETS, options, { query: { runnerGroupId, name } });
  if (res.status !== 200) await fail(res, "get scale set");
  const list = (await readJson(res)) as { count: number; value: ScaleSet[] };
  if (list.count > 1) throw new ActionsServiceError(409, `several scale sets named ${name}`);
  return list.count === 1 ? list.value[0]! : null;
}

export async function getScaleSetById(admin: ActionsAdmin, id: number, options: GitHubFetchOptions = {}): Promise<ScaleSet | null> {
  const res = await call(admin, "GET", `${SCALE_SETS}/${id}`, options);
  if (res.status === 404) return null;
  if (res.status !== 200) await fail(res, "get scale set");
  return (await readJson(res)) as ScaleSet | null;
}

export async function createScaleSet(admin: ActionsAdmin, set: Omit<ScaleSet, "id">, options: GitHubFetchOptions = {}): Promise<ScaleSet> {
  const res = await call(admin, "POST", SCALE_SETS, options, { body: set });
  if (res.status !== 200) await fail(res, "create scale set");
  return (await readJson(res)) as ScaleSet;
}

export async function updateScaleSet(admin: ActionsAdmin, id: number, set: Omit<ScaleSet, "id">, options: GitHubFetchOptions = {}): Promise<ScaleSet> {
  const res = await call(admin, "PATCH", `${SCALE_SETS}/${id}`, options, { body: set });
  if (res.status !== 200) await fail(res, "update scale set");
  return (await readJson(res)) as ScaleSet;
}

export async function deleteScaleSet(admin: ActionsAdmin, id: number, options: GitHubFetchOptions = {}): Promise<void> {
  const res = await call(admin, "DELETE", `${SCALE_SETS}/${id}`, options);
  if (res.status !== 204 && res.status !== 404) await fail(res, "delete scale set");
}

export async function createSession(admin: ActionsAdmin, scaleSetId: number, ownerName: string, options: GitHubFetchOptions = {}): Promise<ActionsSession> {
  const res = await call(admin, "POST", `${SCALE_SETS}/${scaleSetId}/sessions`, options, { body: { ownerName } });
  if (res.status !== 200) await fail(res, "create session");
  return (await readJson(res)) as ActionsSession;
}

export async function refreshSession(admin: ActionsAdmin, scaleSetId: number, sessionId: string, options: GitHubFetchOptions = {}): Promise<ActionsSession> {
  const res = await call(admin, "PATCH", `${SCALE_SETS}/${scaleSetId}/sessions/${sessionId}`, options);
  if (res.status !== 200) await fail(res, "refresh session");
  return (await readJson(res)) as ActionsSession;
}

export async function deleteSession(admin: ActionsAdmin, scaleSetId: number, sessionId: string, options: GitHubFetchOptions = {}): Promise<void> {
  const res = await call(admin, "DELETE", `${SCALE_SETS}/${scaleSetId}/sessions/${sessionId}`, options);
  if (res.status !== 204 && res.status !== 404) await fail(res, "delete session");
}

/** Long-polls the session's queue for about 50 seconds; null when nothing arrived. */
export async function getMessage(session: Pick<ActionsSession, "messageQueueUrl" | "messageQueueAccessToken">, lastMessageId: number, maxCapacity: number, options: GitHubFetchOptions & { signal?: AbortSignal } = {}): Promise<ScaleSetMessage | null> {
  const f = options.fetch ?? fetch;
  const u = new URL(session.messageQueueUrl);
  if (lastMessageId > 0) u.searchParams.set("lastMessageId", String(lastMessageId));
  const res = await f(u.toString(), {
    headers: {
      accept: "application/json; api-version=6.0-preview",
      authorization: `Bearer ${session.messageQueueAccessToken}`,
      "user-agent": "buildhound",
      "x-scalesetmaxcapacity": String(maxCapacity),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.status === 202) return null;
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status !== 200) await fail(res, "get message");
  const raw = (await readJson(res)) as { messageId: number; messageType: string; body?: string; statistics?: unknown };
  if (raw.messageType !== "RunnerScaleSetJobMessages") throw new ActionsServiceError(502, `unsupported message type ${raw.messageType}`);
  const jobs = raw.body ? (JSON.parse(raw.body) as JobMessage[]) : [];
  return { messageId: raw.messageId, statistics: raw.statistics ?? null, jobs };
}

export async function deleteMessage(session: Pick<ActionsSession, "messageQueueUrl" | "messageQueueAccessToken">, messageId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const f = options.fetch ?? fetch;
  const u = new URL(session.messageQueueUrl);
  u.pathname = `${u.pathname}/${messageId}`;
  const res = await f(u.toString(), {
    method: "DELETE",
    headers: { authorization: `Bearer ${session.messageQueueAccessToken}`, "content-type": "application/json", "user-agent": "buildhound" },
  });
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status !== 204) await fail(res, "delete message");
}

/** Acquires jobs with the session's token; returns the request ids GitHub gave this scale set. */
export async function acquireJobs(admin: Pick<ActionsAdmin, "url">, sessionToken: string, scaleSetId: number, requestIds: number[], options: GitHubFetchOptions = {}): Promise<number[]> {
  const res = await call({ url: admin.url, token: sessionToken, expiresAt: "" }, "POST", `${SCALE_SETS}/${scaleSetId}/acquirejobs`, options, { body: requestIds });
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status !== 200) await fail(res, "acquire jobs");
  return ((await readJson(res)) as { value?: number[] }).value ?? [];
}

export async function generateJitConfig(admin: ActionsAdmin, scaleSetId: number, name: string, workFolder: string, options: GitHubFetchOptions = {}): Promise<JitConfig> {
  const res = await call(admin, "POST", `${SCALE_SETS}/${scaleSetId}/generatejitconfig`, options, { body: { name, workFolder } });
  if (res.status !== 200) await fail(res, "generate jit config");
  return (await readJson(res)) as JitConfig;
}

export async function getRunner(admin: ActionsAdmin, runnerId: number, options: GitHubFetchOptions = {}): Promise<RunnerReference | null> {
  const res = await call(admin, "GET", `${RUNNERS}/${runnerId}`, options);
  if (res.status === 404) return null;
  if (res.status !== 200) await fail(res, "get runner");
  return (await readJson(res)) as RunnerReference;
}

export async function removeRunner(admin: ActionsAdmin, runnerId: number, options: GitHubFetchOptions = {}): Promise<void> {
  const res = await call(admin, "DELETE", `${RUNNERS}/${runnerId}`, options);
  if (res.status !== 204 && res.status !== 404) await fail(res, "remove runner");
}
