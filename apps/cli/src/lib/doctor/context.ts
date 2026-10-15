import path from "node:path";
import type { AgentConfig } from "../agent-home";
import type { DoctorOptions, HttpResult, Sys } from "./types";

export const DEFAULT_API = "https://api.buildhound.sh";
export const DEFAULT_DOWNLOADS = "https://dl.buildhound.sh";
export const DEFAULT_GITHUB_API = "https://api.github.com";
/** The Buildhound GitHub App's install page (apps/web/lib/site.ts, docs/GITHUB_APP.md). */
export const INSTALL_APP_URL = "https://github.com/apps/buildhound-ci/installations/new";

export type Token = { token: string; source: "flag" | "env" | "gh" };
export type GitHubUser = { login: string } | { status: number } | { error: string };

/**
 * What the checks share, each read once however many checks need it: the token and the GitHub user, the
 * account's plan, repositories and machines, the Buildhound agent's local status, the process list. Checks
 * run in parallel and await only what they use.
 */
export class Doctor {
  readonly home: string;
  private readonly memo = new Map<string, Promise<unknown>>();
  private cachedConfig: { config: AgentConfig | null; invalid?: string } | undefined;

  constructor(
    readonly sys: Sys,
    readonly opts: DoctorOptions,
  ) {
    this.home = sys.env("BUILDHOUND_AGENT_HOME") || path.join(sys.env("HOME") || "/", ".buildhound");
  }

  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
    }
    return p;
  }

  /** "this Mac" on a Mac, "this machine" elsewhere (docs/BRAND.md, Glossary). */
  get here(): string {
    return this.sys.os === "macos" ? "this Mac" : "this machine";
  }

  /** agent.json, written by `runner add`; never prints the machine token it holds. */
  config(): { config: AgentConfig | null; invalid?: string } {
    if (this.cachedConfig) return this.cachedConfig;
    const text = this.sys.readText(path.join(this.home, "agent.json"));
    if (text === null) this.cachedConfig = { config: null };
    else {
      try {
        const parsed = JSON.parse(text) as AgentConfig;
        this.cachedConfig = typeof parsed === "object" && parsed !== null && typeof parsed.machine_id === "string" ? { config: parsed } : { config: null, invalid: "it has no machine_id" };
      } catch (e) {
        this.cachedConfig = { config: null, invalid: e instanceof Error ? e.message : String(e) };
      }
    }
    return this.cachedConfig;
  }

  policy(): Record<string, unknown> | null {
    const text = this.sys.readText(path.join(this.home, "policy.json"));
    if (!text) return null;
    try {
      const p = JSON.parse(text) as unknown;
      return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** The labels this machine serves, as `--label` takes them: macos, linux or macos,linux. */
  labelFlag(): string {
    const sets = this.config().config?.scale_sets ?? [];
    const kinds = [...new Set(sets.map((s) => (s.label.startsWith("buildhound-macos") ? "macos" : "linux")))];
    if (kinds.length) return kinds.join(",");
    return this.sys.os === "macos" ? "macos" : "linux";
  }

  runnerAdd(owner: string | null): string {
    return `npx buildhound runner add --org ${owner ?? "<login>"} --label ${this.labelFlag()} --yes`;
  }

  /** --token, then GITHUB_TOKEN, then `gh auth token`, as every command reads it. */
  token(): Promise<Token | null> {
    return this.once("token", async () => {
      if (this.opts.token) return { token: this.opts.token, source: "flag" as const };
      const env = this.sys.env("GITHUB_TOKEN");
      if (env) return { token: env, source: "env" as const };
      if (!this.sys.which("gh")) return null;
      const out = await this.sys.exec("gh", ["auth", "token"], 5000);
      return out ? { token: out.split("\n")[0]!.trim(), source: "gh" as const } : null;
    });
  }

  githubApi(): string {
    return (this.sys.env("GITHUB_API_URL") || DEFAULT_GITHUB_API).replace(/\/+$/, "");
  }

  downloads(): string {
    return (this.sys.env("BUILDHOUND_DOWNLOADS_URL") || DEFAULT_DOWNLOADS).replace(/\/+$/, "");
  }

  /** --api-url, then BUILDHOUND_API_URL or API_URL, then the control plane this machine registered with, then production. */
  apiUrl(): string {
    const url = this.opts.apiUrl || this.sys.env("BUILDHOUND_API_URL") || this.sys.env("API_URL") || this.config().config?.api_url || DEFAULT_API;
    return url.replace(/\/+$/, "");
  }

  user(): Promise<GitHubUser | null> {
    return this.once("user", async () => {
      const t = await this.token();
      if (!t) return null;
      const r = await this.sys.http(`${this.githubApi()}/user`, { token: t.token, timeoutMs: 5000 });
      if (!r.ok) return { error: r.error };
      const login = (r.body as { login?: unknown } | null)?.login;
      return r.status === 200 && typeof login === "string" ? { login } : { status: r.status };
    });
  }

  /** --org, else the account this machine is connected to, else the signed-in GitHub user. */
  owner(): Promise<string | null> {
    return this.once("owner", async () => {
      if (this.opts.org) return this.opts.org;
      const fromConfig = this.config().config?.owner;
      if (fromConfig) return fromConfig;
      const u = await this.user();
      return u && "login" in u ? u.login : null;
    });
  }

  private api(pathname: string): Promise<HttpResult | null> {
    return this.once(`api:${pathname}`, async () => {
      const t = await this.token();
      if (!t) return null;
      return this.sys.http(`${this.apiUrl()}${pathname}`, { token: t.token, timeoutMs: 8000 });
    });
  }

  plan(owner: string) {
    return this.api(`/v1/accounts/${encodeURIComponent(owner)}/plan`);
  }

  repos(owner: string) {
    return this.api(`/v1/accounts/${encodeURIComponent(owner)}/repositories`);
  }

  machines(owner: string) {
    return this.api(`/v1/machines?owner=${encodeURIComponent(owner)}`);
  }

  /** This machine's row from the control plane, or null when it cannot be read. */
  async thisMachine(): Promise<Record<string, unknown> | null> {
    const config = this.config().config;
    if (!config) return null;
    const r = await this.machines(config.owner);
    if (!r?.ok || r.status !== 200) return null;
    const list = (r.body as { machines?: unknown } | null)?.machines;
    if (!Array.isArray(list)) return null;
    return (list.find((m) => (m as { id?: unknown }).id === config.machine_id) as Record<string, unknown> | undefined) ?? null;
  }

  socketPath(): string {
    return path.join(this.home, "agent.sock");
  }

  agent(): Promise<{ status: Record<string, unknown> } | { error: string; socket: boolean }> {
    return this.once("agent", async () => {
      const socket = this.socketPath();
      if (!this.sys.exists(socket)) return { error: `no socket at ${socket}`, socket: false };
      try {
        return { status: await this.sys.agentStatus(socket) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e), socket: true };
      }
    });
  }

  /** The agent's local status when it answers, else null. */
  async agentState(): Promise<Record<string, unknown> | null> {
    const a = await this.agent();
    return "status" in a ? a.status : null;
  }

  /** dl.buildhound.sh/agent/latest: the newest Buildhound agent, and proof the downloads host answers. */
  latestAgent(): Promise<HttpResult> {
    return this.once("latest", () => this.sys.http(`${this.downloads()}/agent/latest`, { timeoutMs: 5000 }));
  }

  /** Resident memory in bytes and the command of every process; null when ps cannot be run. */
  processes(): Promise<Array<{ rss: number; name: string }> | null> {
    return this.once("ps", async () => {
      const out = await this.sys.exec("ps", ["-Ao", "rss=,comm="], 5000);
      if (out === null) return null;
      const rows: Array<{ rss: number; name: string }> = [];
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (m) rows.push({ rss: Number(m[1]) * 1024, name: m[2]!.trim() });
      }
      return rows;
    });
  }

  /** `pmset -g batt` on a Mac. */
  battery(): Promise<string | null> {
    return this.once("batt", () => (this.sys.os === "macos" ? this.sys.exec("pmset", ["-g", "batt"]) : Promise.resolve(null)));
  }

  /** A laptop has an internal battery (lib/host.ts hasBattery, read the same way). */
  async laptop(): Promise<boolean> {
    const forced = this.sys.env("BUILDHOUND_HAS_BATTERY");
    if (forced !== undefined) return forced === "1";
    if (this.sys.os === "macos") return /InternalBattery/.test((await this.battery()) ?? "");
    if (this.sys.os === "linux") return this.sys.listDir("/sys/class/power_supply").some((n) => n.startsWith("BAT"));
    return false;
  }
}

/** "0.1.25" against "0.1.26": negative when a is older. Unknown parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Bytes as "3.1 GB" (GiB, as Activity Monitor counts), one decimal under 100, and "700 MB" under 1 GB. */
export function gb(bytes: number): string {
  const g = bytes / 2 ** 30;
  if (g < 1) return `${Math.round(bytes / 2 ** 20)} MB`;
  return `${g >= 100 ? Math.round(g) : Math.round(g * 10) / 10} GB`;
}

/** "181.6MiB", "1.2GiB", "512kB" as docker prints them, in bytes. */
export function parseSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B|[kKMGT]B?|B)?\s*$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  const pow = unit.startsWith("K") ? 1 : unit.startsWith("M") ? 2 : unit.startsWith("G") ? 3 : unit.startsWith("T") ? 4 : 0;
  const base = unit.includes("I") || unit.length === 1 ? 1024 : 1000;
  return Math.round(n * base ** pow);
}
