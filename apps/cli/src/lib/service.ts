import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { which } from "./exec";

/** Shell access the service layer needs, injectable so tests never reach launchctl or systemctl. */
export interface ServiceExecutor {
  which(name: string): string | null;
  run(bin: string, args: string[]): { ok: boolean; output: string };
}

export const defaultExecutor: ServiceExecutor = {
  which,
  run(bin, args) {
    try {
      return { ok: true, output: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: (err.stderr || err.stdout || err.message || "").trim() };
    }
  },
};

export interface ServiceSpec {
  os: "macos" | "linux";
  binary: string;
  home: string;
  logPath: string;
}

export interface ServiceResult {
  status: "done" | "skipped";
  /** One line for the `service` field of the command output, for example "skipped (launchctl not found)". */
  detail: string;
  file: string | null;
}

export const LAUNCHD_LABEL = "sh.buildhound.agent";
export const SYSTEMD_UNIT = "buildhound-agent";

const userHome = (): string => process.env.BUILDHOUND_HOME_DIR || homedir();
export const launchdPlistPath = (): string => path.join(userHome(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const systemdUnitPath = (): string => path.join(userHome(), ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.binary)}</string>
    <string>run</string>
    <string>--home</string>
    <string>${xml(spec.home)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BUILDHOUND_AGENT_HOME</key><string>${xml(spec.home)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(spec.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <!-- On stop the agent drains running jobs for up to 10 minutes; launchd's default 20 seconds would kill them. -->
  <key>ExitTimeOut</key><integer>660</integer>
  <key>StandardOutPath</key><string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Buildhound machine agent
After=network-online.target

[Service]
ExecStart=${spec.binary} run --home ${spec.home}
Environment=BUILDHOUND_AGENT_HOME=${spec.home}
WorkingDirectory=${spec.home}
Restart=always
RestartSec=5
# On stop the agent drains running jobs for up to 10 minutes; the default 90 seconds would kill them.
TimeoutStopSec=660
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

function writeIfChanged(file: string, content: string): boolean {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  writeFileSync(file, content, { mode: 0o644 });
  return true;
}

const uid = (): string => String(typeof process.getuid === "function" ? process.getuid() : 501);

/** Write the service definition and start it. Without launchctl or systemctl on PATH the start is skipped, never a failure. */
export function installService(spec: ServiceSpec, exec: ServiceExecutor = defaultExecutor): ServiceResult {
  if (spec.os === "macos") {
    const file = launchdPlistPath();
    const changed = writeIfChanged(file, launchdPlist(spec));
    const launchctl = exec.which("launchctl");
    if (!launchctl) return { status: "skipped", detail: "skipped (launchctl not found)", file };
    const domain = `gui/${uid()}`;
    if (!changed && exec.run(launchctl, ["print", `${domain}/${LAUNCHD_LABEL}`]).ok) return { status: "skipped", detail: "already running (launchd)", file };
    if (changed) exec.run(launchctl, ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    const boot = exec.run(launchctl, ["bootstrap", domain, file]);
    if (boot.ok) return { status: "done", detail: "started (launchd bootstrap)", file };
    const load = exec.run(launchctl, ["load", "-w", file]);
    if (load.ok) return { status: "done", detail: "started (launchd load)", file };
    return { status: "skipped", detail: `skipped (launchctl failed: ${boot.output || load.output || "unknown error"})`, file };
  }
  const file = systemdUnitPath();
  const changed = writeIfChanged(file, systemdUnit(spec));
  const systemctl = exec.which("systemctl");
  if (!systemctl) return { status: "skipped", detail: "skipped (systemctl not found)", file };
  if (!changed && exec.run(systemctl, ["--user", "is-active", "--quiet", SYSTEMD_UNIT]).ok) return { status: "skipped", detail: "already running (systemd)", file };
  exec.run(systemctl, ["--user", "daemon-reload"]);
  const r = exec.run(systemctl, ["--user", "enable", "--now", SYSTEMD_UNIT]);
  if (changed && r.ok) exec.run(systemctl, ["--user", "restart", SYSTEMD_UNIT]);
  return r.ok ? { status: "done", detail: "started (systemd user unit)", file } : { status: "skipped", detail: `skipped (systemctl failed: ${r.output || "unknown error"})`, file };
}

/** Stop the service and delete its definition. Missing tools or files are reported, not thrown. */
export function removeService(os: "macos" | "linux", exec: ServiceExecutor = defaultExecutor): ServiceResult {
  if (os === "macos") {
    const file = launchdPlistPath();
    const launchctl = exec.which("launchctl");
    let detail = "skipped (launchctl not found)";
    if (launchctl) {
      const out = exec.run(launchctl, ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      detail = out.ok || exec.run(launchctl, ["unload", file]).ok ? "stopped (launchd)" : "not loaded (launchd)";
    }
    if (!existsSync(file)) return { status: "skipped", detail: launchctl ? "not installed" : detail, file: null };
    rmSync(file, { force: true });
    return { status: "done", detail: `${detail}, plist removed`, file };
  }
  const file = systemdUnitPath();
  const systemctl = exec.which("systemctl");
  let detail = "skipped (systemctl not found)";
  if (systemctl) detail = exec.run(systemctl, ["--user", "disable", "--now", SYSTEMD_UNIT]).ok ? "stopped (systemd)" : "not active (systemd)";
  if (!existsSync(file)) return { status: "skipped", detail: systemctl ? "not installed" : detail, file: null };
  rmSync(file, { force: true });
  if (systemctl) exec.run(systemctl, ["--user", "daemon-reload"]);
  return { status: "done", detail: `${detail}, unit removed`, file };
}
