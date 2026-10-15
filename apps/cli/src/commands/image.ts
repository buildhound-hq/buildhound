import { Command } from "commander";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { EXIT } from "@buildhound/shared";
import { agentSocketPath, installedAgentPath, readAgentConfig } from "../lib/agent-home";
import { agentRequest, type AgentAnswer } from "../lib/agent-socket";
import { confirm } from "../lib/confirm";
import { liveLines, passwordLines, progressEvent, type ImageCheck, type ImageProgress, type ImageReport } from "../lib/image-progress";
import { color, done, failed, next as nextLine, SYMBOLS } from "../lib/style";
import { CliError, emit, wantsJson } from "../output";

// `buildhound image build` (B06.2): the macOS image built on this Mac by the Buildhound agent, which owns the
// build and its steps. This command only asks the agent over its local socket and draws what it answers, so
// the CLI, the MCP tool `image_build`, the menu bar and the dashboard all follow the same build.

export interface ImageBuildOptions {
  check?: boolean | undefined;
  rebuild?: boolean | undefined;
  wait?: boolean | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export type ImageBuildStatus = "ready" | "building" | "needs_human" | "waiting" | "blocked" | "failed" | "checked";

export interface ImageBuildResult {
  status: ImageBuildStatus;
  /** Set on needs_human, as AGENT_FIRST.md's three human steps: the reason, the docs URL and the command a person runs. */
  reason?: string;
  url?: string;
  command?: string;
  why?: string;
  image_id?: string;
  /** The image in use already has this Mac's Xcode, so nothing was built. */
  already_built?: boolean;
  step?: string | null;
  step_number?: number | null;
  steps: number;
  title?: string | null;
  percent?: number;
  seconds_left?: number;
  total_seconds_left?: number;
  next_step?: string | null;
  waiting?: string;
  error?: { code: string; message: string; fix: string };
  checks?: ImageCheck[];
  /** --check: what the build needs and what is here. */
  need_bytes?: number;
  free_bytes?: number;
  restore_image?: string;
  macos?: string;
  xcodes?: string[];
  progress?: ImageProgress;
  next: string;
}

/** The pieces that touch this Mac, replaced in tests. */
export interface ImageDeps {
  request: (method: "GET" | "POST", route: string, body?: unknown) => Promise<AgentAnswer>;
  /** `buildhound-agent image check --json` from the installed binary, when the agent is not running. */
  checkWithBinary: () => Promise<ImageReport | null>;
  sleep: (ms: number) => Promise<void>;
  platform: string;
}

const run = promisify(execFile);

function defaultDeps(): ImageDeps {
  return {
    request: (method, route, body) => agentRequest(agentSocketPath(), method, route, body),
    checkWithBinary: async () => {
      const bin = installedAgentPath();
      if (!existsSync(bin)) return null;
      try {
        const { stdout } = await run(bin, ["image", "check", "--json"], { timeout: 120_000 });
        return JSON.parse(stdout) as ImageReport;
      } catch (e) {
        // `image check` exits 1 when a check fails, with the report on stdout.
        const out = (e as { stdout?: string }).stdout;
        if (out) {
          try {
            return JSON.parse(out) as ImageReport;
          } catch {
            return null;
          }
        }
        return null;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    platform: process.platform,
  };
}

const BUILD = "buildhound image build";

/** The command that turns macOS jobs on once the image is ready: the macOS label, when this Mac does not serve it yet. */
function afterReady(): string {
  const config = readAgentConfig();
  if (config && !config.scale_sets.some((s) => s.label === "buildhound-macos")) return `buildhound runner add --org ${config.owner} --label macos,linux --yes`;
  return "buildhound runner status";
}

/** Asks the agent; a missing socket or an agent too old for image builds is an error with the next command. */
async function ask(deps: ImageDeps, method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  let answer: AgentAnswer;
  try {
    answer = await deps.request(method, route, body);
  } catch (e) {
    const config = readAgentConfig();
    const msg = e instanceof Error ? e.message : String(e);
    if (!config) throw new CliError("NOT_CONNECTED", `this Mac is not connected yet, so there is no Buildhound agent to build the image (${msg})`, "buildhound runner add --org <login> --yes", EXIT.usage);
    throw new CliError("AGENT_NOT_RUNNING", `the Buildhound agent is not answering on ${agentSocketPath()}: ${msg}`, "buildhound doctor", EXIT.usage);
  }
  if (answer.status === 404) {
    const err = (answer.body as { error?: { code?: string; message?: string; next?: string } }).error;
    if (err?.code) throw new CliError(err.code, err.message ?? err.code, err.next ?? "buildhound runner status", EXIT.usage);
    const owner = readAgentConfig()?.owner ?? "<login>";
    throw new CliError("AGENT_TOO_OLD", "the Buildhound agent on this Mac does not build images yet; it updates itself, or connect again to update it now", `buildhound runner add --org ${owner} --yes`, EXIT.usage);
  }
  if (answer.status >= 400) {
    const err = (answer.body as { error?: { code?: string; message?: string; next?: string } }).error;
    throw new CliError(err?.code ?? "AGENT_ERROR", err?.message ?? `the Buildhound agent answered HTTP ${answer.status}`, err?.next ?? "buildhound doctor", EXIT.usage);
  }
  return answer.body;
}

/** The agent's progress as this command's result, with the one next command. */
export function toResult(p: ImageProgress): ImageBuildResult {
  const base = {
    steps: p.steps,
    step: p.step ?? null,
    step_number: p.step_number ?? null,
    title: p.title ?? null,
    percent: p.percent,
    seconds_left: p.seconds_left,
    total_seconds_left: p.total_seconds_left,
    next_step: p.next_step ?? null,
    ...(p.macos ? { macos: p.macos } : {}),
    ...(p.xcodes ? { xcodes: p.xcodes } : {}),
    progress: p,
  };
  switch (p.state) {
    case "ready": {
      const already = p.stages.every((s) => s.id === "checks" || s.status === "skipped");
      return { status: "ready", ...base, ...(p.image_id ? { image_id: p.image_id } : {}), ...(already ? { already_built: true } : {}), next: afterReady() };
    }
    case "needs_human": {
      const n = p.needs_human!;
      return { status: "needs_human", reason: n.reason, url: n.url, command: n.command, why: n.why, ...base, next: `a person runs this in a terminal on this Mac: ${n.command}; then ${BUILD} --wait --json to follow the build` };
    }
    case "blocked":
      return { status: "blocked", ...base, ...(p.error ? { error: p.error } : {}), ...(p.checks ? { checks: p.checks } : {}), next: p.error?.fix ?? `${BUILD} --check` };
    case "failed":
      return { status: "failed", ...base, ...(p.error ? { error: p.error } : {}), next: `${BUILD} --yes` };
    case "waiting":
      return { status: "waiting", ...base, ...(p.waiting ? { waiting: p.waiting } : {}), next: `${BUILD} --wait --json` };
    case "idle":
      return { status: "building", ...base, next: `${BUILD} --yes` };
    default:
      return { status: "building", ...base, next: `${BUILD} --wait --json` };
  }
}

const settled = (s: ImageBuildStatus) => s !== "building" && s !== "waiting";

/**
 * Checks this Mac and, unless --check, starts the build or follows the one running. Without --wait it returns
 * at once with the current step, so a coding agent's call never hangs; --wait follows it until it is ready,
 * fails, or needs the person (`onProgress` gets each change).
 */
export async function runImageBuild(opts: ImageBuildOptions, deps: ImageDeps = defaultDeps(), onProgress?: (p: ImageProgress) => void): Promise<ImageBuildResult> {
  if (deps.platform !== "darwin") throw new CliError("NOT_A_MAC", "the macOS image is built on a Mac with Apple silicon; Linux images download on their own", "buildhound runner status", EXIT.usage);

  if (opts.check) {
    let report: ImageReport | null = null;
    try {
      report = (await ask(deps, "GET", "/image/checks")) as ImageReport;
    } catch (e) {
      // Not running yet: the installed binary checks the same things without the service.
      if (!(e instanceof CliError) || (e.code !== "AGENT_NOT_RUNNING" && e.code !== "NOT_CONNECTED")) throw e;
      report = await deps.checkWithBinary();
      if (!report) throw e;
    }
    const fix = report.checks.find((c) => c.status === "fail")?.fix;
    return {
      status: "checked",
      steps: 9,
      checks: report.checks,
      need_bytes: report.need_bytes,
      free_bytes: report.free_bytes,
      restore_image: report.restore_image,
      macos: report.macos,
      xcodes: report.xcodes.map((x) => x.version),
      ...(report.current ? { image_id: report.current } : {}),
      already_built: report.built,
      next: !report.ok ? fix ?? `${BUILD} --check` : report.built ? `${BUILD} --rebuild --yes (only to build it again)` : `${BUILD} --yes`,
    };
  }

  // A build already under way is followed, never started twice.
  let p = (await ask(deps, "GET", "/image/build")) as ImageProgress;
  const active = p.state === "running" || p.state === "needs_human" || p.state === "waiting";
  if (!active) {
    if (!opts.rebuild) {
      // Built already for this Xcode: nothing to start and nothing to confirm.
      const report = (await ask(deps, "GET", "/image/checks")) as ImageReport;
      if (report.built) {
        p = (await ask(deps, "POST", "/image/build", { rebuild: false })) as ImageProgress;
        return toResult(p);
      }
    }
    await confirm(opts.yes, `Build the macOS image on this Mac? It downloads Apple's restore image once (about 27 GB), takes about 30 minutes, and asks for your password once.`, `${BUILD}${opts.rebuild ? " --rebuild" : ""}`);
    p = (await ask(deps, "POST", "/image/build", { rebuild: Boolean(opts.rebuild) })) as ImageProgress;
  }
  let result = toResult(p);
  if (!opts.wait) return result;
  onProgress?.(p);
  let last = JSON.stringify(progressEvent(p));
  while (!settled(result.status)) {
    await deps.sleep(1000);
    p = (await ask(deps, "GET", "/image/build")) as ImageProgress;
    result = toResult(p);
    const now = JSON.stringify(progressEvent(p));
    if (now !== last || process.stderr.isTTY) onProgress?.(p);
    last = now;
  }
  return result;
}

export function prettyImageBuild(r: ImageBuildResult): string {
  const lines: string[] = [];
  switch (r.status) {
    case "checked":
      for (const c of r.checks ?? []) {
        const mark = c.status === "ok" ? color.green(SYMBOLS.done) : c.status === "warn" ? color.yellow(SYMBOLS.needed) : color.red(SYMBOLS.failed);
        lines.push(`${mark} ${c.title}`);
        if (c.status !== "ok" && c.fix) lines.push(`  ${c.fix}`);
      }
      if (r.restore_image) lines.push("", color.dim(`Apple's restore image: ${r.restore_image}`));
      break;
    case "ready":
      lines.push(done(r.already_built ? `The macOS image already has Xcode ${r.xcodes?.join(", ") ?? ""}: nothing to build` : "macOS image ready. macOS jobs now run on this Mac."), ...(r.image_id ? [color.dim(`  ${r.image_id}`)] : []));
      break;
    case "needs_human":
      lines.push(...passwordLines({ reason: r.reason ?? "", why: r.why ?? "", command: r.command ?? "", url: r.url ?? "" }));
      return [...lines, "", nextLine(`${BUILD} (to follow it again)`)].join("\n");
    case "blocked":
      for (const c of r.checks ?? []) if (c.status === "fail") lines.push(failed(c.title), ...(c.fix ? [`  ${c.fix}`] : []));
      lines.push("", "Nothing was changed. Fix the above, then run the same command again.");
      return [...lines, "", nextLine(`${BUILD} --check`)].join("\n");
    case "failed":
      lines.push(failed(r.error?.message ?? "The build stopped"), `  ${r.error?.fix ?? "Run the same command again: it continues where it stopped."}`);
      break;
    default:
      lines.push(`The build continues in the background: step ${r.step_number ?? 1} of ${r.steps}, ${r.title ?? ""}${r.waiting ? `. ${r.waiting}` : ""}.`, "Your macOS jobs run on GitHub-hosted until it finishes.");
      return [...lines, "", nextLine(BUILD)].join("\n");
  }
  return [...lines, "", nextLine(r.next)].join("\n");
}

/** Redraws the live view on stderr: only the running step moves. */
function liveRenderer(): { draw: (p: ImageProgress) => void; clear: () => void } {
  let drawn = 0;
  let frame = 0;
  let lastP: ImageProgress | null = null;
  let stopped = false;
  const paint = () => {
    if (!lastP) return;
    const lines = liveLines(lastP, frame++, Math.min(process.stderr.columns || 80, 80) - 8);
    process.stderr.write((drawn ? `\x1b[${drawn}A\x1b[0J` : "") + lines.join("\n") + "\n");
    drawn = lines.length;
  };
  const timer = setInterval(paint, 120);
  return {
    draw: (p) => {
      lastP = p;
      paint();
    },
    clear: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      paint();
    },
  };
}

/** `buildhound image build` as a command: the live view for a person, JSON (and progress lines with --wait) for coding agents. */
export async function imageBuildAction(opts: ImageBuildOptions): Promise<void> {
  const asJson = wantsJson(opts);
  if (asJson) {
    // Coding agents: progress lines with --wait, then the result as the last line.
    const r = await runImageBuild(opts, undefined, opts.wait ? (p) => process.stdout.write(JSON.stringify(progressEvent(p)) + "\n") : undefined);
    emit(r, opts);
    if (r.status === "blocked" || r.status === "failed" || (r.status === "checked" && r.checks?.some((c) => c.status === "fail"))) process.exitCode = EXIT.findings;
    return;
  }
  // A person in a terminal: the live view, unless only checking.
  const live = opts.check ? null : liveRenderer();
  const stop = () => {
    live?.clear();
    process.stderr.write("\nThe build continues in the background. Follow it again with: buildhound image build\n");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  try {
    const r = await runImageBuild({ ...opts, wait: !opts.check }, undefined, live?.draw);
    live?.clear();
    if (live) process.stderr.write("\n");
    emit(r, opts, prettyImageBuild);
    if (r.status === "blocked" || r.status === "failed" || (r.status === "checked" && r.checks?.some((c) => c.status === "fail"))) process.exitCode = EXIT.findings;
  } finally {
    process.removeListener("SIGINT", stop);
    live?.clear();
  }
}

export function imageCommand(): Command {
  const image = new Command("image").description("The macOS image macOS jobs run in, built on this Mac from Apple's restore image and this Mac's Xcode");
  image.addCommand(
    new Command("build")
      .description("Check this Mac and build the macOS image in the background: restore image, macOS install, one password step, Xcode and simulators, tools, warm-up, verify, then macOS jobs turn on. Running it again follows or continues the build")
      .option("--check", "only check this Mac and say what to fix; changes nothing")
      .option("--rebuild", "build a new image even when the one in use already has this Mac's Xcode")
      .option("--wait", "follow the build until it is ready, fails or needs your password; without a terminal, one JSON progress line per change")
      .option("--yes", "start the build without asking; required when there is no TTY")
      .option("--json", "JSON output")
      .action(imageBuildAction),
  );
  return image;
}
