import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prettyPlan, type PlanResult } from "./commands/account";
import { prettyJobs, prettyOverview, type JobsResult, type OverviewResult } from "./commands/jobs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

const JOB = {
  id: "0b8e2f8a-1111-4222-8333-944455556666",
  repository: "acme/app",
  run_id: 12,
  job_id: "j",
  name: "test",
  label: "buildhound-linux",
  machine: { id: "m1", name: "mini-01" },
  status: "completed",
  conclusion: "success",
  queued_at: "2026-10-14T10:00:00.000Z",
  started_at: "2026-10-14T10:00:10.000Z",
  completed_at: "2026-10-14T10:02:15.000Z",
  wait_seconds: 10,
  duration_seconds: 125,
  hosted_equivalent_cents: 2,
  run_url: "https://github.com/acme/app/actions/runs/12",
};

const requests: string[] = [];
const server = http.createServer((req, res) => {
  requests.push(req.url ?? "");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/v1/accounts/other/jobs") return send(403, { error: { code: "FORBIDDEN", message: "this GitHub account cannot see other", next: "sign in as a member of other on GitHub" } });
  if (url.pathname === "/v1/accounts/acme/jobs") return send(200, { role: "admin", jobs: [JOB], next_before: url.searchParams.get("limit") === "1" ? JOB.started_at : null });
  if (url.pathname === `/v1/accounts/acme/jobs/${JOB.id}`) return send(200, { role: "admin", job: JOB, reruns: [], calculation: "3 min rounded up from 125 s" });
  if (url.pathname === "/v1/accounts/acme/overview")
    return send(200, {
      role: "admin",
      period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
      jobs_on_machines: 1,
      machine_minutes: 3,
      hosted_equivalent_cents: 2,
      fell_back: 1,
      machines: [{ id: "m1", name: "mini-01", status: "online", running_jobs: 0, trust: "trusted" }],
      recent_jobs: [JOB],
      attention: [{ kind: "machine_offline", detail: "laptop is offline", next: "buildhound runner status --org acme" }],
    });
  if (url.pathname === "/v1/accounts/acme/repositories")
    return send(200, { role: "admin", route_next: "buildhound route --repo <owner/name> --apply", repositories: [{ full_name: "acme/app", private: true, archived: false, jobs: 3, last_job_at: null, labels: ["buildhound-linux"], state: "routed" }, { full_name: "acme/site", private: false, archived: false, jobs: 0, last_job_at: null, labels: [], state: "not_routed" }] });
  if (url.pathname === "/v1/accounts/acme/plan") return send(200, { role: "admin", plan: "team", effective: "none", trial_ends_at: null, valid_until: null, machines: 2, price_per_machine_cents: 2400, price_per_machine_annual_cents: 24000, free_machine_limit: 2, checkout_next: "buildhound billing checkout --plan team --json" });
  if (url.pathname === "/v1/accounts/acme/audit") return send(200, { events: [{ id: "e1", actor: "admin", action: "machine.removed", target: "mini-01", source: req.headers["x-buildhound-source"], detail: {}, created_at: "2026-10-14T10:00:00.000Z" }], next_before: null });
  if (url.pathname === "/v1/accounts/acme/settings") return send(200, { role: "admin", defaults: req.method === "PUT" ? { performance: "quiet" } : {} });
  if (url.pathname === "/v1/accounts/acme/savings") return send(200, { role: "admin", months: [{ month: "2026-10", jobs: 1, minutes: 3, hosted_equivalent_cents: 2 }], machines: [], calculation: "how" });
  send(404, { error: { code: "NOT_FOUND", message: "not found", next: "buildhound jobs --org acme" } });
});
let apiUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Out = Record<string, unknown> & { error?: { code: string; next: string } };

async function cli(args: string[], token = "test-token") {
  const env = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl };
  try {
    const { stdout } = await run(process.execPath, [tsx, entry, ...args, "--api-url", apiUrl], { env });
    return { code: 0, json: JSON.parse(stdout.trim()) as Out };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, json: JSON.parse(err.stdout.trim()) as Out };
  }
}

describe("agentfirst: read commands", () => {
  it("agentfirst: jobs prints one JSON object with the jobs, the role and the next page as next", async () => {
    const r = await cli(["jobs", "--org", "acme", "--repository", "acme/app", "--result", "success", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ owner: "acme", role: "admin", jobs: [{ id: JOB.id, name: "test" }], next: `buildhound jobs --org acme --before ${JOB.started_at}` });
    expect(requests.at(-1)).toBe("/v1/accounts/acme/jobs?repository=acme%2Fapp&result=success&limit=1");
  });

  it("agentfirst: job, overview and savings each print one JSON object with next", async () => {
    const job = await cli(["job", JOB.id, "--org", "acme"]);
    expect(job.json).toMatchObject({ job: { id: JOB.id }, calculation: expect.any(String), next: `open ${JOB.run_url}` });
    const overview = await cli(["overview", "--org", "acme", "--month", "2026-10"]);
    expect(overview.json).toMatchObject({ jobs_on_machines: 1, fell_back: 1, next: "buildhound runner status --org acme" });
    expect(requests.at(-1)).toBe("/v1/accounts/acme/overview?month=2026-10");
    const savings = await cli(["savings", "--org", "acme", "--months", "3"]);
    expect(savings.json).toMatchObject({ months: [{ month: "2026-10" }], calculation: "how", next: "buildhound jobs --org acme" });
  });

  it("agentfirst: repos, plan, audit and settings each print one JSON object with next", async () => {
    const repos = await cli(["repos", "--org", "acme"]);
    expect(repos.json).toMatchObject({ owner: "acme", repositories: [{ state: "routed" }, { state: "not_routed" }], next: "buildhound route --repo acme/site --apply" });
    const plan = await cli(["plan", "--org", "acme"]);
    expect(plan.json).toMatchObject({ plan: "team", effective: "none", next: "buildhound billing checkout --plan team --json" });
    const audit = await cli(["audit", "--org", "acme"]);
    expect(audit.json).toMatchObject({ events: [{ action: "machine.removed", source: "cli" }], next: "buildhound runner status --org acme" });
    const read = await cli(["settings", "--org", "acme"]);
    expect(read.json).toMatchObject({ defaults: {}, changed: false });
    const set = await cli(["settings", "--org", "acme", "--performance", "quiet"]);
    expect(set.json).toMatchObject({ defaults: { performance: "quiet" }, changed: true });
    const bad = await cli(["settings", "--org", "acme", "--performance", "fast"]);
    expect(bad.code).toBe(2);
    expect(bad.json.error).toMatchObject({ code: "USAGE" });
  });

  it("agentfirst: read commands without --org fail USAGE with the command to run as next", async () => {
    for (const args of [["jobs"], ["overview"], ["savings"], ["job", "x"], ["repos"], ["plan"], ["audit"], ["settings"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.json.error).toMatchObject({ code: "USAGE", next: expect.stringContaining("--org") });
    }
  });

  it("agentfirst: an account the person cannot see and a bad token come back as error envelopes", async () => {
    const forbidden = await cli(["jobs", "--org", "other"]);
    expect(forbidden.code).not.toBe(0);
    expect(forbidden.json.error).toMatchObject({ code: "FORBIDDEN", next: expect.any(String) });
    const bad = await cli(["jobs", "--org", "acme"], "nope");
    expect(bad.json.error).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("read commands for people", () => {
  it("prints gh's table: a count line, the symbol column first, the next command last", () => {
    const text = prettyJobs({ owner: "acme", role: "member", jobs: [JOB as JobsResult["jobs"][number]], next_before: null, next: "buildhound job x --org acme" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Showing 1 recent job for acme in repositories you can read");
    expect(lines[2]).toMatch(/^ {3}JOB\s+REPOSITORY\s+MACHINE\s+WAITED\s+TOOK\s+ON GITHUB\s+AGE$/);
    expect(lines[3]).toMatch(/^✓ {2}test\s+acme\/app\s+mini-01\s+10s\s+2m 5s\s+\$\d+\.\d\d\s+\S/);
    expect(text.trim().split("\n").at(-1)).toBe("Next: buildhound job x --org acme");
    expect(text).not.toMatch(/[·|]/);
  });

  it("puts what needs you under one ! each", () => {
    const text = prettyOverview({
      owner: "acme",
      role: "admin",
      period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
      jobs_on_machines: 0,
      succeeded: 0,
      daily: [],
      wait: { macs: { median_seconds: null, jobs: 0 }, github: { median_seconds: null, jobs: 0, source: "none" }, by_os: { macos: { macs: { median_seconds: null, jobs: 0 }, github: { median_seconds: null, jobs: 0, source: "none" } }, linux: { macs: { median_seconds: null, jobs: 0 }, github: { median_seconds: null, jobs: 0, source: "none" } } } },
      machine_minutes: 0,
      hosted_equivalent_cents: 0,
      fell_back: 0,
      machines: [],
      recent_jobs: [],
      attention: [{ kind: "needs_plan", detail: "2 private repositories route to GitHub-hosted until a plan is chosen", next: "buildhound billing checkout --plan team --json" }],
      next: "buildhound billing checkout --plan team --json",
    } as OverviewResult);
    expect(text.split("\n")[0]).toBe("acme, October 2026");
    expect(text).toContain("\n! 2 private repositories route to GitHub-hosted until a plan is chosen\n  buildhound billing checkout --plan team --json");
  });
});

describe("plan output", () => {
  const base: PlanResult = { owner: "acme", role: "admin", plan: "team", effective: "none", trial_ends_at: null, valid_until: null, machines: 2, price_per_machine_cents: 2400, price_per_machine_annual_cents: 24000, free_machine_limit: 2, checkout_next: "buildhound billing checkout --plan team --json", next: "buildhound billing checkout --plan team --json" };

  it("prices Team annually by default with the monthly price beside it, and names the refund", () => {
    const text = prettyPlan(base);
    expect(text).toContain("$20 a machine a month billed annually, or $24 monthly");
    expect(text).toContain("2 machines, $40 a month");
    expect(text).toContain("the first payment, on request within 30 days");
    expect(text).not.toMatch(/trial/i);
  });

  it("prices Personal annually by default too, at $96 a year", () => {
    const text = prettyPlan({ ...base, owner: "benyd", plan: "personal", effective: "personal", valid_until: "2026-11-15T00:00:00.000Z", price_per_machine_cents: 1000, price_per_machine_annual_cents: 9600 });
    expect(text).toContain("$8 a machine a month billed annually, or $10 monthly");
    expect(text).toContain("2 machines, $16 a month");
    expect(text).toMatch(/Status\s+Active/);
  });
});
