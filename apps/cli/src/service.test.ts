import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installService, launchdPlist, type ServiceExecutor } from "./lib/service";

function fakeExec(running: boolean) {
  const calls: string[] = [];
  const exec: ServiceExecutor = {
    which: (name) => `/bin/${name}`,
    run: (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "print") return { ok: running, output: "" };
      return { ok: true, output: "" };
    },
  };
  return { exec, calls };
}

describe("agent service", () => {
  it("lets the agent drain for ten minutes before launchd kills it", () => {
    const plist = launchdPlist({ os: "macos", binary: "/b", home: "/h", logPath: "/l" });
    expect(plist).toContain("<key>ExitTimeOut</key><integer>660</integer>");
  });

  it("restarts a running agent when its config changed, and leaves it alone otherwise", () => {
    process.env.BUILDHOUND_HOME_DIR = mkdtempSync(path.join(tmpdir(), "bh-svc-"));
    const spec = { os: "macos" as const, binary: "/b", home: "/h", logPath: "/l" };
    installService(spec, fakeExec(false).exec); // writes the plist once
    const idle = fakeExec(true);
    expect(installService(spec, idle.exec).detail).toBe("already running (launchd)");
    expect(idle.calls.some((c) => c.startsWith("kickstart"))).toBe(false);
    const changed = fakeExec(true);
    const r = installService({ ...spec, restart: true }, changed.exec);
    expect(r.detail).toBe("restarted to pick up the new config (launchd)");
    expect(changed.calls.some((c) => c.startsWith("kickstart -k"))).toBe(true);
    delete process.env.BUILDHOUND_HOME_DIR;
  });
});
