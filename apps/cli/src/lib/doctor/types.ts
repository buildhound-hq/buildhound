// `buildhound doctor` (B06.3, B06.4 part 2): read-only checks of this machine, the account and the network,
// each one line with a fix. Every system call goes through Sys, so tests stub the machine instead of reading it.

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  /** One plain line: what was found. */
  title: string;
  /** More for a coding agent: raw values, the longer reason. */
  detail?: string;
  /** On warn or fail (and the one "not set up" skip): the exact command or action. */
  fix?: string;
}

export type HttpResult = { ok: true; status: number; body: unknown; text: string } | { ok: false; error: string };

export interface Sys {
  os: "macos" | "linux" | "other";
  arch: string;
  nodeVersion: string;
  memoryBytes: number;
  hostname: string;
  now(): number;
  env(name: string): string | undefined;
  /** Absolute path of a binary on PATH (system tools also in /usr/bin, /usr/sbin, /bin, /sbin), or null. */
  which(bin: string): string | null;
  /** Trimmed stdout, or null when the binary is missing, fails without output, or times out. Never throws. */
  exec(bin: string, args: string[], timeoutMs?: number): Promise<string | null>;
  /** GET with a timeout; a network failure or timeout is `{ ok: false }`, never a throw. */
  http(url: string, opts?: { token?: string | undefined; timeoutMs?: number }): Promise<HttpResult>;
  exists(path: string): boolean;
  readText(path: string): string | null;
  listDir(path: string): string[];
  /** GET /status on the Buildhound agent's Unix socket; throws when it does not answer. */
  agentStatus(socketPath: string): Promise<Record<string, unknown>>;
  diskFree(path: string): Promise<{ free: number; total: number } | null>;
}

export interface DoctorOptions {
  org?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
}

export interface DoctorResult {
  ok: boolean;
  owner: string | null;
  machine: string;
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; skip: number };
  next: string;
}
