import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { prettyRunnerCleanup, type RunnerCleanupPreview } from "./commands/runner-cleanup";
import { stripAnsi } from "./lib/style";

const run = promisify(execFile);
const bin = inject("cliBin");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));
// No agent.json here, so --org never comes from the Mac running the tests.
const agentHome = mkdtempSync(path.join(tmpdir(), "buildhound-agent-home-"));

const GIB = 2 ** 30;
const REPORTED = "2026-10-19T09:00:00.000Z";
const storage = {
  used: { images: 56 * GIB, old_images: 4.6 * GIB, build_cache: 26 * GIB, package_cache: 2 * GIB },
  reclaimable: { old_images: 4.6 * GIB, build_cache: 26 * GIB, package_cache: 0 },
};
const preview = (id: string, name: string) =>
  id === "m1"
    ? { machine: { id, name }, reported_at: REPORTED, disk_free_bytes: 18 * GIB, disk_total_bytes: 494 * GIB, storage, cleanup: null, next: `buildhound runner cleanup --org acme --machine ${name} --yes` }
    : { machine: { id, name }, reported_at: REPORTED, disk_free_bytes: 90 * GIB, disk_total_bytes: 256 * GIB, storage: null, cleanup: null, next: `update the Buildhound agent on ${name} (buildhound runner add --org acme --yes), then buildhound runner cleanup --org acme --machine ${name}` };

const requests: Array<{ method: string; path: string }> = [];
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c: string) => (text += c));
  req.on("end", () => {
    requests.push({ method: req.method ?? "", path: req.url ?? "" });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/machines" && url.searchParams.get("owner") === "acme") return send(200, { owner: "acme", machines: [{ id: "m1", name: "Benys-MacBook-Pro" }, { id: "m2", name: "mini-01" }], failover: {} });
    if (url.pathname === "/v1/machines") return send(403, { error: { code: "NOT_ADMIN", message: "you are not an admin of other", next: "ask an organisation admin to run this command" } });
    const m = /^\/v1\/machines\/(m[12])\/cleanup$/.exec(url.pathname);
    if (m) {
      const name = m[1] === "m1" ? "Benys-MacBook-Pro" : "mini-01";
      if (req.method === "GET") return send(200, preview(m[1]!, name));
      if (req.method === "POST") return send(200, { machine: { id: m[1], name }, status: "requested", requested_at: "2026-10-19T10:00:00.000Z", reclaimable_bytes: m[1] === "m1" ? 30.6 * GIB : null, next: `buildhound runner cleanup --org acme --machine ${name}` });
    }
    send(404, { error: { code: "NOT_FOUND", message: "not found", next: "buildhound runner status --org acme" } });
  });
});
let apiUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests.length = 0;
});

type Out = Record<string, unknown> & { error?: { code: string; message: string; next: string } };

/** No TTY, an empty PATH so `gh` cannot be found, no agent.json, and the fake control plane. */
async function cli(args: string[]) {
  const env = { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl, BUILDHOUND_AGENT_HOME: agentHome };
  try {
    const { stdout } = await run(process.execPath, [bin, ...args, "--api-url", apiUrl], { env });
    expect(stdout.trim().split("\n"), "exactly one line of JSON on stdout").toHaveLength(1);
    return { code: 0, json: JSON.parse(stdout.trim()) as Out };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    expect(err.stdout.trim().split("\n"), "exactly one line of JSON on stdout").toHaveLength(1);
    expect(err.stdout).not.toMatch(/\n\s+at /);
    return { code: err.code, json: JSON.parse(err.stdout.trim()) as Out };
  }
}

describe("agentfirst: runner cleanup", () => {
  it("agentfirst: runner cleanup without --yes only reads what the machine reported, with --yes as next", async () => {
    const r = await cli(["runner", "cleanup", "--org", "acme", "--machine", "Benys-MacBook-Pro"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      status: "preview",
      owner: "acme",
      machine: { id: "m1", name: "Benys-MacBook-Pro" },
      reported_at: REPORTED,
      disk_free_bytes: 18 * GIB,
      disk_total_bytes: 494 * GIB,
      storage,
      reclaimable_bytes: 30.6 * GIB,
      cleanup: null,
      next: "buildhound runner cleanup --org acme --machine Benys-MacBook-Pro --yes",
    });
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/machines?owner=acme", "GET /v1/machines/m1/cleanup"]);
  });

  it("agentfirst: runner cleanup --yes asks the machine through the control plane", async () => {
    const r = await cli(["runner", "cleanup", "--org", "acme", "--machine", "m1", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ status: "requested", owner: "acme", machine: { id: "m1", name: "Benys-MacBook-Pro" }, requested_at: "2026-10-19T10:00:00.000Z", reclaimable_bytes: 30.6 * GIB, next: "buildhound runner cleanup --org acme --machine Benys-MacBook-Pro" });
    expect(requests.filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/v1/machines/m1/cleanup"]);
  });

  it("agentfirst: runner cleanup on an agent that reports no sizes says to update it", async () => {
    const r = await cli(["runner", "cleanup", "--org", "acme", "--machine", "mini-01"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: "preview", storage: null, reclaimable_bytes: null });
    expect(r.json.next).toContain("update the Buildhound agent on mini-01");
  });

  it("agentfirst: runner cleanup errors carry a next step: no machine, no org, unknown machine, not an admin", async () => {
    const noMachine = await cli(["runner", "cleanup", "--org", "acme"]);
    expect(noMachine.code).toBe(2);
    expect(noMachine.json.error).toMatchObject({ code: "USAGE", next: "buildhound runner status --org acme" });
    const noOrg = await cli(["runner", "cleanup", "--machine", "mini-01"]);
    expect(noOrg.json.error).toMatchObject({ code: "USAGE", next: expect.stringContaining("--org <login>") });
    const unknown = await cli(["runner", "cleanup", "--org", "acme", "--machine", "nope", "--yes"]);
    expect(unknown.json.error).toMatchObject({ code: "NOT_FOUND", next: "buildhound runner status --org acme" });
    const other = await cli(["runner", "cleanup", "--org", "other", "--machine", "x"]);
    expect(other.json.error).toMatchObject({ code: "NOT_ADMIN", next: expect.any(String) });
    expect(requests.some((q) => q.method === "POST")).toBe(false);
  });
});

describe("runner cleanup in a terminal", () => {
  const base: RunnerCleanupPreview = { status: "preview", owner: "acme", machine: { id: "m1", name: "Benys-MacBook-Pro" }, reported_at: new Date().toISOString(), disk_free_bytes: 18 * GIB, disk_total_bytes: 494 * GIB, storage, reclaimable_bytes: 30.6 * GIB, cleanup: null, next: "buildhound runner cleanup --org acme --machine Benys-MacBook-Pro --yes" };

  it("shows each kind with what clearing frees, then the total", () => {
    const out = stripAnsi(prettyRunnerCleanup(base));
    expect(out).toContain("Buildhound on Benys-MacBook-Pro  18 GB free of 494 GB");
    expect(out).toMatch(/Image in use\s+56 GB\s+-/);
    expect(out).toMatch(/Old images\s+4\.6 GB\s+4\.6 GB/);
    expect(out).toMatch(/Image build cache\s+26 GB\s+26 GB/);
    expect(out).toMatch(/Package caches\s+2 GB\s+-/);
    expect(out).toContain("Clearing Buildhound's leftovers frees about 30.6 GB.");
    expect(out).toContain("Next: buildhound runner cleanup --org acme --machine Benys-MacBook-Pro --yes");
  });

  it("says when nothing of Buildhound's is left, and what the last cleanup freed", () => {
    const out = stripAnsi(prettyRunnerCleanup({ ...base, reclaimable_bytes: 0, storage: { ...storage, reclaimable: { old_images: 0, build_cache: 0, package_cache: 0 } }, cleanup: { requested_at: base.reported_at!, status: "done", finished_at: base.reported_at, bytes_freed: 31 * GIB, freed: storage.reclaimable } }));
    expect(out).toContain("Nothing of Buildhound's to clear. The rest is your own files.");
    expect(out).toContain("Last cleanup freed 31 GB");
  });

  it("confirms a request", () => {
    const out = stripAnsi(prettyRunnerCleanup({ status: "requested", owner: "acme", machine: { id: "m1", name: "Benys-MacBook-Pro" }, requested_at: "x", reclaimable_bytes: 30.6 * GIB, next: "buildhound runner cleanup --org acme --machine Benys-MacBook-Pro" }));
    expect(out).toContain("✓ Cleanup requested on Benys-MacBook-Pro (about 30.6 GB)");
  });
});
