import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { parseInputs, prettyRerun, prettyRun, type RunListResult } from "./commands/run";
import { stripAnsi } from "./lib/style";

const run = promisify(execFile);
const bin = inject("cliBin");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

const LISTING = {
  role: "admin",
  repository: "acme/app",
  default_branch: "main",
  branches: ["main", "feature"],
  workflows: [{ id: 11, name: "Release", path: ".github/workflows/release.yml", inputs: [{ name: "build", description: null, required: true, type: "number", default: null, options: [] }] }],
  not_dispatchable: [{ name: "CI", path: ".github/workflows/ci.yml", reason: "no_workflow_dispatch" }],
  can_run: true,
  docs_url: "https://buildhound.sh/docs/workflows#by-hand",
  next: "buildhound run --repo acme/app --workflow release.yml --ref main --yes",
};

const requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c: string) => (text += c));
  req.on("end", () => {
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    requests.push({ method: req.method ?? "", path: req.url ?? "", body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/accounts/acme/workflows" && req.method === "GET") return send(200, LISTING);
    if (url.pathname === "/v1/accounts/acme/workflows/dispatch" && req.method === "POST") {
      if (body?.workflow === "ci.yml") return send(409, { error: { code: "NOT_DISPATCHABLE", message: ".github/workflows/ci.yml on main has no on: workflow_dispatch", next: "add workflow_dispatch to its on: block" } });
      return send(200, { status: "dispatched", repository: "acme/app", workflow: { id: 11, name: "Release", path: ".github/workflows/release.yml" }, ref: body?.ref ?? "main", inputs: body?.inputs ?? {}, dispatched_at: "2026-10-18T10:00:00.000Z", runs_url: "https://github.com/acme/app/actions/workflows/release.yml", next: "buildhound jobs --org acme --repository acme/app" });
    }
    const rerun = /^\/v1\/accounts\/acme\/jobs\/([^/]+)\/rerun$/.exec(url.pathname);
    if (rerun && req.method === "POST") {
      if (rerun[1] === "busy") return send(409, { error: { code: "RUN_IN_PROGRESS", message: "run 900 is still in progress", next: "buildhound job busy --org acme" } });
      return send(200, { status: "requested", scope: body?.failed ? "failed_jobs" : "job", repository: "acme/app", run_id: 900, job: { id: rerun[1], name: "test" }, run_url: "https://github.com/acme/app/actions/runs/900", next: "buildhound jobs --org acme --repository acme/app" });
    }
    send(404, { error: { code: "NOT_FOUND", message: "not found", next: "buildhound jobs --org acme" } });
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

describe("agentfirst: run", () => {
  it("agentfirst: run without --workflow lists what can be started, read only, with next", async () => {
    const r = await cli(["run", "--repo", "acme/app"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ mode: "list", repository: "acme/app", workflows: [{ path: ".github/workflows/release.yml" }], next: LISTING.next });
    expect(requests.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /v1/accounts/acme/workflows?repository=acme%2Fapp"]);
  });

  it("agentfirst: run --workflow without --yes refuses with the --yes command as next and starts nothing", async () => {
    const r = await cli(["run", "--repo", "acme/app", "--workflow", "release.yml", "--input", "build=42"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: "CONFIRM_REQUIRED", next: "buildhound run --repo acme/app --workflow release.yml --input build=42 --yes" });
    expect(requests).toEqual([]);
  });

  it("agentfirst: run --yes dispatches with the ref and inputs and returns the run's page", async () => {
    const r = await cli(["run", "--repo", "acme/app", "--workflow", "release.yml", "--ref", "feature", "--input", "build=42", "--input", "note=a=b", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: "dispatched", ref: "feature", runs_url: "https://github.com/acme/app/actions/workflows/release.yml", next: "buildhound jobs --org acme --repository acme/app" });
    expect(requests[0]).toEqual({ method: "POST", path: "/v1/accounts/acme/workflows/dispatch", body: { repository: "acme/app", workflow: "release.yml", ref: "feature", inputs: { build: "42", note: "a=b" } } });
  });

  it("agentfirst: run passes the control plane's error and next through, and checks its own flags", async () => {
    const plain = await cli(["run", "--repo", "acme/app", "--workflow", "ci.yml", "--yes"]);
    expect(plain.code).not.toBe(0);
    expect(plain.json.error).toMatchObject({ code: "NOT_DISPATCHABLE", next: "add workflow_dispatch to its on: block" });
    expect((await cli(["run"])).json.error).toMatchObject({ code: "USAGE", next: "buildhound run --repo <owner/name>" });
    expect((await cli(["run", "--repo", "acme/app", "--workflow", "release.yml", "--input", "nope", "--yes"])).json.error?.code).toBe("USAGE");
    expect((await cli(["run", "--repo", "acme/app", "--ref", "main"])).json.error?.code).toBe("USAGE");
    expect(requests).toHaveLength(1);
  });
});

describe("agentfirst: rerun", () => {
  it("agentfirst: rerun needs --org, --job and --yes, each refusal with next", async () => {
    expect((await cli(["rerun", "--job", "j1", "--yes"])).json.error?.code).toBe("USAGE");
    expect((await cli(["rerun", "--org", "acme", "--yes"])).json.error).toMatchObject({ code: "USAGE", next: "buildhound jobs --org acme --result failure" });
    const unconfirmed = await cli(["rerun", "--org", "acme", "--job", "j1", "--failed"]);
    expect(unconfirmed.json.error).toMatchObject({ code: "CONFIRM_REQUIRED", next: "buildhound rerun --org acme --job j1 --failed --yes" });
    expect(requests).toEqual([]);
  });

  it("agentfirst: rerun --yes asks the control plane, one job or the run's failed jobs", async () => {
    expect((await cli(["rerun", "--org", "acme", "--job", "j1", "--yes"])).json).toMatchObject({ status: "requested", scope: "job", run_id: 900 });
    expect((await cli(["rerun", "--org", "acme", "--job", "j1", "--failed", "--yes"])).json).toMatchObject({ scope: "failed_jobs" });
    expect(requests.map((x) => x.body)).toEqual([{}, { failed: true }]);
    const busy = await cli(["rerun", "--org", "acme", "--job", "busy", "--yes"]);
    expect(busy.code).not.toBe(0);
    expect(busy.json.error).toMatchObject({ code: "RUN_IN_PROGRESS", next: "buildhound job busy --org acme" });
  });
});

describe("run and rerun for people", () => {
  it("parses repeated name=value inputs", () => {
    expect(parseInputs(["a=1", "b=x=y", "c="], "buildhound run")).toEqual({ a: "1", b: "x=y", c: "" });
    expect(() => parseInputs(["=1"], "buildhound run")).toThrow(/name=value/);
  });

  it("shows the workflows with required inputs marked, and an empty list with the docs link", () => {
    const list = stripAnsi(prettyRun({ mode: "list", ...LISTING } as RunListResult));
    expect(list).toContain("Workflows you can run in acme/app");
    expect(list).toContain("release.yml");
    expect(list).toContain("build*");
    const none = stripAnsi(prettyRun({ mode: "list", ...LISTING, workflows: [], can_run: false } as RunListResult));
    expect(none).toContain("No workflow in acme/app can be started by hand");
    expect(none).toContain("https://buildhound.sh/docs/workflows#by-hand");
    expect(none).toContain("Only admins of acme can start them.");
    expect(stripAnsi(prettyRerun({ status: "requested", scope: "job", repository: "acme/app", run_id: 900, job: { id: "j1", name: "test" }, run_url: "https://github.com/acme/app/actions/runs/900", next: "buildhound jobs --org acme" }))).toContain("Re-run requested for test in acme/app");
  });
});
