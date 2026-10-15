import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prettyImageBuild, runImageBuild, toResult, type ImageDeps } from "./commands/image";
import { imageBuildLine, liveLines, progressEvent, timeLeft, type ImageProgress, type ImageReport } from "./lib/image-progress";
import { stripAnsi } from "./lib/style";
import { withMacImage } from "./lib/image-offer";

const STEPS = ["checks", "restore_image", "macos_install", "password", "xcode", "tools", "simulator_warmup", "verify", "activate"];

function progress(state: ImageProgress["state"], upTo: number, extra: Partial<ImageProgress> = {}): ImageProgress {
  return {
    state,
    steps: 9,
    step: STEPS[upTo],
    step_number: upTo + 1,
    title: "Copying Xcode 27.0",
    next_step: "Installing tools",
    percent: 68,
    seconds_left: 120,
    total_seconds_left: 900,
    macos: "27.0.1",
    xcodes: ["27.0"],
    stages: STEPS.map((id, i) => ({ id, title: id, status: i < upTo ? "done" : i === upTo ? "running" : "pending", percent: i < upTo ? 100 : i === upTo ? 68 : 0, ...(i < upTo ? { seconds: 65 } : {}) })),
    ...extra,
  } as ImageProgress;
}

const report = (built: boolean, ok = true): ImageReport => ({
  ok,
  built,
  checks: ok ? [{ id: "xcode", status: "ok", title: "Xcode 27.0" }] : [{ id: "simulators", status: "fail", title: "No iOS simulator runtime is installed", fix: "xcodebuild -downloadPlatform iOS" }],
  need_bytes: 68e9,
  free_bytes: 200e9,
  macos: "27.0.1",
  xcodes: [{ path: "/Applications/Xcode.app", version: "27.0", bytes: 1e10 }],
  runtimes: [],
  restore_image: "will download 26.6 GB",
  ...(built ? { current: "macos-27.0.1-xcode-27.0-202610072043" } : {}),
});

/** A fake agent: answers from a script of states and records what was asked. */
function fakeAgent(states: ImageProgress[], checks: ImageReport, opts: { throwOn?: RegExp; old?: boolean } = {}) {
  const calls: string[] = [];
  let i = 0;
  const deps: ImageDeps = {
    platform: "darwin",
    sleep: async () => {},
    checkWithBinary: async () => ({ ...checks, restore_image: "from the binary" }),
    request: async (method, route, body) => {
      calls.push(`${method} ${route}${body ? ` ${JSON.stringify(body)}` : ""}`);
      if (opts.throwOn?.test(route)) throw new Error("connect ENOENT agent.sock");
      if (opts.old) return { status: 404, body: { text: "404 page not found" } };
      if (route === "/image/checks") return { status: 200, body: checks };
      const s = states[Math.min(i, states.length - 1)]!;
      if (method === "GET") i++;
      return { status: 200, body: method === "POST" ? states[Math.min(i, states.length - 1)] : s };
    },
  };
  return { deps, calls };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "bh-image-"));
  process.env.BUILDHOUND_AGENT_HOME = home;
});
afterEach(() => {
  delete process.env.BUILDHOUND_AGENT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("image build", () => {
  it("agentfirst: refuses on a machine that is not a Mac, with next", async () => {
    const { deps } = fakeAgent([], report(false));
    await expect(runImageBuild({ yes: true }, { ...deps, platform: "linux" })).rejects.toMatchObject({ code: "NOT_A_MAC", next: expect.any(String) });
  });

  it("agentfirst: --check asks the agent, or the installed binary when the agent is not running, and changes nothing", async () => {
    const { deps, calls } = fakeAgent([], report(false, false));
    const r = await runImageBuild({ check: true }, deps);
    expect(r).toMatchObject({ status: "checked", next: "xcodebuild -downloadPlatform iOS", restore_image: "will download 26.6 GB" });
    expect(calls).toEqual(["GET /image/checks"]);
    const down = fakeAgent([], report(false), { throwOn: /checks/ });
    expect(await runImageBuild({ check: true }, down.deps)).toMatchObject({ status: "checked", restore_image: "from the binary", next: "buildhound image build --yes" });
  });

  it("agentfirst: an image that already has this Mac's Xcode is ready without confirming or building", async () => {
    const ready = progress("ready", 8, { image_id: "macos-27.0.1-xcode-27.0-202610072043" });
    ready.stages = ready.stages.map((s) => ({ ...s, status: s.id === "checks" ? "done" : "skipped", percent: 100 }));
    const { deps, calls } = fakeAgent([progress("idle", 0), ready], report(true));
    const r = await runImageBuild({}, deps);
    expect(r).toMatchObject({ status: "ready", already_built: true, image_id: "macos-27.0.1-xcode-27.0-202610072043", next: "buildhound runner status" });
    expect(calls).toEqual(["GET /image/build", "GET /image/checks", 'POST /image/build {"rebuild":false}']);
  });

  it("agentfirst: starting a build needs --yes without a TTY; with it, it starts and returns at once", async () => {
    const { deps, calls } = fakeAgent([progress("idle", 0), progress("running", 1)], report(false));
    await expect(runImageBuild({}, deps)).rejects.toMatchObject({ code: "CONFIRM_REQUIRED", next: "buildhound image build --yes" });
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
    const r = await runImageBuild({ yes: true, rebuild: true }, fakeAgent([progress("idle", 0), progress("running", 1)], report(false)).deps);
    expect(r).toMatchObject({ status: "building", step: "restore_image", step_number: 2, steps: 9, next: "buildhound image build --wait --json" });
  });

  it("agentfirst: a build already running is followed, never started again or confirmed", async () => {
    const { deps, calls } = fakeAgent([progress("running", 4)], report(false));
    const r = await runImageBuild({}, deps);
    expect(r).toMatchObject({ status: "building", step: "xcode", percent: 68, seconds_left: 120 });
    expect(calls).toEqual(["GET /image/build"]);
  });

  it("agentfirst: --wait follows the build to the password step and returns needs_human with the command", async () => {
    const needs = progress("needs_human", 3, { needs_human: { reason: "password_needed", why: "Your password is needed once", command: "sudo /Users/me/.buildhound/bin/buildhound-agent image prepare --bundle /Users/me/.buildhound/images/macos-arm64/build-26A434", url: "https://buildhound.sh/docs/macos-image" } });
    const { deps } = fakeAgent([progress("running", 1), progress("running", 2), needs], report(false));
    const events: unknown[] = [];
    const r = await runImageBuild({ wait: true, yes: true }, deps, (p) => events.push(progressEvent(p)));
    expect(r).toMatchObject({ status: "needs_human", reason: "password_needed", url: "https://buildhound.sh/docs/macos-image", command: expect.stringMatching(/^sudo .* image prepare --bundle /) });
    expect(r.next).toContain("a person runs this in a terminal on this Mac: sudo");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ event: "progress", step: "restore_image", step_number: 2, steps: 9 });
    expect(prettyImageBuild(r)).toContain(`\n  ${r.command}\n`);
  });

  it("agentfirst: an agent from before image builds says how to update it", async () => {
    const { deps } = fakeAgent([], report(false), { old: true });
    await expect(runImageBuild({}, deps)).rejects.toMatchObject({ code: "AGENT_TOO_OLD", next: expect.stringContaining("buildhound runner add") });
  });

  it("a failed or blocked build carries the fix as next", () => {
    expect(toResult(progress("failed", 2, { error: { code: "INSTALL_FAILED", message: "Installing macOS failed", fix: "Run the same command again" } }))).toMatchObject({ status: "failed", next: "buildhound image build --yes" });
    expect(toResult(progress("blocked", 0, { error: { code: "CHECKS_FAILED", message: "No iOS simulator runtime is installed", fix: "xcodebuild -downloadPlatform iOS" } }))).toMatchObject({ status: "blocked", next: "xcodebuild -downloadPlatform iOS" });
  });
});

describe("runner add and the macOS image", () => {
  const added = { status: "ready", os: "macos", arch: "arm64", scale_sets: [{ label: "buildhound-linux" }, { label: "buildhound-macos" }], next: "buildhound route --repo <owner/name>" };
  it("agentfirst: on a Mac serving macOS jobs with no image, next is the image build and the route step follows as then", () => {
    expect(withMacImage(added)).toMatchObject({ next: "buildhound image build --yes", then: "buildhound route --repo <owner/name>", macos_image: { status: "missing", note: expect.stringContaining("Linux jobs run on this Mac now") } });
  });
  it("leaves next alone once the image is built, on Linux-only machines and on Linux hosts", () => {
    const dir = path.join(home, "images", "macos-arm64", "current");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    expect(withMacImage(added)).toMatchObject({ next: "buildhound route --repo <owner/name>", macos_image: { status: "ready" } });
    expect(withMacImage({ ...added, scale_sets: [{ label: "buildhound-linux" }] })).toEqual({ ...added, scale_sets: [{ label: "buildhound-linux" }] });
    expect(withMacImage({ ...added, os: "linux" }).next).toBe("buildhound route --repo <owner/name>");
  });
});

describe("image build output for people", () => {
  it("finished steps stay as one quiet line with their time; only the running step shows percent and time left; no pending steps", () => {
    const lines = liveLines(progress("running", 4)).map(stripAnsi);
    expect(lines[0]).toBe("Building the macOS image for this Mac (macOS 27.0.1, Xcode 27.0)");
    expect(lines.filter((l) => l.startsWith("✓ "))).toHaveLength(4);
    expect(lines.find((l) => l.startsWith("✓ Installed macOS"))).toMatch(/1m 5s$/);
    expect(lines.find((l) => l.includes("Copying Xcode 27.0"))).toMatch(/68%\s+about 2 min left$/);
    expect(lines.some((l) => l.includes("Installing tools") && l.startsWith("Step 5 of 9"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/Warmed|Verified|·|\|/);
  });

  it("says when it waits for power", () => {
    const lines = liveLines(progress("waiting", 4, { waiting: "Plug in this Mac: the build continues when it is on power" })).map(stripAnsi);
    expect(lines).toContain("! Plug in this Mac: the build continues when it is on power");
  });

  it("runner status --local says the build's step in one line", async () => {
    const { prettyRunnerStatus } = await import("./commands/runner-status");
    const out = stripAnsi(prettyRunnerStatus({ local: true, socket: "/tmp/agent.sock", machine_id: "m_7", agent: { state: "online", imageBuild: { state: "running", step: "xcode", step_number: 5, steps: 9, title: "Copying Xcode 27.0", percent: 68, total_seconds_left: 900 } }, next: "buildhound runner status --org acme" }));
    expect(out).toContain("macOS image: building, step 5 of 9 (Copying Xcode 27.0, 68%), about 15 min left");
    expect(out).not.toContain("imageBuild");
    expect(imageBuildLine({ state: "needs_human", step_number: 4, command: "sudo x image prepare --bundle y" })).toBe("macOS image: your password is needed once. Run this in a terminal on this Mac: sudo x image prepare --bundle y");
    expect(imageBuildLine(undefined)).toBe("");
  });

  it("time left in plain words", () => {
    expect([timeLeft(-1), timeLeft(20), timeLeft(130), timeLeft(3900)]).toEqual(["", "under a minute left", "about 2 min left", "about 1 h 5 min left"]);
  });
});

describe("agentfirst: image build without a TTY", () => {
  const run = promisify(execFile);
  const bin = inject("cliBin");
  it("agentfirst: image build with no agent prints one JSON error with next", async () => {
    let stdout = "";
    try {
      ({ stdout } = await run(process.execPath, [bin, "image", "build", "--yes"], { env: { ...process.env, BUILDHOUND_AGENT_HOME: home } }));
    } catch (e) {
      stdout = (e as { stdout: string }).stdout;
    }
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!) as { error: { code: string; next: string } };
    expect(["NOT_CONNECTED", "NOT_A_MAC"]).toContain(obj.error.code);
    expect(obj.error.next).toBeTruthy();
  });
});
