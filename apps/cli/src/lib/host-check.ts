import { accessSync, constants, existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { arch as nodeArch, availableParallelism, homedir, release, totalmem } from "node:os";
import path from "node:path";
import { CONTAINER_ISOLATION_WARNING } from "@buildhound/shared";
import { runQuiet, which } from "./exec";

/**
 * `runner add --check`: whether this machine can run Buildhound's job VMs, read only. On Linux the same checks as
 * the Buildhound agent's (`apps/agent/internal/linuxhost`, B12): KVM, cores, memory, disk, cgroup v2, systemd, the
 * kernel, and the ip and nft tools for the job VMs' isolated network. On a Mac: Apple silicon, memory and disk.
 * Without KVM a Linux host can still connect with container isolation when Sysbox is installed and running: each
 * job then runs in a Sysbox system container instead of a microVM (RUNNERS.md, Linux hosts, no KVM).
 */

export type CheckStatus = "ok" | "warn" | "fail";

/** How a machine runs each job: a VM (a Firecracker microVM on Linux, Apple's framework on a Mac) or a Sysbox container. */
export type Isolation = "vm" | "container";

/** What the machine says about Sysbox (https://github.com/nestybox/sysbox), the fallback without KVM. */
export interface SysboxState {
  /** sysbox-runc is installed. */
  runc: boolean;
  /** From `sysbox-runc --version`; empty when it did not answer. */
  version: string;
  /** systemctl is-active sysbox-mgr and sysbox-fs. */
  mgr: boolean;
  fs: boolean;
  /** Docker is installed: Sysbox registers its runtime there and the Buildhound agent starts containers through it. */
  docker: boolean;
}

export const SYSBOX_INSTALL = "install Sysbox from nestybox's packages (https://github.com/nestybox/sysbox/releases: sudo apt-get install -y ./sysbox-ce_<version>.deb), which needs Docker, then check again";

const sysboxWorks = (s: SysboxState): boolean => s.runc && s.version !== "" && s.mgr && s.fs && s.docker;

export interface HostCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: string;
}

/** What the checks read. `systemProbe` reads this machine; tests pass their own. */
export interface HostProbe {
  os: "macos" | "linux";
  arch: string;
  /** Linux: whether /dev/kvm exists, and the error opening it for read and write, if any. */
  kvm: () => { exists: boolean; error?: string };
  /** The flags (x86) or Features (arm64) line of /proc/cpuinfo. */
  cpuFlags: () => string;
  cpus: number;
  memoryMiB: number;
  freeDisk: (dir: string) => number | null;
  cgroupV2: () => boolean;
  systemd: () => boolean;
  kernel: string;
  has: (cmd: string) => boolean;
  root: boolean;
  /** Linux: Sysbox's state, read only when there is no KVM. */
  sysbox: () => SysboxState;
}

const GB = 2 ** 30;
const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

/** Where the Buildhound agent keeps images and job disks: its system service's home on Linux, ~/.buildhound on a Mac. */
export function dataDir(os: "macos" | "linux"): string {
  return os === "linux" ? "/var/lib/buildhound" : path.join(homedir(), ".buildhound");
}

function nearestExisting(dir: string): string {
  let d = dir;
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

export function systemProbe(os: "macos" | "linux"): HostProbe {
  const forced = process.env.BUILDHOUND_TEST_HOST_PROBE;
  if (forced) return fakeProbe(os, JSON.parse(forced) as Partial<Record<string, unknown>>);
  return {
    os,
    arch: nodeArch(),
    kvm: () => {
      if (!existsSync("/dev/kvm")) return { exists: false };
      try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
        return { exists: true };
      } catch (e) {
        return { exists: true, error: (e as Error).message };
      }
    },
    cpuFlags: () => {
      try {
        const line = readFileSync("/proc/cpuinfo", "utf8").split("\n").find((l) => /^(flags|Features)\s*:/.test(l));
        return line ? line.slice(line.indexOf(":") + 1).trim() : "";
      } catch {
        return "";
      }
    },
    cpus: availableParallelism(),
    memoryMiB: Math.round(totalmem() / 2 ** 20),
    freeDisk: (dir) => {
      try {
        const s = statfsSync(nearestExisting(dir));
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
    cgroupV2: () => existsSync("/sys/fs/cgroup/cgroup.controllers"),
    systemd: () => {
      try {
        return statSync("/run/systemd/system").isDirectory();
      } catch {
        return false;
      }
    },
    kernel: release(),
    has: (cmd) => Boolean(which(cmd)) || existsSync(`/usr/sbin/${cmd}`) || existsSync(`/sbin/${cmd}`),
    root: typeof process.getuid === "function" && process.getuid() === 0,
    sysbox: () => {
      const has = (cmd: string) => Boolean(which(cmd)) || existsSync(`/usr/sbin/${cmd}`) || existsSync(`/usr/bin/${cmd}`);
      const runc = has("sysbox-runc");
      if (!runc) return { runc, version: "", mgr: false, fs: false, docker: has("docker") };
      const out = runQuiet("sysbox-runc", ["--version"]) ?? "";
      const active = (unit: string) => runQuiet("systemctl", ["is-active", unit])?.trim() === "active";
      return { runc, version: sysboxVersion(out), mgr: active("sysbox-mgr"), fs: active("sysbox-fs"), docker: has("docker") };
    },
  };
}

/** The version in `sysbox-runc --version`, whose lines read "sysbox-runc", "\tedition: ...", "\tversion: 0.6.7". */
export function sysboxVersion(out: string): string {
  for (const line of out.split("\n")) {
    const m = /^\s*version:\s*(\S+)/.exec(line);
    if (m) return m[1]!;
  }
  return "";
}

/** `BUILDHOUND_TEST_HOST_PROBE` stands in for the machine in tests, so the Linux checks run on any CI host. */
function fakeProbe(os: "macos" | "linux", v: Partial<Record<string, unknown>>): HostProbe {
  const num = (k: string, d: number) => (typeof v[k] === "number" ? (v[k] as number) : d);
  const bool = (k: string, d: boolean) => (typeof v[k] === "boolean" ? (v[k] as boolean) : d);
  return {
    os,
    arch: typeof v.arch === "string" ? v.arch : "x64",
    kvm: () => ({ exists: bool("kvm", true), ...(typeof v.kvm_error === "string" ? { error: v.kvm_error } : {}) }),
    cpuFlags: () => (typeof v.cpu_flags === "string" ? v.cpu_flags : "fpu vmx"),
    cpus: num("cpus", 8),
    memoryMiB: num("memory_mib", 32768),
    freeDisk: () => num("free_disk_gb", 200) * GB,
    cgroupV2: () => bool("cgroup_v2", true),
    systemd: () => bool("systemd", true),
    kernel: typeof v.kernel === "string" ? v.kernel : "6.8.0-45-generic",
    has: (cmd) => !(Array.isArray(v.missing) && v.missing.includes(cmd)),
    root: bool("root", false),
    sysbox: () => {
      // `"sysbox": {"version": "0.6.7"}` is a working Sysbox; any field can be set false to break it.
      const sb = (typeof v.sysbox === "object" && v.sysbox !== null ? v.sysbox : null) as Partial<SysboxState> | null;
      if (!sb) return { runc: false, version: "", mgr: false, fs: false, docker: false };
      return { runc: sb.runc ?? true, version: sb.version ?? "", mgr: sb.mgr ?? true, fs: sb.fs ?? true, docker: sb.docker ?? true };
    },
  };
}

/** KVM means a microVM per job, always; without it a working Sysbox means a container per job; null when neither. */
export function isolationOf(p: HostProbe): Isolation | null {
  if (p.os === "macos" || p.kvm().exists) return "vm";
  return sysboxWorks(p.sysbox()) ? "container" : null;
}

function kvmCheck(p: HostProbe, isolation: Isolation | null): HostCheck {
  const k = p.kvm();
  if (k.exists && !k.error) return { id: "kvm", status: "ok", title: "KVM is available (/dev/kvm)" };
  if (k.exists) return { id: "kvm", status: "ok", title: "KVM is available (/dev/kvm); the Buildhound agent opens it as root", ...(k.error ? { detail: k.error } : {}) };
  if (isolation === "container") {
    return { id: "kvm", status: "warn", title: "No KVM on this machine (/dev/kvm is missing): jobs run in Sysbox system containers instead of microVMs", fix: "KVM (bare metal, or a VM with nested virtualization) gives each job a microVM of its own" };
  }
  // Sysbox is installed but not working: the isolation line below has the one fix, so this line does not fail too.
  if (p.sysbox().runc) {
    return { id: "kvm", status: "warn", title: "No KVM on this machine (/dev/kvm is missing): jobs would run in Sysbox system containers, which need the fix below", fix: "KVM (bare metal, or a VM with nested virtualization) gives each job a microVM of its own" };
  }
  const flags = ` ${p.cpuFlags()} `;
  const fix =
    p.arch === "x64" && flags.includes(" vmx ")
      ? "Load the module: sudo modprobe kvm_intel"
      : p.arch === "x64" && flags.includes(" svm ")
        ? "Load the module: sudo modprobe kvm_amd"
        : p.arch === "x64"
          ? `Turn on virtualization (Intel VT-x or AMD-V) in the firmware settings; on a cloud VM, use bare metal or an instance type with nested virtualization, or ${SYSBOX_INSTALL} for container isolation`
          : `Use bare metal, or a VM whose host offers nested virtualization; this kernel or VM offers no KVM. Or ${SYSBOX_INSTALL} for container isolation`;
  return { id: "kvm", status: "fail", title: "No KVM on this machine (/dev/kvm is missing): job VMs need it", fix };
}

/** The warning wherever a container-isolated machine shows (RUNNERS.md, Linux hosts, no KVM). */
export const CONTAINER_WARNING = CONTAINER_ISOLATION_WARNING;

/** How jobs would run here, the same line as the Buildhound agent's (`linuxhost.isolationCheck`). */
function isolationCheck(p: HostProbe, isolation: Isolation | null): HostCheck {
  if (isolation === "vm") return { id: "isolation", status: "ok", title: "Firecracker microVMs: one per job, destroyed after" };
  const s = p.sysbox();
  if (isolation === "container") {
    return { id: "isolation", status: "warn", title: `Container isolation: Sysbox ${s.version} runs each job in a system container, which shares this machine's kernel and is weaker than a microVM`, detail: "jobs that use secrets never route to this machine, whatever its trust tier", fix: "KVM gives each job a microVM of its own" };
  }
  if (s.runc && !s.version) return { id: "isolation", status: "fail", title: "sysbox-runc is installed but does not answer --version", fix: `Reinstall Sysbox: ${SYSBOX_INSTALL}` };
  if (s.runc && (!s.mgr || !s.fs)) return { id: "isolation", status: "fail", title: "Sysbox is installed but sysbox-mgr or sysbox-fs is not running", fix: "sudo systemctl enable --now sysbox" };
  if (s.runc && !s.docker) return { id: "isolation", status: "fail", title: "Sysbox is installed but Docker is not: the Buildhound agent starts Sysbox containers through Docker", fix: "sudo apt-get install -y docker.io, then sudo systemctl restart sysbox" };
  return { id: "isolation", status: "fail", title: "No isolation for jobs: no KVM for microVMs and no Sysbox for system containers", fix: `Turn on KVM (the line above), or ${SYSBOX_INSTALL}` };
}

function sizeChecks(p: HostProbe, dir: string): HostCheck[] {
  const out: HostCheck[] = [];
  const mac = p.os === "macos";
  const cores = `${p.cpus} cores`;
  if (p.cpus < 2) out.push({ id: "cpu", status: "fail", title: `${cores}: a job VM needs at least 2`, fix: "Use a machine with 2 or more cores" });
  else if (p.cpus < 4) out.push({ id: "cpu", status: "warn", title: `${cores}: jobs run, slower than on GitHub's 4-core runner`, fix: "4 or more cores match GitHub's standard runner" });
  else out.push({ id: "cpu", status: "ok", title: cores });

  const mem = `${gb(p.memoryMiB * 2 ** 20)} of memory`;
  const [minMiB, goodMiB] = mac ? [8 * 1024, 16 * 1024] : [6 * 1024, 10 * 1024];
  if (p.memoryMiB < minMiB) out.push({ id: "memory", status: "fail", title: `${mem}: ${mac ? "a Mac needs 8 GB to run a job VM" : "a job VM needs 4 GB and the machine about 2 GB more"}`, fix: `Use a machine with at least ${minMiB / 1024} GB of memory` });
  else if (p.memoryMiB < goodMiB) out.push({ id: "memory", status: "warn", title: `${mem}: ${mac ? "one job at a time" : "job VMs get 4 GB, less than GitHub's 8 GB runner"}`, fix: `${goodMiB / 1024} GB or more gives each job 8 GB` });
  else out.push({ id: "memory", status: "ok", title: mem });

  const free = p.freeDisk(dir);
  if (free === null) out.push({ id: "disk", status: "warn", title: "Free disk not checked" });
  else if (free < 15 * GB) out.push({ id: "disk", status: "fail", title: `${gb(free)} free for ${dir}: the image and a running job need 15 GB`, fix: "Free up space, or put the agent's home on a larger disk" });
  else if (free < 30 * GB) out.push({ id: "disk", status: "warn", title: `${gb(free)} free for ${dir}: enough for one or two jobs at once`, fix: "30 GB or more leaves room for several jobs at once" });
  else out.push({ id: "disk", status: "ok", title: `${gb(free)} free for ${dir}` });
  return out;
}

function kernelCheck(rel: string): HostCheck {
  const m = /^(\d+)\.(\d+)/.exec(rel);
  if (!m) return { id: "kernel", status: "warn", title: "Kernel version not read", detail: rel };
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < 5 || (major === 5 && minor < 10)) return { id: "kernel", status: "warn", title: `Kernel ${rel}: older than the 5.10 Firecracker supports`, fix: "Upgrade to a kernel from 5.10 on (Ubuntu 22.04 and Debian 11 ship one)" };
  return { id: "kernel", status: "ok", title: `Kernel ${rel}` };
}

export function hostChecks(p: HostProbe, dir = dataDir(p.os)): HostCheck[] {
  if (p.os === "macos") {
    const arch: HostCheck =
      p.arch === "arm64" ? { id: "arch", status: "ok", title: "Apple silicon: runs macOS and Linux job VMs" } : { id: "arch", status: "fail", title: "An Intel Mac: job VMs need Apple silicon", fix: "Connect a Mac with Apple silicon (M1 or later)" };
    return [arch, ...sizeChecks(p, dir)];
  }
  const arch: HostCheck =
    p.arch === "x64"
      ? { id: "arch", status: "ok", title: "x86-64: takes buildhound-linux and buildhound-linux-x64 jobs" }
      : p.arch === "arm64"
        ? { id: "arch", status: "ok", title: "arm64: takes buildhound-linux and buildhound-linux-arm64 jobs" }
        : { id: "arch", status: "fail", title: `Buildhound runs job VMs on x86-64 and arm64 Linux, not ${p.arch}`, fix: "Use an x86-64 or arm64 machine" };
  const missing = ["ip", "nft"].filter((c) => !p.has(c));
  const pkgs: Record<string, string> = { ip: "iproute2", nft: "nftables" };
  const tools: HostCheck = missing.length
    ? { id: "tools", status: "fail", title: `${missing.join(" and ")} not installed: job VM networking needs them`, fix: `sudo apt-get install -y ${missing.map((m) => pkgs[m]).join(" ")}` }
    : { id: "tools", status: "ok", title: "ip and nft are installed" };
  const isolation = isolationOf(p);
  return [
    arch,
    kvmCheck(p, isolation),
    isolationCheck(p, isolation),
    ...sizeChecks(p, dir),
    p.cgroupV2()
      ? { id: "cgroups", status: "ok", title: "cgroup v2: each job VM gets its own memory and process limits" }
      : { id: "cgroups", status: "warn", title: "cgroup v1: job VMs run, with weaker limits on the VM process", fix: "Boot with systemd.unified_cgroup_hierarchy=1 (the default on Ubuntu 22.04, Debian 11 and later)" },
    p.systemd()
      ? { id: "systemd", status: "ok", title: "systemd: the Buildhound agent runs as a system service" }
      : { id: "systemd", status: "fail", title: "No systemd: the Buildhound agent runs as a systemd service", fix: "Use a distribution that boots with systemd (Ubuntu, Debian, Fedora and most others)" },
    kernelCheck(p.kernel),
    tools,
    p.root
      ? { id: "root", status: "ok", title: "Running as root: connecting installs the system service directly" }
      : { id: "root", status: "ok", title: "Not root: connecting will need sudo once, for the system service, the network rules and KVM" },
  ];
}
