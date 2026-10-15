// How the macOS image build looks (B06.2; docs/CLI_AND_MCP.md, Output for people): in a terminal a live view
// where finished steps stay as one quiet line and only the running step moves; for coding agents one JSON
// event per change. The Buildhound agent owns the build and its words; this only draws them.
import { color, duration, needed, SYMBOLS } from "./style";

export interface ImageStage {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "skipped" | "needs_human" | "failed";
  percent: number;
  detail?: string;
  seconds?: number;
}

export interface ImageCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  title: string;
  fix?: string;
  detail?: string;
}

/** The agent's progress (GET /image/build), as macimage.Progress serves it. */
export interface ImageProgress {
  state: "idle" | "running" | "needs_human" | "waiting" | "ready" | "failed" | "blocked";
  rebuild?: boolean;
  step?: string;
  step_number?: number;
  steps: number;
  title?: string;
  next_step?: string;
  percent: number;
  seconds_left: number;
  total_seconds_left: number;
  waiting?: string;
  needs_human?: { reason: string; why: string; command: string; url: string };
  error?: { code: string; message: string; fix: string };
  macos?: string;
  xcodes?: string[];
  image_id?: string;
  stages: ImageStage[];
  checks?: ImageCheck[];
}

/** The checks (GET /image/checks), as macimage.Report serves them. */
export interface ImageReport {
  ok: boolean;
  checks: ImageCheck[];
  need_bytes: number;
  free_bytes: number;
  macos: string;
  xcodes: Array<{ path: string; version: string; bytes: number }>;
  runtimes: Array<{ platform: string; version: string; bytes: number }>;
  restore_image: string;
  current?: string;
  built: boolean;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "about 2 min left", "under a minute left", "about 1 h 5 min left"; empty when unknown. */
export function timeLeft(seconds: number): string {
  if (!(seconds >= 0)) return "";
  if (seconds < 60) return "under a minute left";
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** What it says once a step is done: the agent's "Copying ..." title becomes its done form. */
const DONE: Record<string, string> = {
  checks: "Checked this Mac",
  restore_image: "Downloaded Apple's restore image",
  macos_install: "Installed macOS",
  password: "Password step done",
  xcode: "Copied Xcode and simulators",
  tools: "Installed tools",
  simulator_warmup: "Warmed up simulators",
  verify: "Verified the image",
  activate: "Turned on macOS jobs",
};

/** The heading: which macOS and Xcode go in. */
export function heading(p: Pick<ImageProgress, "macos" | "xcodes">): string {
  const what = [p.macos ? `macOS ${p.macos}` : "", p.xcodes?.length ? `Xcode ${p.xcodes.join(", ")}` : ""].filter(Boolean).join(", ");
  return `Building the macOS image for this Mac${what ? ` (${what})` : ""}`;
}

/** Finished steps as quiet lines with their time right-aligned and dimmed; the running step with its percent and time left. */
export function liveLines(p: ImageProgress, frame = 0, width = 72): string[] {
  const lines: string[] = [heading(p), ""];
  for (const s of p.stages) {
    if (s.status === "pending") continue;
    if (s.status === "done" || s.status === "skipped") {
      const text = `${color.green(SYMBOLS.done)} ${DONE[s.id] ?? s.title}${s.status === "skipped" && s.detail ? color.dim(` (${s.detail})`) : ""}`;
      const time = s.status === "done" && s.seconds ? duration(s.seconds) : "";
      const plain = `${SYMBOLS.done} ${DONE[s.id] ?? s.title}${s.status === "skipped" && s.detail ? ` (${s.detail})` : ""}`;
      lines.push(time ? `${text}${" ".repeat(Math.max(2, width - [...plain].length - time.length))}${color.dim(time)}` : text);
      continue;
    }
    if (s.status === "running" && s.id === p.step) {
      const left = p.state === "waiting" ? "" : timeLeft(p.seconds_left);
      lines.push(`${color.yellow(SPINNER[frame % SPINNER.length]!)} ${p.title ?? s.title}   ${s.percent}%${left ? `   ${color.dim(left)}` : ""}`);
    }
  }
  lines.push("");
  if (p.state === "waiting" && p.waiting) lines.push(`${color.yellow(SYMBOLS.needed)} ${p.waiting}`);
  const total = timeLeft(p.total_seconds_left);
  const where = `Step ${p.step_number ?? 1} of ${p.steps}${total ? `, ${total.replace(" left", "")} in all` : ""}.`;
  lines.push(`${where}${p.next_step ? ` Next: ${p.next_step}.` : ""} Your macOS jobs run on GitHub-hosted until this finishes.`);
  return lines;
}

/** One JSON event per change for coding agents: `{"event":"progress","step":"xcode","step_number":5,"steps":9,"percent":68,"seconds_left":120,...}`. */
export function progressEvent(p: ImageProgress): Record<string, unknown> {
  return {
    event: "progress",
    state: p.state,
    step: p.step ?? null,
    step_number: p.step_number ?? null,
    steps: p.steps,
    title: p.title ?? null,
    percent: p.percent,
    seconds_left: p.seconds_left,
    total_seconds_left: p.total_seconds_left,
    next_step: p.next_step ?? null,
    ...(p.waiting ? { waiting: p.waiting } : {}),
  };
}

/** The password step for a person: why in one line, the command on its own line. */
export function passwordLines(n: NonNullable<ImageProgress["needs_human"]>): string[] {
  return [...needed("Your password is needed once, to skip macOS's setup screens.", "Run this here, then the build continues on its own:"), "", `  ${n.command}`, "", color.dim(`It writes a first-boot script, its launch file and the marker that skips the Setup Assistant into the new image's disk; nothing else on this Mac changes. More: ${n.url}`)];
}

/** The build's current step as the agent's /status carries it (`imageBuild`), in one plain line; empty when none has run. */
export function imageBuildLine(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const b = raw as { state?: string; step_number?: number; steps?: number; title?: string; percent?: number; total_seconds_left?: number; waiting?: string; command?: string; error?: string; image_id?: string };
  const where = `step ${b.step_number ?? 1} of ${b.steps ?? 9}`;
  switch (b.state) {
    case "running": {
      const left = timeLeft(b.total_seconds_left ?? -1);
      return `macOS image: building, ${where} (${b.title ?? ""}, ${b.percent ?? 0}%)${left ? `, ${left}` : ""}`;
    }
    case "waiting":
      return `macOS image: paused at ${where}. ${b.waiting ?? ""}`.trim();
    case "needs_human":
      return `macOS image: your password is needed once. Run this in a terminal on this Mac: ${b.command ?? "buildhound image build"}`;
    case "failed":
      return `macOS image: the build stopped at ${where}: ${b.error ?? ""}. Run buildhound image build --yes to continue it`;
    case "blocked":
      return `macOS image: the build cannot start: ${b.error ?? ""}. See buildhound image build --check`;
    case "ready":
      return b.image_id ? `macOS image: ready (${b.image_id})` : "macOS image: ready";
  }
  return "";
}
