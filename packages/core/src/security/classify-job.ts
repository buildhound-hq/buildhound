// Job classification for trust tiers (SECURITY.md, Trusted machines; ROADMAP B07.3). A secret-bearing job
// runs only on a trusted machine, never on a burst one such as a pooled laptop. Pure: takes the parsed
// workflow file and what is known about the repository, returns one verdict per job with its reasons.

import { parseDocument } from "yaml";

export type SecretReason =
  /** The job reads the `secrets` context other than `secrets.GITHUB_TOKEN` alone. */
  | "secrets"
  /** A reusable workflow called with `secrets: inherit`. */
  | "secrets_inherit"
  /** `environment:` set: deployment secrets and protection rules. */
  | "environment"
  /** `id-token: write`: a cloud login through OIDC. */
  | "id_token"
  /** The job's GITHUB_TOKEN can write code, packages, actions or deployments. */
  | "write_token"
  /** No `permissions:` block, on a repository whose default token is write (or unknown). */
  | "default_write_token";

export interface JobClassification {
  jobId: string;
  secretBearing: boolean;
  reasons: Array<{ reason: SecretReason; detail: string }>;
}

export interface ClassifyOptions {
  /**
   * The repository's default workflow token permission, from its settings: "write", "read", or
   * undefined when it could not be read, which counts as write so an unknown default never reaches a
   * burst machine.
   */
  defaultTokenPermission?: "read" | "write";
}

/** Scopes whose write access can change code, releases or published packages. */
const WRITE_SCOPES = ["contents", "packages", "actions", "deployments"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string anywhere under a value, with the key path it came from. */
function strings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
}

/**
 * True when an expression reads the secrets context in any form other than GITHUB_TOKEN alone:
 * `secrets.NAME`, `secrets['NAME']`, `toJSON(secrets)` or a bare `secrets`.
 */
export function readsSecrets(expression: string): boolean {
  const word = /(?<![\w.])secrets(?![\w])/g;
  for (const m of expression.matchAll(word)) {
    const rest = expression.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\.\s*GITHUB_TOKEN(?!\w)/i.test(rest) || /^\s*\[\s*['"]GITHUB_TOKEN['"]\s*\]/i.test(rest)) continue;
    return true;
  }
  return false;
}

/** The expressions in a string: the inside of each `${{ }}`, or the whole of an `if:` condition. */
function expressionsIn(text: string, isCondition: boolean): string[] {
  const found = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] ?? "");
  return found.length > 0 || !isCondition ? found : [text];
}

function permissionReasons(perms: unknown, where: string): Array<{ reason: SecretReason; detail: string }> {
  const out: Array<{ reason: SecretReason; detail: string }> = [];
  if (perms === "write-all") out.push({ reason: "write_token", detail: `${where} permissions: write-all` });
  if (isObj(perms)) {
    if (perms["id-token"] === "write") out.push({ reason: "id_token", detail: `${where} permissions: id-token: write` });
    for (const scope of WRITE_SCOPES) if (perms[scope] === "write") out.push({ reason: "write_token", detail: `${where} permissions: ${scope}: write` });
  }
  return out;
}

/** Classifies every job of a parsed workflow file (`yaml`'s `toJS()` of it). */
export function classifyWorkflowJobs(raw: unknown, options: ClassifyOptions = {}): JobClassification[] {
  if (!isObj(raw) || !isObj(raw.jobs)) return [];
  const workflowEnv: Array<{ path: string; text: string }> = [];
  strings(raw.env, "env", workflowEnv);
  const workflowPerms = raw.permissions;

  return Object.entries(raw.jobs).map(([jobId, job]) => {
    const reasons: Array<{ reason: SecretReason; detail: string }> = [];
    const j = isObj(job) ? job : {};

    // The secrets context anywhere the job can see it: its own keys (steps, env, with, a reusable
    // workflow's secrets map, conditions) and the workflow's env.
    const texts: Array<{ path: string; text: string }> = [];
    strings(j, `jobs.${jobId}`, texts);
    for (const t of [...texts, ...workflowEnv]) {
      const isCondition = /\.if$/.test(t.path);
      if (expressionsIn(t.text, isCondition).some(readsSecrets)) {
        reasons.push({ reason: "secrets", detail: `${t.path} reads secrets` });
        break;
      }
    }
    if (j.secrets === "inherit") reasons.push({ reason: "secrets_inherit", detail: `jobs.${jobId}.secrets: inherit` });
    if (j.environment !== undefined && j.environment !== null && j.environment !== "") {
      const name = isObj(j.environment) ? String(j.environment.name ?? "") : String(j.environment);
      reasons.push({ reason: "environment", detail: `jobs.${jobId}.environment: ${name}` });
    }

    // The token: the job's permissions replace the workflow's; with neither, the repository default.
    if (j.permissions !== undefined) reasons.push(...permissionReasons(j.permissions, `jobs.${jobId}`));
    else if (workflowPerms !== undefined) reasons.push(...permissionReasons(workflowPerms, "workflow"));
    else if (options.defaultTokenPermission !== "read") {
      reasons.push({
        reason: "default_write_token",
        detail: options.defaultTokenPermission === "write" ? "no permissions block; the repository's default token is write" : "no permissions block; the repository's default token could not be read",
      });
    }
    return { jobId, secretBearing: reasons.length > 0, reasons };
  });
}

/**
 * The jobs of one workflow file that are secret-bearing (SECURITY.md, Trusted machines), each with the details that make
 * it so: secrets other than GITHUB_TOKEN, inherited secrets, an environment, `id-token: write` or a write token. The
 * same classifier the control plane runs before a no-secrets machine takes a job. An unknown default token counts as
 * write. Such a job is never routed to the plain variable (CLAUDE.md rule 19): `buildhound route`, `route --apply` and
 * R14's fix all read it from here.
 */
export function secretBearingJobs(content: string, defaultTokenPermission?: "read" | "write"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let raw: unknown;
  try {
    raw = parseDocument(content).toJS();
  } catch {
    return out;
  }
  for (const c of classifyWorkflowJobs(raw, defaultTokenPermission ? { defaultTokenPermission } : {})) {
    if (c.secretBearing) out.set(c.jobId, c.reasons.map((r) => r.detail));
  }
  return out;
}
