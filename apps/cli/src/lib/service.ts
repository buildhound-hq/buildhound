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
  /** The agent's config or binary changed: restart a running agent so it picks them up. */
  restart?: boolean;
  /**
   * Linux: a system service under /etc/systemd/system, which a Linux host needs since its job VMs need root (B12;
   * RUNNERS.md, Linux hosts); the default when running as root. Otherwise a user unit, as the dogfood flag used.
   */
  system?: boolean;
}

/** Blocks for `ms`; the CLI is synchronous here and only waits for a service to finish stopping. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
/** The system unit a Linux host runs the agent from, as root (B12). BUILDHOUND_SYSTEMD_DIR moves it in tests. */
export const systemdSystemUnitPath = (): string => path.join(process.env.BUILDHOUND_SYSTEMD_DIR || "/etc/systemd/system", `${SYSTEMD_UNIT}.service`);

/** Whether this process is root: a Linux host's `runner add` runs that way once, for the system service. */
export const isRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

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
  <!-- Standard, not Background: launchd's background class kept image installs on the efficiency cores with throttled disk, 205 s against 57 s for the same unpack on battery (B02.1). An idle agent waits on the network, so Standard costs no measurable energy. -->
  <key>ProcessType</key><string>Standard</string>
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
Description=Buildhound agent
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

/**
 * The system unit for a Linux host (RUNNERS.md, Linux hosts; SECURITY.md). Root, because the job VMs need it: KVM,
 * the taps and nftables rules, IPv4 forwarding, the jailer's chroot, users and cgroups. systemd's sandboxing keeps
 * the rest of the machine away: the home is the only writable path besides the kernel's own trees, the agent's
 * cgroup subtree is delegated for the VMs' limits, and the VM processes drop to users of their own.
 */
export function systemdSystemUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Buildhound agent
Documentation=https://buildhound.sh/docs/machines#linux
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.binary} run --home ${spec.home}
Environment=BUILDHOUND_AGENT_HOME=${spec.home}
WorkingDirectory=${spec.home}
Restart=always
RestartSec=5
# On stop the agent drains running jobs for up to 10 minutes; the default 90 seconds would kill them.
TimeoutStopSec=660
KillMode=mixed
# Each job VM gets a cgroup of its own, under the agent's, with memory and process limits.
Delegate=yes
# Nothing outside the agent's home is written: not the system, not anyone's home.
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=${spec.home}
PrivateTmp=yes
NoNewPrivileges=no
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
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
    const running = exec.run(launchctl, ["print", `${domain}/${LAUNCHD_LABEL}`]).ok;
    if (!changed && running) {
      if (!spec.restart) return { status: "skipped", detail: "already running (launchd)", file };
      // SIGTERM lets the agent drain running jobs before launchd starts it again.
      const kick = exec.run(launchctl, ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
      return kick.ok ? { status: "done", detail: "restarted to pick up the new config (launchd)", file } : { status: "skipped", detail: `skipped (launchctl kickstart failed: ${kick.output || "unknown error"})`, file };
    }
    if (changed && running) {
      exec.run(launchctl, ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      // bootout returns before the old agent has drained; bootstrap fails until it has.
      for (let i = 0; i < 30 && exec.run(launchctl, ["print", `${domain}/${LAUNCHD_LABEL}`]).ok; i++) pause(1000);
    }
    const boot = exec.run(launchctl, ["bootstrap", domain, file]);
    if (boot.ok) return { status: "done", detail: "started (launchd bootstrap)", file };
    const load = exec.run(launchctl, ["load", "-w", file]);
    if (load.ok) return { status: "done", detail: "started (launchd load)", file };
    return { status: "skipped", detail: `skipped (launchctl failed: ${boot.output || load.output || "unknown error"})`, file };
  }
  const system = spec.system ?? isRoot();
  const file = system ? systemdSystemUnitPath() : systemdUnitPath();
  const changed = writeIfChanged(file, system ? systemdSystemUnit(spec) : systemdUnit(spec));
  const systemctl = exec.which("systemctl");
  if (!systemctl) return { status: "skipped", detail: "skipped (systemctl not found)", file };
  const scope = system ? [] : ["--user"];
  const kind = system ? "systemd system service" : "systemd user unit";
  if (!changed && exec.run(systemctl, [...scope, "is-active", "--quiet", SYSTEMD_UNIT]).ok) {
    if (!spec.restart) return { status: "skipped", detail: `already running (${kind})`, file };
    const r = exec.run(systemctl, [...scope, "restart", SYSTEMD_UNIT]);
    return r.ok ? { status: "done", detail: `restarted to pick up the new config (${kind})`, file } : { status: "skipped", detail: `skipped (systemctl restart failed: ${r.output || "unknown error"})`, file };
  }
  exec.run(systemctl, [...scope, "daemon-reload"]);
  const r = exec.run(systemctl, [...scope, "enable", "--now", SYSTEMD_UNIT]);
  if (changed && r.ok) exec.run(systemctl, [...scope, "restart", SYSTEMD_UNIT]);
  return r.ok ? { status: "done", detail: `started (${kind})`, file } : { status: "skipped", detail: `skipped (systemctl failed: ${r.output || "unknown error"})`, file };
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
  // The system unit when there is one (a Linux host, removed as root); else the user unit.
  const system = existsSync(systemdSystemUnitPath());
  const file = system ? systemdSystemUnitPath() : systemdUnitPath();
  const scope = system ? [] : ["--user"];
  const systemctl = exec.which("systemctl");
  let detail = "skipped (systemctl not found)";
  if (systemctl) detail = exec.run(systemctl, [...scope, "disable", "--now", SYSTEMD_UNIT]).ok ? "stopped (systemd)" : "not active (systemd)";
  if (!existsSync(file)) return { status: "skipped", detail: systemctl ? "not installed" : detail, file: null };
  rmSync(file, { force: true });
  if (systemctl) exec.run(systemctl, [...scope, "daemon-reload"]);
  return { status: "done", detail: `${detail}, unit removed`, file };
}
