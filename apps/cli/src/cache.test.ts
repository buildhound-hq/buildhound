import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { prettyCacheClear, prettyCacheList, type CacheListResult } from "./commands/cache";
import { stripAnsi } from "./lib/style";

const run = promisify(execFile);
const bin = inject("cliBin");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

const REPORTED = "2026-10-17T09:00:00.000Z";
const caches = (id: string, name: string) =>
  id === "m1"
    ? { machine: { id, name }, reported_at: REPORTED, bytes: 3 * 2 ** 30, limit_bytes: 50 * 2 ** 30, repositories: [{ repository: "acme/app", bytes: 3 * 2 ** 30 - 512, last_used_at: REPORTED, in_use: true, clear_pending: false }, { repository: "acme/site", bytes: 512, last_used_at: null, in_use: false, clear_pending: false }], pending_clear: null, next: "x" }
    : { machine: { id, name }, reported_at: null, bytes: null, limit_bytes: null, repositories: [], pending_clear: null, next: "x" };

const requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c: string) => (text += c));
  req.on("end", () => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", body: text ? JSON.parse(text) : null });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/machines" && url.searchParams.get("owner") === "acme") return send(200, { owner: "acme", machines: [{ id: "m1", name: "mini-01" }, { id: "m2", name: "laptop" }], failover: {} });
    if (url.pathname === "/v1/machines" && url.searchParams.get("owner") === "empty") return send(200, { owner: "empty", machines: [], failover: {} });
    if (url.pathname === "/v1/machines") return send(403, { error: { code: "NOT_ADMIN", message: "you are not an admin of other", next: "ask an organisation admin to run this command" } });
    const m = /^\/v1\/machines\/(m[12])\/caches(\/clear)?$/.exec(url.pathname);
    if (m) {
      const name = m[1] === "m1" ? "mini-01" : "laptop";
      if (!m[2] && req.method === "GET") return send(200, caches(m[1]!, name));
      if (m[2] && req.method === "POST") {
        const repository = (JSON.parse(text || "{}") as { repository?: string }).repository ?? null;
        return send(200, { machine: { id: m[1], name }, repository, status: "requested", requested_at: "2026-10-17T10:00:00.000Z", next: "buildhound runner status --org acme" });
      }
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

/** No TTY, an empty PATH so `gh` cannot be found, and the fake control plane. */
async function cli(args: string[], token = "test-token") {
  const env = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl };
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

describe("agentfirst: cache", () => {
  it("agentfirst: cache list prints every machine's caches as the heartbeat reported them, with clear as next", async () => {
    const r = await cli(["cache", "list", "--org", "acme"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ owner: "acme", repository: null, bytes: 3 * 2 ** 30, next: "buildhound cache clear --org acme --yes" });
    const machines = r.json.machines as Array<{ machine: { name: string }; reported_at: string | null; repositories: unknown[] }>;
    expect(machines.map((m) => [m.machine.name, m.reported_at, m.repositories.length])).toEqual([["mini-01", REPORTED, 2], ["laptop", null, 0]]);
    expect(machines[0]).not.toHaveProperty("next");
    // Read only: two reads per machine list, and nothing written.
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/machines?owner=acme", "GET /v1/machines/m1/caches", "GET /v1/machines/m2/caches"]);
  });

  it("agentfirst: cache status is cache list, and --machine and --repository narrow it", async () => {
    const r = await cli(["cache", "status", "--org", "acme", "--machine", "mini-01", "--repository", "ACME/site"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ repository: "ACME/site", bytes: 512, machines: [{ machine: { id: "m1" }, repositories: [{ repository: "acme/site", bytes: 512 }] }], next: "buildhound cache clear --org acme --machine mini-01 --repository ACME/site --yes" });
    // A machine that never reported points at its agent version instead.
    const laptop = await cli(["cache", "list", "--org", "acme", "--machine", "m2"]);
    expect(laptop.json).toMatchObject({ machines: [{ machine: { name: "laptop" }, reported_at: null }], next: "buildhound runner status --org acme" });
  });

  it("agentfirst: cache clear without --yes and without a TTY fails CONFIRM_REQUIRED and changes nothing", async () => {
    const r = await cli(["cache", "clear", "--org", "acme", "--repository", "acme/app"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: "CONFIRM_REQUIRED", next: "buildhound cache clear --org acme --repository acme/app --yes" });
    expect(requests).toEqual([]);
  });

  it("agentfirst: cache clear --yes asks every machine, or the one named, and is idempotent", async () => {
    const all = await cli(["cache", "clear", "--org", "acme", "--yes"]);
    expect(all.code).toBe(0);
    expect(all.json).toEqual({
      status: "requested",
      owner: "acme",
      repository: null,
      machines: [{ id: "m1", name: "mini-01", requested_at: "2026-10-17T10:00:00.000Z" }, { id: "m2", name: "laptop", requested_at: "2026-10-17T10:00:00.000Z" }],
      next: "buildhound cache list --org acme",
    });
    expect(requests.filter((q) => q.method === "POST").map((q) => [q.path, q.body])).toEqual([["/v1/machines/m1/caches/clear", {}], ["/v1/machines/m2/caches/clear", {}]]);

    requests.length = 0;
    const one = await cli(["cache", "clear", "--org", "acme", "--machine", "mini-01", "--repository", "acme/app", "--yes"]);
    const again = await cli(["cache", "clear", "--org", "acme", "--machine", "mini-01", "--repository", "acme/app", "--yes"]);
    expect(again.json).toEqual(one.json);
    expect(one.json).toMatchObject({ repository: "acme/app", machines: [{ name: "mini-01" }], next: "buildhound cache list --org acme --machine mini-01 --repository acme/app" });
    expect(requests.filter((q) => q.method === "POST").map((q) => q.body)).toEqual([{ repository: "acme/app" }, { repository: "acme/app" }]);
  });

  it("agentfirst: cache errors carry code, message and next", async () => {
    const cases: Array<{ args: string[]; code: string; exit: number; next: string }> = [
      { args: ["cache", "list"], code: "USAGE", exit: 2, next: "buildhound cache list --org <login>" },
      { args: ["cache", "clear", "--yes"], code: "USAGE", exit: 2, next: "buildhound cache clear --org <login> --yes" },
      { args: ["cache", "clear", "--org", "acme", "--repository", "app", "--yes"], code: "USAGE", exit: 2, next: "buildhound cache clear --org acme --repository <owner/name>" },
      { args: ["cache", "list", "--org", "acme", "--machine", "studio"], code: "NOT_FOUND", exit: 2, next: "buildhound runner status --org acme" },
      { args: ["cache", "clear", "--org", "empty", "--yes"], code: "NOT_FOUND", exit: 2, next: "buildhound runner add --org empty" },
      { args: ["cache", "list", "--org", "other"], code: "NOT_ADMIN", exit: 3, next: "ask an organisation admin to run this command" },
      { args: ["cache"], code: "USAGE", exit: 2, next: "buildhound cache --help" },
    ];
    for (const c of cases) {
      const r = await cli(c.args);
      expect(r.code, c.args.join(" ")).toBe(c.exit);
      expect(r.json.error, c.args.join(" ")).toMatchObject({ code: c.code, next: c.next });
      expect(r.json.error?.message).toBeTruthy();
    }
    const noToken = await cli(["cache", "list", "--org", "acme"], "");
    expect(noToken.json.error).toMatchObject({ code: "TOKEN_REQUIRED" });
    expect(noToken.json.error?.next).toContain("buildhound cache list --org acme");
  });
});

describe("cache output for people", () => {
  const list: CacheListResult = {
    owner: "acme",
    repository: null,
    bytes: 3 * 2 ** 30,
    machines: [
      { ...caches("m1", "mini-01"), pending_clear: { requested_at: REPORTED, repository: null } } as CacheListResult["machines"][number],
      caches("m2", "laptop") as CacheListResult["machines"][number],
    ],
    next: "buildhound cache clear --org acme --yes",
  };

  it("shows each machine's total against its cap, each repository, and a machine that has not reported", () => {
    const text = stripAnsi(prettyCacheList(list));
    expect(text).toContain("Package caches on 2 machines for acme");
    expect(text).toMatch(/mini-01 {2}3 GB of 50 GB {2}reported /);
    expect(text).toContain("Clear requested");
    expect(text).toContain("for every repository. It applies within 30 seconds.");
    expect(text).toMatch(/acme\/app\s+3 GB\s+in use/);
    expect(text).toMatch(/acme\/site\s+under 1 MB/);
    expect(text).toContain("laptop  No cache sizes reported yet. They come with Buildhound agent 0.1.35.");
    expect(text.trim().split("\n").at(-1)).toBe("Next: buildhound cache clear --org acme --yes");
    expect(text.includes(String.fromCharCode(0x2014))).toBe(false);
  });

  it("says what a clear does and when", () => {
    const text = stripAnsi(prettyCacheClear({ status: "requested", owner: "acme", repository: "acme/app", machines: [{ id: "m1", name: "mini-01", requested_at: REPORTED }], next: "buildhound cache list --org acme" }));
    expect(text.split("\n")[0]).toBe("✓ Clear requested for acme/app's caches on mini-01");
    expect(text).toContain("within 30 seconds");
  });
});
