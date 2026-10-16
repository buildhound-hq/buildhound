import { EXIT } from "@buildhound/shared";
import type { NeedsHuman } from "@buildhound/shared";
import { CliError, NeedsHumanError } from "../output";
import { resolveToken } from "./token";

export const DEFAULT_API_URL = "https://api.buildhound.sh";

export interface ApiOptions {
  apiUrl?: string | undefined;
  token?: string | undefined;
}

/** Base URL: --api-url, then BUILDHOUND_API_URL, then API_URL, then the production control plane. */
export function resolveApiUrl(explicit: string | undefined): string {
  const url = explicit || process.env.BUILDHOUND_API_URL || process.env.API_URL || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}

/** A `needs_human` answer, with the error envelope the control plane sent beside it (NEEDS_TEAM, MACHINE_LIMIT) and the Team feature it names. */
export type NeedsHumanAnswer = NeedsHuman & { feature?: string; error?: { code: string; message: string; next: string } };

export type ApiResult<T> = { kind: "ok"; status: number; body: T } | { kind: "needs_human"; body: NeedsHumanAnswer };

function exitFor(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 429 || status >= 500) return EXIT.network;
  return EXIT.usage;
}

type ErrorEnvelopeLike = { error?: { code?: unknown; message?: unknown; next?: unknown; retry_after_seconds?: unknown } };

/**
 * Minimal control plane client (CONTROL_PLANE_API.md). Error envelopes become CliError with the same code and next;
 * a 403 whose body says `status: "needs_human"` is not an error: the agent hands the URL to a human and continues.
 */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** Build a client for a CLI command: `next` is the command to repeat once a token is available. */
  static forCommand(opts: ApiOptions, next: string): ApiClient {
    const token = resolveToken(opts.token, next, "this command needs a GitHub token so the control plane can check who you are");
    return new ApiClient(resolveApiUrl(opts.apiUrl), token);
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, next = "retry the command"): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), "user-agent": "buildhound-cli", "x-buildhound-source": process.env.BUILDHOUND_SOURCE === "mcp" ? "mcp" : "cli" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new CliError("NETWORK", `could not reach ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`, `check the network with buildhound doctor, or pass --api-url, then ${next}`, EXIT.network);
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return { kind: "ok", status: res.status, body: json as T };
    const obj = (json ?? {}) as Record<string, unknown>;
    if (obj.status === "needs_human" && typeof obj.url === "string") {
      const env = (obj as ErrorEnvelopeLike).error;
      const answerNext = typeof obj.next === "string" ? obj.next : next;
      return {
        kind: "needs_human",
        body: {
          status: "needs_human",
          reason: String(obj.reason ?? "human_step_required"),
          url: obj.url,
          next: answerNext,
          ...(typeof obj.feature === "string" ? { feature: obj.feature } : {}),
          ...(env && typeof env.code === "string" ? { error: { code: env.code, message: typeof env.message === "string" ? env.message : env.code, next: answerNext } } : {}),
        },
      };
    }
    const err = (obj as ErrorEnvelopeLike).error ?? {};
    const code = typeof err.code === "string" ? err.code : res.status === 401 ? "UNAUTHENTICATED" : "API_ERROR";
    const message = typeof err.message === "string" ? err.message : `${method} ${path} failed with HTTP ${res.status}`;
    const fallbackNext = code === "MACHINE_LIMIT" ? "buildhound plan --org <login> says where to choose a plan" : code === "RATE_LIMITED" && typeof err.retry_after_seconds === "number" ? `wait ${err.retry_after_seconds} seconds, then ${next}` : next;
    throw new CliError(code, message, typeof err.next === "string" && err.next ? err.next : fallbackNext, exitFor(res.status));
  }

  /**
   * Like request, for commands that read or change data: a needs_human answer (NEEDS_TEAM on an organisation without
   * Team, for one) ends the command with that answer and exit 0 (`NeedsHumanError`), never as data.
   */
  async expect<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, next: string): Promise<T> {
    const r = await this.request<T>(method, path, body, next);
    if (r.kind === "needs_human") throw new NeedsHumanError(r.body);
    return r.body;
  }
}
