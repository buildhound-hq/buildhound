import { describe, expect, it } from "vitest";
import { runDoctor } from "../../commands/doctor";
import { CHECKS } from "./checks";
import { compareVersions, parseSize } from "./context";
import type { Check, HttpResult, Sys } from "./types";

// Every check with the machine stubbed: no command runs, no request leaves the test.

const NOW = Date.parse("2026-10-15T12:00:00Z");
const HOME = "/h/.buildhound";
const GB = 2 ** 30;
const API = "https://api.buildhound.sh";
const res = (status: number, body: unknown): HttpResult => ({ ok: true, status, body: typeof body === "string" ? null : body, text: typeof body === "string" ? body : JSON.stringify(body) });

interface Machine {
  os?: Sys["os"];
  node?: string;
  ram?: number;
  bins?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  dirs?: string[];
  listings?: Record<string, string[]>;
  exec?: Record<string, string | null>;
  http?: Record<string, HttpResult | "hang">;
  agent?: Record<string, unknown> | Error;
  disk?: { free: number; total: number };
}

const agentJson = { machine_id: "m-1", machine_name: "studio", machine_token: "bh_m_zz9", api_url: API, owner: "acme", scale_sets: [{ label: "buildhound-macos", name: "s1", runner_group: "Default" }, { label: "buildhound-linux", name: "s2", runner_group: "Default" }], os: "macos", arch: "arm64", dogfood_host_mode: false };
const machineRow = { id: "m-1", name: "studio", status: "online", labels: ["buildhound-macos", "buildhound-linux"], trust: "burst", routing: "primary", last_heartbeat_at: new Date(NOW - 10_000).toISOString() };

/** A healthy laptop: connected to acme, plugged in, nothing heavy running. Each test changes one thing. */
function healthy(): Machine {
  return {
    bins: ["npx", "gh", "xcrun", "docker", "ps", "pmset", "sysctl", "ioreg", "fdesetup"],
    env: { BUILDHOUND_AGENT_HOME: HOME, HOME: "/h" },
    files: {
      [`${HOME}/agent.json`]: JSON.stringify(agentJson),
      [`${HOME}/policy.json`]: JSON.stringify({ paused: false, idle_only: true, plugged_in_only: true }),
      [`${HOME}/agent.sock`]: "",
      [`${HOME}/bin/buildhound-vz`]: "",
      [`${HOME}/images/linux-arm64/current/manifest.json`]: JSON.stringify({ image_id: "linux-1" }),
      [`${HOME}/images/macos-arm64/current/manifest.json`]: JSON.stringify({ image_id: "macos-1", xcode: "27.0" }),
    },
    dirs: [HOME],
    exec: {
      "gh auth token": "gho_test",
      "pmset -g batt": "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t90%; charging; present: true",
      "pmset -g": " lowpowermode         0",
      "ioreg -c IOHIDSystem -d 4 -r": '"HIDIdleTime" = 900000000000',
      "sysctl -n kern.memorystatus_vm_pressure_level": "1",
      "sysctl vm.swapusage": "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)",
      "xcrun simctl list devices booted -j": JSON.stringify({ devices: { "iOS-27-0": [] } }),
      "docker ps --format {{json .}}": "",
      "docker stats --no-stream --format {{json .}}": "",
      "ps -Ao rss=,comm=": "  15000 /Users/h/.buildhound/bin/buildhound-agent\n 200000 /Applications/Safari.app/Contents/MacOS/Safari",
      "fdesetup status": "FileVault is On.",
    },
    http: {
      [`${API}/v1/status`]: res(200, { status: "operational" }),
      "https://api.github.com/user": res(200, { login: "octo" }),
      "https://api.github.com/rate_limit": res(200, {}),
      "https://dl.buildhound.sh/agent/latest": res(200, "0.1.26\n"),
      [`${API}/v1/accounts/acme/plan`]: res(200, { plan: "team", effective: "team", checkout_next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" }),
      [`${API}/v1/accounts/acme/repositories`]: res(200, { repositories: [{ full_name: "acme/app", private: true, archived: false, state: "routed" }] }),
      [`${API}/v1/machines?owner=acme`]: res(200, { machines: [machineRow] }),
    },
    agent: { version: "0.1.26", minAgentVersion: "0.1.25", state: "online", runningJobs: 0, notReady: [] },
    disk: { free: 200 * GB, total: 500 * GB },
  };
}

function fakeSys(m: Machine): Sys {
  return {
    os: m.os ?? "macos",
    arch: "arm64",
    nodeVersion: m.node ?? "22.14.0",
    memoryBytes: m.ram ?? 24 * GB,
    hostname: "studio",
    now: () => NOW,
    env: (k) => m.env?.[k],
    which: (b) => ((m.bins ?? []).includes(b) ? `/usr/bin/${b}` : null),
    exec: async (bin, args) => {
      if (!(m.bins ?? []).includes(bin)) return null;
      const key = [bin, ...args].join(" ");
      return m.exec?.[key] ?? null;
    },
    http: (url) => {
      const r = m.http?.[url];
      if (r === "hang") return new Promise(() => undefined);
      return Promise.resolve(r ?? { ok: false, error: "ECONNREFUSED" });
    },
    exists: (p) => p in (m.files ?? {}) || (m.dirs ?? []).includes(p),
    readText: (p) => m.files?.[p] ?? null,
    listDir: (p) => m.listings?.[p] ?? [],
    agentStatus: async () => {
      if (m.agent instanceof Error) throw m.agent;
      if (!m.agent) throw new Error("connect ENOENT");
      return m.agent;
    },
    diskFree: async () => m.disk ?? null,
  };
}

async function doctor(change: (m: Machine) => void = () => undefined, opts: { org?: string } = {}) {
  const m = healthy();
  change(m);
  return runDoctor(opts, fakeSys(m), 2000);
}

const byId = (checks: Check[], id: string): Check => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

describe("buildhound doctor", () => {
  it("reports every check, in order, as one JSON shape with ok, summary and next", async () => {
    const r = await doctor();
    expect(Object.keys(r).sort()).toEqual(["checks", "machine", "next", "ok", "owner", "summary"]);
    expect(r.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    for (const c of r.checks) {
      expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
      expect(c.title).toBeTruthy();
      if (c.status === "warn" || c.status === "fail") expect(c.fix).toBeTruthy();
    }
    expect(r.ok).toBe(true);
    expect(r.owner).toBe("acme");
    expect(r.summary.ok + r.summary.warn + r.summary.fail + r.summary.skip).toBe(r.checks.length);
    expect(r.summary).toMatchObject({ warn: 0, fail: 0 });
    expect(r.next).toBe("buildhound runner status --org acme");
    expect(byId(r.checks, "github").title).toBe("Signed in to GitHub as octo, from gh");
    expect(byId(r.checks, "agent").title).toBe("Buildhound agent 0.1.26 is online");
    expect(byId(r.checks, "machine").title).toBe("studio checked in just now: macOS and Linux, No secrets, primary");
    expect(byId(r.checks, "images").title).toBe("Linux image ready; macOS image ready with Xcode 27.0");
    expect(byId(r.checks, "power").title).toBe("Plugged in (90%); takes jobs only when plugged in and only when not in use");
    // Neither the machine token in agent.json nor the GitHub token reaches the output.
    expect(JSON.stringify(r)).not.toContain("bh_m_zz9");
    expect(JSON.stringify(r)).not.toContain("gho_test");
  });

  it("names booted simulators and the command that shuts them down", async () => {
    const r = await doctor((m) => {
      m.exec!["xcrun simctl list devices booted -j"] = JSON.stringify({ devices: { "iOS-27-0": [{ name: "iPhone 17 Pro", state: "Booted" }, { name: "iPad Air", state: "Booted" }], "watchOS-27-0": [{ name: "Apple Watch", state: "Booted" }] } });
    });
    const c = byId(r.checks, "simulators");
    expect(c).toMatchObject({ status: "warn", fix: "If you are not using them: xcrun simctl shutdown all" });
    expect(c.title).toContain("3 simulators running (iPhone 17 Pro, iPad Air, Apple Watch)");
    expect(r.ok).toBe(true);
  });

  it("names the heavy Docker containers and local database stacks, with the engine, and suggests stopping them", async () => {
    const r = await doctor((m) => {
      m.exec!["ps -Ao rss=,comm="] = " 900000 /Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper";
      m.exec!["docker ps --format {{json .}}"] = [
        { Names: "supabase_db_shop", Image: "public.ecr.aws/supabase/postgres:17", Labels: "com.docker.compose.project=shop,com.supabase.cli.project=shop" },
        { Names: "supabase_db_blog", Image: "public.ecr.aws/supabase/postgres:17", Labels: "com.supabase.cli.project=blog" },
        { Names: "redis", Image: "redis:7", Labels: "" },
      ].map((x) => JSON.stringify(x)).join("\n");
      m.exec!["docker stats --no-stream --format {{json .}}"] = [
        { Name: "supabase_db_shop", MemUsage: "1.5GiB / 11.7GiB" },
        { Name: "supabase_db_blog", MemUsage: "700MiB / 11.7GiB" },
        { Name: "redis", MemUsage: "12MiB / 11.7GiB" },
      ].map((x) => JSON.stringify(x)).join("\n");
    });
    const c = byId(r.checks, "docker");
    expect(c.status).toBe("warn");
    expect(c.title).toBe("Docker (OrbStack): 3 containers using 2.2 GB, including 2 local database stacks (Supabase stack shop 1.5 GB, Supabase stack blog 700 MB, redis 12 MB)");
    expect(c.fix).toContain("docker stop $(docker ps -q --filter label=com.supabase.cli.project=shop)");
    expect(c.fix).toContain("docker stop redis");
  });

  it("is quiet about Docker when it is not running or light", async () => {
    const off = await doctor((m) => (m.exec!["docker ps --format {{json .}}"] = null));
    expect(byId(off.checks, "docker")).toMatchObject({ status: "ok", title: "Docker is not running" });
    const none = await doctor((m) => (m.bins = m.bins!.filter((b) => b !== "docker")));
    expect(byId(none.checks, "docker").status).toBe("skip");
  });

  it("names other VMs running beside the job VMs", async () => {
    const r = await doctor((m) => (m.exec!["ps -Ao rss=,comm="] = " 6291456 /Applications/Parallels Desktop.app/Contents/MacOS/prl_vm_app\n 15000 buildhound-agent"));
    const c = byId(r.checks, "vms");
    expect(c.status).toBe("warn");
    expect(c.title).toBe("Other VMs running: Parallels (1 VM, 6 GB)");
    expect(c.fix).toContain("prlctl stop <name>");
  });

  it("without the Buildhound agent says once that this machine is not set up, with the command, and fails nothing for it", async () => {
    const r = await doctor((m) => {
      m.files = {};
      delete m.agent;
      m.dirs = [];
    });
    const agent = byId(r.checks, "agent");
    expect(agent).toMatchObject({ status: "skip", title: "Buildhound agent: not set up on this Mac", fix: "npx buildhound runner add --org octo --yes" });
    for (const id of ["machine", "images"]) expect(byId(r.checks, id).status).toBe("skip");
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.owner).toBe("octo");
    expect(r.ok).toBe(true);
    expect(r.next).toBe("npx buildhound runner add --org octo --yes");
  });

  it("on a Linux host without the Buildhound agent says Linux hosts are coming instead of a runner add that refuses", async () => {
    const r = await doctor((m) => {
      m.os = "linux";
      m.files = {};
      delete m.agent;
      m.dirs = [];
    });
    expect(byId(r.checks, "agent")).toMatchObject({ status: "skip", title: expect.stringContaining("Linux hosts are coming"), fix: "Connect a Mac with npx buildhound runner add --org octo --yes" });
  });

  it("fails when the Buildhound agent is set up but not running", async () => {
    const r = await doctor((m) => {
      delete m.files![`${HOME}/agent.sock`];
    });
    expect(byId(r.checks, "agent")).toMatchObject({ status: "fail", title: "The Buildhound agent is installed but not running", fix: "Start it again: npx buildhound runner add --org acme --label macos,linux --yes" });
    expect(r.ok).toBe(false);
  });

  it("warns when the Buildhound agent is paused, with the command that resumes it", async () => {
    const r = await doctor((m) => (m.agent = { version: "0.1.26", minAgentVersion: "0.1.25", state: "paused" }));
    expect(byId(r.checks, "agent")).toMatchObject({ status: "warn", title: "Buildhound agent 0.1.26 is paused: it takes no new jobs", fix: "buildhound runner set --machine studio --org acme --resume" });
  });

  it("warns when the Buildhound agent is older than the control plane's minimum, and mentions a newer release otherwise", async () => {
    const old = await doctor((m) => (m.agent = { version: "0.1.20", minAgentVersion: "0.1.25", state: "online" }));
    expect(byId(old.checks, "agent")).toMatchObject({ status: "warn", title: "Buildhound agent 0.1.20 is below the minimum 0.1.25: it updates itself between jobs" });
    const behind = await doctor((m) => (m.agent = { version: "0.1.25", minAgentVersion: "0.1.25", state: "online", runningJobs: 1 }));
    expect(byId(behind.checks, "agent")).toMatchObject({ status: "ok", title: "Buildhound agent 0.1.25 is online, running 1 job; 0.1.26 is out and installs when the control plane asks for it" });
    const finishing = await doctor((m) => (m.agent = { version: "0.1.26", minAgentVersion: "0.1.25", state: "draining" }));
    expect(byId(finishing.checks, "agent").title).toContain("is finishing up");
  });

  it("on battery with Only when plugged in says it is working as set, with a fix that turns it off", async () => {
    const r = await doctor((m) => (m.exec!["pmset -g batt"] = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; present: true"));
    const c = byId(r.checks, "power");
    expect(c.status).toBe("warn");
    expect(c.title).toBe("On battery (64%): jobs wait until this Mac is plugged in, as set (Only when plugged in)");
    expect(c.fix).toBe("Plug in. To take jobs on battery too: buildhound runner set --machine studio --org acme --plugged-in-only off");
    expect(r.ok).toBe(true);
    // With nothing else to look at, the way to change the setting is the next step.
    expect(r.next).toBe(c.fix);
  });

  it("in use with Only when not in use, and Low Power Mode, each say why jobs wait", async () => {
    const busy = await doctor((m) => (m.exec!["ioreg -c IOHIDSystem -d 4 -r"] = '"HIDIdleTime" = 3000000000'));
    expect(byId(busy.checks, "power").title).toBe("Plugged in (90%), in use: jobs wait until nobody has used this Mac for 5 minutes, as set (Only when not in use)");
    const low = await doctor((m) => (m.exec!["pmset -g"] = " lowpowermode         1"));
    expect(byId(low.checks, "power")).toMatchObject({ status: "warn", fix: "Turn off Low Power Mode in System Settings, Battery" });
    const desktop = await doctor((m) => (m.exec!["pmset -g batt"] = "Now drawing from 'AC Power'"));
    expect(byId(desktop.checks, "power").status).toBe("skip");
  });

  it("warns when memory is tight, with the Buildhound agent's own reason", async () => {
    const r = await doctor((m) => {
      m.exec!["sysctl -n kern.memorystatus_vm_pressure_level"] = "4";
      m.exec!["sysctl vm.swapusage"] = "vm.swapusage: total = 10240.00M  used = 8704.00M  free = 1536.00M  (encrypted)";
      m.agent = { version: "0.1.26", minAgentVersion: "0.1.25", state: "online", waiting: "memory", waitingReason: "Waiting: memory is tight on this Mac" };
    });
    const c = byId(r.checks, "memory");
    expect(c.status).toBe("warn");
    expect(c.title).toBe("Waiting: memory is tight on this Mac, memory pressure is critical, swap at 8.5 GB of 24 GB RAM: the Buildhound agent takes no new jobs until this Mac has room again");
    const swapOnly = await doctor((m) => (m.exec!["sysctl vm.swapusage"] = "vm.swapusage: total = 10240.00M  used = 8704.00M  free = 1536.00M"));
    expect(byId(swapOnly.checks, "memory").title).toBe("Swap at 8.5 GB of 24 GB RAM: this Mac is short of memory");
    const fine = await doctor();
    expect(byId(fine.checks, "memory")).toMatchObject({ status: "ok", title: "Memory is fine: memory pressure normal, swap 512 MB" });
  });

  it("warns under 30 GB of free disk and fails under 10 GB", async () => {
    const tight = await doctor((m) => (m.disk = { free: 20 * GB, total: 500 * GB }));
    expect(byId(tight.checks, "disk").status).toBe("warn");
    const full = await doctor((m) => (m.disk = { free: 5 * GB, total: 500 * GB }));
    expect(byId(full.checks, "disk").status).toBe("fail");
    expect(full.ok).toBe(false);
  });

  it("FileVault off is a note on a No secrets machine and a warning on a Trusted one", async () => {
    const note = await doctor((m) => (m.exec!["fdesetup status"] = "FileVault is Off."));
    expect(byId(note.checks, "filevault")).toMatchObject({ status: "ok", title: "FileVault is off: fine for No secrets, and Trusted needs it on" });
    const trusted = await doctor((m) => {
      m.exec!["fdesetup status"] = "FileVault is Off.";
      m.http![`${API}/v1/machines?owner=acme`] = res(200, { machines: [{ ...machineRow, trust: "trusted" }] });
    });
    expect(byId(trusted.checks, "filevault")).toMatchObject({ status: "warn", fix: "Turn on FileVault in System Settings, Privacy & Security" });
  });

  it("with the API down fails that check once and skips what needs it", async () => {
    const r = await doctor((m) => {
      for (const k of Object.keys(m.http!)) if (k.startsWith(API)) delete m.http![k];
    });
    expect(byId(r.checks, "api")).toMatchObject({ status: "fail", title: "Cannot reach the Buildhound API at api.buildhound.sh: ECONNREFUSED" });
    for (const id of ["account", "machine", "routing"]) expect(byId(r.checks, id).status).toBe("skip");
    expect(r.ok).toBe(false);
    expect(r.next).toContain("Check the network");
  });

  it("says when the GitHub App is not installed, and when private repositories wait for a plan", async () => {
    const missing = await doctor((m) => (m.http![`${API}/v1/accounts/acme/plan`] = res(404, { error: { code: "NOT_FOUND", message: "account acme not found" } })));
    expect(byId(missing.checks, "account")).toMatchObject({ status: "fail", title: "The Buildhound GitHub App is not installed on acme" });
    expect(byId(missing.checks, "account").fix).toContain("https://github.com/apps/");
    const held = await doctor((m) => {
      m.http![`${API}/v1/accounts/acme/plan`] = res(200, { plan: "team", effective: "none", checkout_next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" });
      m.http![`${API}/v1/accounts/acme/repositories`] = res(200, { repositories: [{ full_name: "acme/app", private: true, archived: false, state: "needs_plan" }] });
    });
    expect(byId(held.checks, "account")).toMatchObject({ status: "warn", title: "GitHub App installed on acme, Free plan; 1 private repository runs on GitHub-hosted until a Team plan is active", fix: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" });
    expect(byId(held.checks, "routing")).toMatchObject({ status: "warn", title: "No repository routes to your machines yet" });
  });

  it("fails sign-in without a token and with a rejected one", async () => {
    const none = await doctor((m) => (m.exec!["gh auth token"] = null));
    expect(byId(none.checks, "github")).toMatchObject({ status: "fail", fix: "Run gh auth login, or set GITHUB_TOKEN" });
    expect(byId(none.checks, "account").status).toBe("skip");
    const bad = await doctor((m) => (m.http!["https://api.github.com/user"] = res(401, { message: "Bad credentials" })));
    expect(byId(bad.checks, "github")).toMatchObject({ status: "fail", fix: "Run gh auth refresh, or gh auth login" });
  });

  it("warns about the machine when the control plane has not heard from it, and when its routing is off", async () => {
    const quiet = await doctor((m) => (m.http![`${API}/v1/machines?owner=acme`] = res(200, { machines: [{ ...machineRow, last_heartbeat_at: new Date(NOW - 3 * 3600_000).toISOString() }] })));
    expect(byId(quiet.checks, "machine")).toMatchObject({ status: "fail", title: "The control plane last heard from studio about 3 hours ago" });
    const off = await doctor((m) => (m.http![`${API}/v1/machines?owner=acme`] = res(200, { machines: [{ ...machineRow, routing: "off" }] })));
    expect(byId(off.checks, "machine")).toMatchObject({ status: "warn", fix: "buildhound runner set --machine studio --org acme --routing primary" });
    const gone = await doctor((m) => (m.http![`${API}/v1/machines?owner=acme`] = res(200, { machines: [] })));
    expect(byId(gone.checks, "machine").status).toBe("fail");
  });

  it("compares the repositories the Buildhound app covers with what this machine serves on a personal account", async () => {
    // An organisation's machines serve every repository.
    expect(byId((await doctor()).checks, "repositories")).toMatchObject({ status: "ok", title: "studio serves every repository the Buildhound app covers on acme" });
    const personal = (served: string[], filter: unknown) => (m: Machine) => {
      m.http![`${API}/v1/accounts/acme/plan`] = res(200, { plan: "personal", effective: "enterprise" });
      m.http![`${API}/v1/accounts/acme/repositories`] = res(200, {
        repositories: [
          { full_name: "acme/app", private: true, archived: false, state: "routed" },
          { full_name: "acme/lensdrop", private: true, archived: false, state: "not_routed" },
          { full_name: "acme/old", private: true, archived: true, state: "not_routed" },
        ],
      });
      m.http![`${API}/v1/machines?owner=acme`] = res(200, { machines: [{ ...machineRow, repositories: served, repository_filter: filter }] });
    };
    const missing = await doctor(personal(["acme/app"], { all: false, repositories: ["acme/app"], pending: false }));
    expect(byId(missing.checks, "repositories")).toMatchObject({
      status: "warn",
      title: "The Buildhound app covers 2 repositories; studio serves 1 (missing acme/lensdrop)",
      fix: "buildhound runner set --machine studio --org acme --add-repository acme/lensdrop",
    });
    const all = await doctor(personal(["acme/app", "acme/lensdrop"], { all: true, repositories: [], pending: false }));
    expect(byId(all.checks, "repositories")).toMatchObject({ status: "ok", title: "studio serves all 2 repositories the Buildhound app covers" });
    // An agent before 0.1.27 reports what it serves but not its list: the check still compares.
    const old = await doctor(personal(["acme/app"], null));
    expect(byId(old.checks, "repositories")).toMatchObject({ status: "warn", detail: expect.stringContaining("before 0.1.27") });
  });

  it("says when the macOS image is missing and the Linux image is downloading", async () => {
    const r = await doctor((m) => {
      delete m.files![`${HOME}/images/macos-arm64/current/manifest.json`];
      delete m.files![`${HOME}/images/linux-arm64/current/manifest.json`];
      m.agent = { version: "0.1.26", minAgentVersion: "0.1.25", state: "online", notReady: ["buildhound-linux"] };
    });
    const c = byId(r.checks, "images");
    expect(c.status).toBe("warn");
    expect(c.title).toBe("Linux image is downloading: Linux jobs run on GitHub-hosted until it is ready; No macOS image on this Mac yet: macOS jobs run on GitHub-hosted");
  });

  it("on Linux skips the Mac-only checks and reads LUKS for disk encryption", async () => {
    const r = await doctor((m) => {
      m.os = "linux";
      m.bins = ["npx", "gh", "ps", "lsblk"];
      m.exec!["lsblk -rno TYPE"] = "disk\npart\ncrypt\nlvm";
      m.files!["/proc/meminfo"] = "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB";
    });
    expect(byId(r.checks, "simulators").status).toBe("skip");
    expect(byId(r.checks, "power").status).toBe("skip");
    expect(byId(r.checks, "filevault")).toMatchObject({ status: "ok", title: "Disk encryption is on: this machine can be Trusted" });
    expect(byId(r.checks, "memory").status).toBe("ok");
  });

  it("reports a check that does not answer in time instead of waiting for it", async () => {
    const m = healthy();
    m.http!["https://api.github.com/rate_limit"] = "hang";
    const r = await runDoctor({}, fakeSys(m), 50);
    expect(byId(r.checks, "github_api")).toMatchObject({ status: "warn", title: "GitHub's API: no answer in 0 seconds" });
  });

  it("makes a concrete fix the next step before the memory advice and the power setting", async () => {
    const r = await doctor((m) => {
      m.exec!["ioreg -c IOHIDSystem -d 4 -r"] = '"HIDIdleTime" = 3000000000';
      m.exec!["sysctl -n kern.memorystatus_vm_pressure_level"] = "2";
      m.exec!["xcrun simctl list devices booted -j"] = JSON.stringify({ devices: { ios: [{ name: "iPhone 17", state: "Booted" }] } });
    });
    expect(r.checks.filter((c) => c.status === "warn").map((c) => c.id)).toEqual(["power", "memory", "simulators"]);
    expect(byId(r.checks, "memory").title).toBe("Memory pressure is high: this Mac is short of memory");
    expect(r.next).toBe("If you are not using them: xcrun simctl shutdown all");
  });

  it("fails on an old Node", async () => {
    const r = await doctor((m) => (m.node = "20.11.0"));
    expect(byId(r.checks, "node").status).toBe("fail");
  });

  it("reads versions and docker sizes", () => {
    expect(compareVersions("0.1.9", "0.1.25")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.25")).toBeGreaterThan(0);
    expect(parseSize("1.5GiB")).toBe(1.5 * GB);
    expect(parseSize("700MiB")).toBe(700 * 2 ** 20);
    expect(parseSize("512kB")).toBe(512_000);
  });
});
