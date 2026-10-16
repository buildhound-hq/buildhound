import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installService, launchdPlist, removeService, systemdSystemUnit, type ServiceExecutor } from "./lib/service";

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

  it("installs a Linux host's agent as a hardened system service and removes that one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bh-systemd-"));
    process.env.BUILDHOUND_SYSTEMD_DIR = dir;
    process.env.BUILDHOUND_HOME_DIR = mkdtempSync(path.join(tmpdir(), "bh-svc-"));
    const spec = { os: "linux" as const, binary: "/var/lib/buildhound/bin/buildhound-agent", home: "/var/lib/buildhound", logPath: "/l", system: true };
    const unit = systemdSystemUnit(spec);
    for (const line of ["ExecStart=/var/lib/buildhound/bin/buildhound-agent run --home /var/lib/buildhound", "Delegate=yes", "ProtectSystem=strict", "ReadWritePaths=/var/lib/buildhound", "ProtectHome=yes", "TimeoutStopSec=660", "WantedBy=multi-user.target"]) {
      expect(unit).toContain(line);
    }
    const first = fakeExec(false);
    const r = installService(spec, first.exec);
    expect(r).toMatchObject({ status: "done", detail: "started (systemd system service)", file: path.join(dir, "buildhound-agent.service") });
    expect(readFileSync(path.join(dir, "buildhound-agent.service"), "utf8")).toBe(unit);
    // System scope: no --user anywhere.
    expect(first.calls).toEqual(["daemon-reload", "enable --now buildhound-agent", "restart buildhound-agent"]);
    const idle = fakeExec(true);
    expect(installService(spec, idle.exec).detail).toBe("already running (systemd system service)");
    const removed = removeService("linux", fakeExec(true).exec);
    expect(removed).toMatchObject({ status: "done", file: path.join(dir, "buildhound-agent.service") });
    expect(existsSync(path.join(dir, "buildhound-agent.service"))).toBe(false);
    delete process.env.BUILDHOUND_SYSTEMD_DIR;
    delete process.env.BUILDHOUND_HOME_DIR;
  });
});
