import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

const hostLabel = process.platform === "darwin" ? "macos" : "linux";
const family = process.platform === "darwin" ? "buildhound-macos" : process.arch === "x64" ? "buildhound-linux-x64" : "buildhound-linux";

/**
 * A control plane that implements CONTROL_PLANE_API.md for a few owners: `acme` registers, `needshuman` has no App
 * installed, `limited` is a Personal account at its machine limit. It records every request for assertions.
 */
class FakeControlPlane {
  server = http.createServer((req, res) => this.handle(req, res));
  url = "";
  requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  registered = new Map<string, { id: string; name: string; labels: string[]; capacity: number; removed: boolean }>();
  failover: Record<string, { active_label: string | null; mode: string; reason: string }> = { "buildhound-macos": { active_label: "buildhound-macos-mini-01", mode: "auto", reason: "machine_online" } };

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let text = "";
    req.on("data", (c: string) => (text += c));
    req.on("end", () => {
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      const url = new URL(req.url ?? "/", "http://x");
      this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "missing or invalid bearer token", next: "buildhound login" } });
      const owner = url.searchParams.get("owner") ?? (body?.owner as string | undefined);

      if (req.method === "POST" && url.pathname === "/v1/machines") {
        const b = body as { owner: string; name: string; labels: string[]; capacity: number };
        if (b.owner === "needshuman") return send(403, { status: "needs_human", reason: "github_app_not_installed", url: "https://github.com/apps/buildhound-ci/installations/new?state=abc", next: `buildhound runner add --org needshuman --label ${hostLabel} --yes` });
        if (b.owner === "limited") return send(409, { error: { code: "MACHINE_LIMIT", message: "Personal allows two machines", next: "buildhound billing checkout --plan team" } });
        if (b.owner === "notadmin") return send(403, { error: { code: "NOT_ADMIN", message: "you are not an admin of notadmin", next: "ask an organisation admin to run this command" } });
        const existing = this.registered.get(b.name);
        const m = existing ?? { id: `m_${this.registered.size + 1}`, name: b.name, labels: b.labels, capacity: b.capacity, removed: false };
        this.registered.set(b.name, m);
        return send(existing ? 200 : 201, {
          machine: { id: m.id, name: m.name, labels: m.labels, capacity: m.capacity, status: "offline" },
          machine_token: `mt_${m.id}_secret`,
          scale_sets: m.labels.map((label) => ({ label, name: `${label}-${m.name}`, runner_group: "Default" })),
          github: { scope: "org", owner: b.owner, repositories: [] },
          next: `buildhound runner status --org ${b.owner}`,
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/machines") {
        const machines = [
          { id: "m_static", name: "mini-01", status: "online", labels: ["buildhound-macos"], capacity: 2, running_jobs: 1, last_heartbeat_at: new Date(Date.now() - 12_000).toISOString(), image_id: "macos-26-xcode-26.1", agent_version: "0.1.0" },
          ...[...this.registered.values()].filter((m) => !m.removed).map((m) => ({ id: m.id, name: m.name, status: "offline", labels: m.labels, capacity: m.capacity, running_jobs: 0, last_heartbeat_at: null, image_id: null, agent_version: "0.1.0-test" })),
        ];
        return send(200, { owner, machines, failover: this.failover });
      }
      const del = /^\/v1\/machines\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && del) {
        const m = [...this.registered.values()].find((x) => x.id === del[1]);
        if (del[1] === "m_static") return send(200, { removed_at: new Date().toISOString() });
        if (!m) return send(404, { error: { code: "NOT_FOUND", message: "unknown machine", next: "buildhound runner status --org acme" } });
        m.removed = true;
        return send(200, { removed_at: new Date().toISOString() });
      }
      if (req.method === "GET" && url.pathname === "/v1/failover") return send(200, { owner, failover: this.failover });
      if (req.method === "POST" && url.pathname === "/v1/failover") {
        const b = body as { label: string; mode: string; reason: string };
        this.failover[b.label] = { active_label: b.mode === "forced_hosted" ? null : (this.failover[b.label]?.active_label ?? null), mode: b.mode, reason: b.reason };
        return send(200, { owner, failover: this.failover });
      }
      send(404, { error: { code: "NOT_FOUND", message: `no route ${req.method} ${url.pathname}`, next: "buildhound --help" } });
    });
  }
}

const api = new FakeControlPlane();
let home = "";
let agentHome = "";
let fakeAgent = "";

/** No TTY, empty PATH (no launchctl, systemctl, gh), HOME and the agent home in temp dirs, a token in the environment. */
async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "", PATH: emptyPath, HOME: home, BUILDHOUND_HOME_DIR: home, BUILDHOUND_AGENT_HOME: agentHome, BUILDHOUND_API_URL: api.url, BUILDHOUND_RELEASE_URL: "", INIT_CWD: "", ...extraEnv };
  try {
    const { stdout, stderr } = await run(process.execPath, [tsx, entry, ...args], { env, cwd: here });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

function singleJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  expect(lines, "exactly one line of JSON on stdout").toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function expectErrorEnvelope(r: { code: number; stdout: string }, code: string, exit: number) {
  expect(r.code).toBe(exit);
  const obj = singleJson(r.stdout) as { error: { code: string; message: string; next: string } };
  expect(obj.error.code).toBe(code);
  expect(obj.error.message).toBeTruthy();
  expect(obj.error.next).toBeTruthy();
  expect(r.stdout).not.toMatch(/\n\s+at /);
  expect(r.stdout).not.toMatch(/at .*\.ts:\d+/);
  return obj;
}

type Step = { step: string; status: string; detail: string };
type AddResult = { status: string; machine: string; machine_id: string; label: string; scale_sets: Array<{ name: string }>; service: string; config: string; steps: Step[]; next: string; url?: string; reason?: string };

beforeAll(async () => {
  await api.start();
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "buildhound-home-"));
  agentHome = path.join(home, ".buildhound");
  fakeAgent = path.join(home, "fake-buildhound-agent");
  writeFileSync(fakeAgent, '#!/bin/sh\necho \'{"agent":"buildhound-agent","version":"0.1.0-test"}\'\n', { mode: 0o755 });
  api.requests = [];
  api.registered.clear();
});

const addArgs = (org: string, more: string[] = []) => ["runner", "add", "--org", org, "--label", hostLabel, "--name", "box-01", "--agent-binary", fakeAgent, ...more];

describe("agentfirst: runner add", () => {
  it("agentfirst: runner add --yes registers, writes agent.json with mode 0600, installs the binary and prints ready with next", async () => {
    const r = await cli(addArgs("acme", ["--yes"]));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as unknown as AddResult;
    expect(obj.status).toBe("ready");
    expect(obj.machine).toBe("box-01");
    expect(obj.label).toBe(family);
    expect(obj.scale_sets.map((s) => s.name)).toEqual([`${family}-box-01`]);
    expect(obj.next).toBe("buildhound runner status --org acme");
    expect(obj.service).toBe(process.platform === "darwin" ? "skipped (launchctl not found)" : "skipped (systemctl not found)");
    expect(obj.steps.map((s) => `${s.step}:${s.status}`)).toEqual(["detect_host:done", "register:done", "write_config:done", "write_policy:done", "install_agent:done", "install_service:skipped"]);

    const configPath = path.join(agentHome, "agent.json");
    expect(obj.config).toBe(configPath);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ machine_id: "m_1", machine_token: "mt_m_1_secret", api_url: api.url, owner: "acme", os: hostLabel === "macos" ? "macos" : "linux", dogfood_host_mode: false });
    // The CLI runs with an empty PATH, so pmset is unreachable and the host reads as no battery.
    const { defaultCapacity, vmSizeFor } = await import("./lib/host");
    const { availableParallelism, totalmem } = await import("node:os");
    const memory_gb = Math.round(totalmem() / 2 ** 30);
    expect(config.capacity).toBe(defaultCapacity({ os: hostLabel, memory_gb, has_battery: false }));
    expect(config.vm).toEqual(vmSizeFor({ cpu_cores: availableParallelism(), memory_gb }));
    expect(config.scale_sets).toEqual([{ label: family, name: `${family}-box-01`, runner_group: "Default" }]);
    expect(statSync(path.join(agentHome, "bin", "buildhound-agent")).mode & 0o111).not.toBe(0);
    const serviceFile = process.platform === "darwin" ? path.join(home, "Library", "LaunchAgents", "sh.buildhound.agent.plist") : path.join(home, ".config", "systemd", "user", "buildhound-agent.service");
    expect(readFileSync(serviceFile, "utf8")).toContain(path.join(agentHome, "bin", "buildhound-agent"));

    const reg = api.requests.find((q) => q.method === "POST" && q.path === "/v1/machines")!;
    expect(reg.auth).toBe("Bearer test-token");
    expect(reg.body).toMatchObject({ owner: "acme", name: "box-01", labels: [family], isolation: "vm", agent_version: "0.1.0-test" });
    const b = reg.body as { cpu_cores: number; memory_gb: number; os: string; arch: string };
    expect(b.cpu_cores).toBeGreaterThan(0);
    expect(b.memory_gb).toBeGreaterThan(0);
    expect(["macos", "linux"]).toContain(b.os);
    expect(["arm64", "x64"]).toContain(b.arch);
    // The token never reaches stdout.
    expect(r.stdout).not.toContain("mt_m_1_secret");
  });

  it("agentfirst: runner add without --yes and without a TTY fails CONFIRM_REQUIRED with the --yes command as next", async () => {
    const obj = expectErrorEnvelope(await cli(addArgs("acme")), "CONFIRM_REQUIRED", 2);
    expect(obj.error.next).toBe(`buildhound runner add --org acme --label ${hostLabel} --yes`);
    expect(api.requests).toEqual([]);
    expect(existsSync(path.join(agentHome, "agent.json"))).toBe(false);
  });

  it("agentfirst: runner add prints needs_human with the URL and exits 0 when the App is not installed", async () => {
    const r = await cli(addArgs("needshuman", ["--yes"]));
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as unknown as AddResult;
    expect(obj.status).toBe("needs_human");
    expect(obj.reason).toBe("github_app_not_installed");
    expect(obj.url).toMatch(/^https:\/\/github\.com\/apps\//);
    expect(obj.next).toContain("buildhound runner add --org needshuman");
    expect(obj.steps.map((s) => `${s.step}:${s.status}`)).toEqual(["detect_host:done", "register:needs_human"]);
    expect(existsSync(path.join(agentHome, "agent.json"))).toBe(false);
  });

  it("agentfirst: runner add passes the MACHINE_LIMIT envelope through with the checkout command as next", async () => {
    const obj = expectErrorEnvelope(await cli(addArgs("limited", ["--yes"])), "MACHINE_LIMIT", 2);
    expect(obj.error.next).toBe("buildhound billing checkout --plan team");
    expect(existsSync(path.join(agentHome, "agent.json"))).toBe(false);
  });

  it("agentfirst: runner add maps NOT_ADMIN to exit 3 with the server's next", async () => {
    expectErrorEnvelope(await cli(addArgs("notadmin", ["--yes"])), "NOT_ADMIN", 3);
  });

  it("agentfirst: runner add a second time is idempotent: the server answers 200 and every step is skipped", async () => {
    expect((await cli(addArgs("acme", ["--yes"]))).code).toBe(0);
    const r = await cli(addArgs("acme", ["--yes"]));
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as unknown as AddResult;
    expect(obj.status).toBe("ready");
    expect(obj.machine_id).toBe("m_1");
    expect(obj.steps.map((s) => `${s.step}:${s.status}`)).toEqual(["detect_host:done", "register:skipped", "write_config:skipped", "write_policy:skipped", "install_agent:skipped", "install_service:skipped"]);
    expect(obj.steps[1]!.detail).toContain("already registered");
    expect(api.requests.filter((q) => q.method === "POST")).toHaveLength(2);
    expect(statSync(path.join(agentHome, "agent.json")).mode & 0o777).toBe(0o600);
  });

  it("agentfirst: runner add without a token asks for one", async () => {
    const obj = expectErrorEnvelope(await cli(addArgs("acme", ["--yes"]), { GITHUB_TOKEN: "" }), "TOKEN_REQUIRED", 3);
    expect(obj.error.next).toContain("--token $(gh auth token)");
  });

  it("agentfirst: runner add with a bad token prints the UNAUTHENTICATED envelope", async () => {
    expectErrorEnvelope(await cli(addArgs("acme", ["--yes"]), { GITHUB_TOKEN: "wrong" }), "UNAUTHENTICATED", 3);
  });

  it("agentfirst: runner add fails AGENT_BINARY_NOT_FOUND when nothing provides the agent", async () => {
    const r = await cli(["runner", "add", "--org", "acme", "--label", hostLabel, "--yes", "--agent-binary", path.join(home, "missing")]);
    const obj = expectErrorEnvelope(r, "AGENT_BINARY_NOT_FOUND", 2);
    expect(obj.error.next).toContain("buildhound runner add --org acme");
  });

  it("agentfirst: runner add rejects a bad --label and --capacity with USAGE", async () => {
    expectErrorEnvelope(await cli(["runner", "add", "--org", "acme", "--label", "windows", "--yes"]), "USAGE", 2);
    expectErrorEnvelope(await cli(addArgs("acme", ["--yes", "--capacity", "many"])), "USAGE", 2);
    expectErrorEnvelope(await cli(["runner", "add", "--label", hostLabel, "--yes"]), "USAGE", 2);
  });

  it("agentfirst: runner add --dogfood-host-mode records the flag in agent.json", async () => {
    expect((await cli(addArgs("acme", ["--yes", "--dogfood-host-mode"]))).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(agentHome, "agent.json"), "utf8")).dogfood_host_mode).toBe(true);
  });
});

describe("agentfirst: runner status", () => {
  it("agentfirst: runner status --org prints machines with heartbeat age, jobs, labels and the failover map", async () => {
    const r = await cli(["runner", "status", "--org", "acme"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { owner: string; machines: Array<Record<string, unknown>>; failover: Record<string, { active_label: string; mode: string }>; next: string };
    expect(obj.owner).toBe("acme");
    expect(obj.machines).toHaveLength(1);
    const m = obj.machines[0]!;
    expect(m).toMatchObject({ id: "m_static", name: "mini-01", status: "online", labels: ["buildhound-macos"], capacity: 2, running_jobs: 1, image_id: "macos-26-xcode-26.1", agent_version: "0.1.0" });
    expect(m.heartbeat_age_seconds).toBeGreaterThanOrEqual(10);
    expect(m.heartbeat_age_seconds).toBeLessThan(120);
    expect(obj.failover["buildhound-macos"]).toEqual({ active_label: "buildhound-macos-mini-01", mode: "auto", reason: "machine_online" });
    expect(obj.next).toBeTruthy();
    expect(api.requests[0]!.path).toBe("/v1/machines?owner=acme");
  });

  it("agentfirst: runner status --local reads the agent's Unix socket", async () => {
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(path.join(agentHome, "agent.json"), JSON.stringify({ machine_id: "m_7", owner: "acme", os: hostLabel === "macos" ? "macos" : "linux" }));
    const status = { state: "online", runningJobs: 1, capacity: 2, savedThisMonthCents: 1200, imageId: "macos-26-xcode-26.1", failoverActive: false };
    const sock = http.createServer((req, res) => {
      res.writeHead(req.url === "/status" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(status));
    });
    await new Promise<void>((resolve) => sock.listen(path.join(agentHome, "agent.sock"), resolve));
    try {
      const r = await cli(["runner", "status", "--local"]);
      expect(r.code).toBe(0);
      const obj = singleJson(r.stdout) as { local: boolean; machine_id: string; agent: Record<string, unknown>; next: string };
      expect(obj.local).toBe(true);
      expect(obj.machine_id).toBe("m_7");
      expect(obj.agent).toEqual(status);
      expect(obj.next).toBe("buildhound runner status --org acme");
      expect(api.requests).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => sock.close(() => resolve()));
    }
  });

  it("agentfirst: runner status --local without an agent fails AGENT_NOT_RUNNING with runner add as next", async () => {
    const obj = expectErrorEnvelope(await cli(["runner", "status", "--local"]), "AGENT_NOT_RUNNING", 2);
    expect(obj.error.next).toContain("buildhound runner add");
  });

  it("agentfirst: runner status with neither flag and no local config fails USAGE", async () => {
    expectErrorEnvelope(await cli(["runner", "status"]), "USAGE", 2);
  });
});

describe("agentfirst: runner remove", () => {
  it("agentfirst: runner remove requires --yes", async () => {
    const obj = expectErrorEnvelope(await cli(["runner", "remove", "--machine", "box-01", "--org", "acme"]), "CONFIRM_REQUIRED", 2);
    expect(obj.error.next).toBe("buildhound runner remove --machine box-01 --org acme --yes");
    expect(api.requests).toEqual([]);
  });

  it("agentfirst: runner remove by name deletes the machine, stops the local service and keeps agent.json", async () => {
    expect((await cli(addArgs("acme", ["--yes"]))).code).toBe(0);
    api.requests = [];
    const r = await cli(["runner", "remove", "--machine", "box-01", "--org", "acme", "--yes"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { status: string; machine: { id: string; name: string }; local: boolean; service: string; config_kept: string | null; deleted_after: string; next: string };
    expect(obj.status).toBe("removed");
    expect(obj.machine).toEqual({ id: "m_1", name: "box-01" });
    expect(obj.local).toBe(true);
    expect(obj.service).toContain("removed");
    expect(obj.config_kept).toBe(path.join(agentHome, "agent.json"));
    expect(Date.parse(obj.deleted_after)).toBeGreaterThan(Date.now() + 47 * 3600 * 1000);
    expect(obj.next).toBe("buildhound runner status --org acme");
    expect(api.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/machines?owner=acme", "DELETE /v1/machines/m_1"]);
    expect(existsSync(path.join(agentHome, "agent.json"))).toBe(true);
    const serviceFile = process.platform === "darwin" ? path.join(home, "Library", "LaunchAgents", "sh.buildhound.agent.plist") : path.join(home, ".config", "systemd", "user", "buildhound-agent.service");
    expect(existsSync(serviceFile)).toBe(false);
  });

  it("agentfirst: runner remove of another machine by id leaves this machine's service alone", async () => {
    const r = await cli(["runner", "remove", "--machine", "m_static", "--org", "acme", "--yes"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { local: boolean; service: string; config_kept: string | null };
    expect(obj.local).toBe(false);
    expect(obj.config_kept).toBeNull();
  });

  it("agentfirst: runner remove of an unknown machine fails NOT_FOUND", async () => {
    expectErrorEnvelope(await cli(["runner", "remove", "--machine", "ghost", "--org", "acme", "--yes"]), "NOT_FOUND", 2);
  });
});

describe("agentfirst: failover", () => {
  it("agentfirst: failover --org prints the state per label", async () => {
    const r = await cli(["failover", "--org", "acme"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { owner: string; changed: unknown; failover: Record<string, unknown>; next: string };
    expect(obj.owner).toBe("acme");
    expect(obj.changed).toBeNull();
    expect(obj.failover["buildhound-macos"]).toMatchObject({ mode: "auto" });
    expect(obj.next).toContain("--set auto --yes");
    expect(api.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/failover?owner=acme"]);
  });

  it("agentfirst: failover --set requires --yes and never posts without it", async () => {
    const obj = expectErrorEnvelope(await cli(["failover", "--org", "acme", "--set", "forced_hosted"]), "CONFIRM_REQUIRED", 2);
    expect(obj.error.next).toBe("buildhound failover --org acme --label buildhound-macos --set forced_hosted --yes");
    expect(api.requests).toEqual([]);
  });

  it("agentfirst: failover --set --yes posts the override and prints the new state", async () => {
    const r = await cli(["failover", "--org", "acme", "--label", "buildhound-macos", "--set", "forced_hosted", "--reason", "maintenance", "--yes"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as { changed: { label: string; mode: string; reason: string }; failover: Record<string, { mode: string; reason: string }>; next: string };
    expect(obj.changed).toEqual({ label: "buildhound-macos", mode: "forced_hosted", reason: "maintenance" });
    expect(obj.failover["buildhound-macos"]).toMatchObject({ mode: "forced_hosted", reason: "maintenance" });
    expect(obj.next).toBe("buildhound runner status --org acme");
    const post = api.requests.find((q) => q.method === "POST")!;
    expect(post.body).toEqual({ owner: "acme", label: "buildhound-macos", mode: "forced_hosted", reason: "maintenance" });
    api.failover["buildhound-macos"] = { active_label: "buildhound-macos-mini-01", mode: "auto", reason: "machine_online" };
  });

  it("agentfirst: failover --set with an unknown mode fails USAGE", async () => {
    expectErrorEnvelope(await cli(["failover", "--org", "acme", "--set", "sometimes", "--yes"]), "USAGE", 2);
  });
});

describe("agentfirst: network", () => {
  it("agentfirst: an unreachable control plane prints NETWORK with exit 4", async () => {
    const obj = expectErrorEnvelope(await cli(["runner", "status", "--org", "acme"], { BUILDHOUND_API_URL: "http://127.0.0.1:9" }), "NETWORK", 4);
    expect(obj.error.next).toContain("--api-url");
  });
});

describe("lightweight defaults", () => {
  it("sizes guests to a share of the host and runs one job at a time on laptops and small Macs", async () => {
    const { defaultCapacity, vmSizeFor } = await import("./lib/host");
    expect(vmSizeFor({ cpu_cores: 8, memory_gb: 8 })).toEqual({ cpus: 2, memory_mib: 2048 });
    expect(vmSizeFor({ cpu_cores: 10, memory_gb: 16 })).toEqual({ cpus: 3, memory_mib: 4096 });
    expect(vmSizeFor({ cpu_cores: 14, memory_gb: 24 })).toEqual({ cpus: 4, memory_mib: 6144 });
    expect(vmSizeFor({ cpu_cores: 24, memory_gb: 128 })).toEqual({ cpus: 4, memory_mib: 6144 });
    expect(defaultCapacity({ os: "macos", memory_gb: 24, has_battery: true })).toBe(1);
    expect(defaultCapacity({ os: "macos", memory_gb: 8, has_battery: false })).toBe(1);
    expect(defaultCapacity({ os: "macos", memory_gb: 32, has_battery: false })).toBe(2);
    expect(defaultCapacity({ os: "linux", memory_gb: 64, has_battery: false })).toBe(1);
  });
});

describe("laptop default policy", () => {
  it("agentfirst: a laptop starts with plugged_in_only and an existing policy is never overwritten", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "bh-policy-"));
    process.env.BUILDHOUND_AGENT_HOME = home;
    process.env.BUILDHOUND_HAS_BATTERY = "1";
    const { writeDefaultPolicy } = await import("./lib/agent-home");
    const { hasBattery } = await import("./lib/host");
    expect(hasBattery("macos")).toBe(true);
    const first = writeDefaultPolicy(true);
    expect(first.written).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "policy.json"), "utf8")).plugged_in_only).toBe(true);
    writeFileSync(join(home, "policy.json"), JSON.stringify({ paused: false, idle_only: true, plugged_in_only: false }));
    const second = writeDefaultPolicy(true);
    expect(second.written).toBe(false);
    expect(second.policy.idle_only).toBe(true);
    delete process.env.BUILDHOUND_HAS_BATTERY;
    delete process.env.BUILDHOUND_AGENT_HOME;
  });
});
