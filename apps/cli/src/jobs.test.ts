import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { prettyAudit, prettyPlan, type AuditResult, type PlanResult } from "./commands/account";
import { prettyJob, prettyJobs, prettyOverview, type JobResult, type JobsResult, type OverviewResult } from "./commands/jobs";
import { prettyStatus, type StatusResult } from "./commands/status";

const run = promisify(execFile);
const bin = inject("cliBin");
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

/** A routed job that ran on GitHub-hosted, as GET /jobs?ran_on=all lists it. */
const HOSTED_JOB = {
  ...JOB,
  id: "gh-901",
  name: "deploy",
  label: "buildhound-macos",
  machine: { id: "github-hosted", name: "GitHub-hosted", os: "macos" },
  hosted_equivalent_cents: null,
  ran_on: "github_hosted",
  hosted_reason: { code: "needs_trusted_machine", summary: "Jobs with secrets need a trusted machine", job: "It uses secrets and no trusted Mac was free.", fix: "Set up a trusted Mac: FileVault on, then Trust this Mac.", who: "you", tone: "attention", next: "buildhound runner set --org acme --machine mini --trusted on" },
};

/** The board's example (W-WhyHosted): macOS held by both Macs, Linux on the Macs, Linux x64 not served. */
const ROUTING = {
  role: "admin",
  owner: "acme",
  families: [
    {
      label: "buildhound-macos", name: "macOS", where: "github_hosted", reason: "machines_held", summary: "Your machines are holding new jobs back", fix: "Comes back on its own once a machine takes jobs again.", who: "automatic", tone: "attention", next: "buildhound status --org acme", mode: "auto", changed_at: "2026-10-14T10:00:00.000Z",
      machines: [{ id: "a", name: "Benys-MacBook-Pro", os: "macos", why: "in_use", phrase: "in use", since: null }, { id: "b", name: "Benys-Mac-mini", os: "macos", why: "memory_pressure", phrase: "short on memory", since: null }],
      secrets: { where: "github_hosted", reason: "needs_trusted_machine", summary: "Jobs with secrets need a trusted machine", fix: "Set up a trusted Mac: FileVault on, then Trust this Mac.", who: "you", tone: "attention", next: "buildhound runner set --org acme --machine Benys-Mac-mini --trusted on" },
    },
    {
      label: "buildhound-linux", name: "Linux", where: "machines", reason: "machine_online", summary: "Your machines take new jobs", fix: "Nothing to fix.", who: "nobody", tone: "ok", next: "buildhound jobs --org acme", mode: "auto", changed_at: null,
      machines: [{ id: "a", name: "Benys-MacBook-Pro", os: "macos", why: "busy", phrase: "busy", since: null }, { id: "b", name: "Benys-Mac-mini", os: "macos", why: "free", phrase: "free", since: null }],
      secrets: { where: "machines", reason: "machine_online", summary: "Your machines take new jobs", fix: "Nothing to fix.", who: "nobody", tone: "ok", next: "buildhound jobs --org acme" },
    },
    { label: "buildhound-linux-x64", name: "Linux x64", where: "github_hosted", reason: "not_served", summary: "Your machines can't run this kind", fix: "Expected, nothing to fix; a Linux x64 machine would take them.", who: "nobody", tone: "quiet", next: "buildhound runner add --org acme --check", mode: "auto", changed_at: null, machines: [], secrets: null },
  ],
  trust_banner: { show: true, count: 12, days: 7, summary: "12 jobs with secrets ran on GitHub-hosted this week", fix: "Trust a Mac to run them here too.", can_dismiss: true, dismissed_until: null, next: "buildhound runner set --org acme --machine Benys-Mac-mini --trusted on" },
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
  // An organisation without Team: a member reading jobs, and an admin reading the audit log (entitlements.ts).
  const team = (feature: string, next: string) => ({ status: "needs_human", reason: "team_only", feature, url: "https://app.buildhound.sh/freeorg/settings/billing", next, error: { code: "NEEDS_TEAM", message: "this is part of Team, and freeorg is not on Team", next } });
  if (url.pathname === "/v1/accounts/freeorg/jobs") return send(403, team("member_access", "ask an admin of freeorg to upgrade to Team at https://app.buildhound.sh/freeorg/settings/billing"));
  if (url.pathname === "/v1/accounts/freeorg/audit") return send(403, team("audit_log", "buildhound billing checkout --org freeorg --plan team, then buildhound audit-log --org freeorg"));
  if (url.pathname === "/v1/accounts/other/jobs") return send(403, { error: { code: "FORBIDDEN", message: "this GitHub account cannot see other", next: "sign in as a member of other on GitHub" } });
  if (url.pathname === "/v1/accounts/acme/jobs")
    return send(200, {
      role: "admin",
      jobs: url.searchParams.get("ran_on") === "machine" ? [JOB] : [JOB, HOSTED_JOB],
      next_before: url.searchParams.get("limit") === "1" ? JOB.started_at : null,
      ...(url.searchParams.get("facets") === "1" ? { facets: { status: { failed: 1, running: 2 }, ran_on: { machine: 1, github_hosted: 2 }, machine: { "mini-01": 1, "GitHub-hosted": 2 }, repository: { "acme/app": 3 }, workflow: { ci: 3 }, os: { macos: 3 } } } : {}),
    });
  if (url.pathname === "/v1/accounts/acme/routing") return send(200, ROUTING);
  if (url.pathname === "/v1/accounts/freeorg/routing") return send(403, team("member_access", "ask an admin of freeorg to upgrade to Team at https://app.buildhound.sh/freeorg/settings/billing"));
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
    return send(200, { role: "admin", route_next: "buildhound route --repo <owner/name>", repositories: [{ full_name: "acme/app", private: true, archived: false, jobs: 3, last_job_at: null, labels: ["buildhound-linux"], state: "routed" }, { full_name: "acme/site", private: false, archived: false, jobs: 0, last_job_at: null, labels: [], state: "not_routed" }] });
  if (url.pathname === "/v1/accounts/acme/plan") return send(200, { role: "admin", plan: "team", effective: "none", trial_ends_at: null, valid_until: null, machines: 2, billable_machines: 0.4, active_machines_today: 1, period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" }, estimated_cents: null, price_per_machine_cents: 2400, price_per_machine_annual_cents: 24000, free_machine_limit: 2, checkout_next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" });
  if (url.pathname === "/v1/accounts/acme/audit" && url.searchParams.get("format") === "csv") {
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end("time,person,action,summary,target,source,changes\r\n2026-10-14T10:00:00.000Z,admin,machine.removed,admin removed mini-01,mini-01,cli,\r\n");
  }
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
  // An agent directory of its own, so a Buildhound agent connected on the machine running the tests is never read.
  const env = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl, BUILDHOUND_AGENT_HOME: emptyPath };
  try {
    const { stdout } = await run(process.execPath, [bin, ...args, "--api-url", apiUrl], { env });
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
    expect(r.json).toMatchObject({ owner: "acme", role: "admin", jobs: [{ id: JOB.id, name: "test" }, { id: "gh-901", ran_on: "github_hosted", hosted_reason: { code: "needs_trusted_machine", who: "you" } }], next: `buildhound jobs --org acme --repository acme/app --result success --limit 1 --before ${JOB.started_at}` });
    expect(requests.at(-1)).toBe("/v1/accounts/acme/jobs?repository=acme%2Fapp&result=success&limit=1");
    const machinesOnly = await cli(["jobs", "--org", "acme", "--ran-on", "machine"]);
    expect(machinesOnly.json).toMatchObject({ jobs: [{ id: JOB.id }] });
    expect(requests.at(-1)).toBe("/v1/accounts/acme/jobs?ran_on=machine");
    // Filters take several values, comma separated, as the API does; the next page keeps them.
    const filtered = await cli(["jobs", "--org", "acme", "--status", "failed,running", "--ran-on", "github_hosted", "--machine", "mini-01,github-hosted", "--workflow", "ci", "--os", "macos,linux", "--facets", "--limit", "1"]);
    expect(requests.at(-1)).toBe("/v1/accounts/acme/jobs?machine=mini-01%2Cgithub-hosted&workflow=ci&status=failed%2Crunning&ran_on=github_hosted&os=macos%2Clinux&limit=1&facets=1");
    expect(filtered.json.next).toBe(`buildhound jobs --org acme --machine mini-01,github-hosted --workflow ci --status failed,running --ran-on github_hosted --os macos,linux --limit 1 --before ${JOB.started_at}`);
    expect(filtered.json.facets).toMatchObject({ status: { failed: 1 } });
    for (const [flag, value] of [["--ran-on", "mars"], ["--status", "failed,broken"], ["--os", "beos"]] as const) {
      const bad = await cli(["jobs", "--org", "acme", flag, value]);
      expect(bad.code).toBe(2);
      expect(bad.json.error).toMatchObject({ code: "USAGE", next: expect.stringContaining(`buildhound jobs --org acme ${flag} `) });
    }
  });

  it("agentfirst: status prints one JSON object with each family's where, why, machines and the first step as next", async () => {
    const r = await cli(["status", "--org", "acme"]);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toBe("/v1/accounts/acme/routing");
    expect(r.json).toMatchObject({
      owner: "acme",
      families: [
        { label: "buildhound-macos", where: "github_hosted", reason: "machines_held", summary: "Your machines are holding new jobs back", who: "automatic", next: "buildhound status --org acme", machines: [{ name: "Benys-MacBook-Pro", why: "in_use" }, { name: "Benys-Mac-mini", why: "memory_pressure" }] },
        { label: "buildhound-linux", where: "machines" },
        { label: "buildhound-linux-x64", reason: "not_served", who: "nobody" },
      ],
      trust_banner: { show: true, count: 12 },
      // Nothing needs a person for routing itself, so the banner's step comes first.
      next: "buildhound runner set --org acme --machine Benys-Mac-mini --trusted on",
    });
    const team = await cli(["status", "--org", "freeorg"]);
    expect(team.code).toBe(0);
    expect(team.json).toMatchObject({ status: "needs_human", reason: "team_only" });
  });

  it("agentfirst: status without --org on a machine that is not connected fails USAGE with next", async () => {
    const r = await cli(["status"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: "USAGE", next: "buildhound status --org <login>" });
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
    expect(repos.json).toMatchObject({ owner: "acme", repositories: [{ state: "routed" }, { state: "not_routed" }], next: "buildhound route --repo acme/site" });
    const plan = await cli(["plan", "--org", "acme"]);
    expect(plan.json).toMatchObject({ plan: "team", effective: "none", billable_machines: 0.4, active_machines_today: 1, estimated_cents: null, next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" });
    // `audit-log` is the command (docs/BRAND.md, Glossary); `audit` stays as its alias.
    const audit = await cli(["audit", "--org", "acme"]);
    expect(audit.json).toMatchObject({ events: [{ action: "machine.removed", source: "cli" }], next: "buildhound runner status --org acme" });
    const auditLog = await cli(["audit-log", "--org", "acme"]);
    expect(auditLog.json).toMatchObject({ events: [{ action: "machine.removed", source: "cli" }], next: "buildhound runner status --org acme" });
    const read = await cli(["settings", "--org", "acme"]);
    expect(read.json).toMatchObject({ defaults: {}, changed: false });
    const set = await cli(["settings", "--org", "acme", "--performance", "quiet"]);
    expect(set.json).toMatchObject({ defaults: { performance: "quiet" }, changed: true });
    const bad = await cli(["settings", "--org", "acme", "--performance", "fast"]);
    expect(bad.code).toBe(2);
    expect(bad.json.error).toMatchObject({ code: "USAGE" });
  });

  it("agentfirst: audit-log takes search, filters, counts and folding, and exports CSV", async () => {
    const r = await cli(["audit-log", "--org", "acme", "--search", "performance", "--action", "settings,trust", "--machine", "mini-01", "--source", "cli,dashboard", "--from", "2026-10-01", "--facets", "--fold"]);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toBe("/v1/accounts/acme/audit?q=performance&action=settings%2Ctrust&machine=mini-01&source=cli%2Cdashboard&from=2026-10-01&facets=1&fold=1");
    const bad = await cli(["audit-log", "--org", "acme", "--action", "everything"]);
    expect(bad.code).toBe(2);
    expect(bad.json.error).toMatchObject({ code: "USAGE", next: "buildhound audit-log --org acme --action settings" });
    const env = { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl };
    const csv = await run(process.execPath, [bin, "audit-log", "--org", "acme", "--format", "csv", "--api-url", apiUrl], { env });
    expect(csv.stdout.split("\r\n")[0]).toBe("time,person,action,summary,target,source,changes");
    expect(requests.at(-1)).toBe("/v1/accounts/acme/audit?format=csv");
  });

  it("agentfirst: read commands without --org fail USAGE with the command to run as next", async () => {
    for (const args of [["jobs"], ["overview"], ["savings"], ["job", "x"], ["repos"], ["plan"], ["audit-log"], ["audit"], ["settings"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.json.error).toMatchObject({ code: "USAGE", next: expect.stringContaining("--org") });
    }
    expect((await cli(["audit"])).json.error?.next).toBe("buildhound audit-log --org <login>");
  });

  it("agentfirst: NEEDS_TEAM on jobs and audit-log prints needs_human with the billing page and the error, and exits 0", async () => {
    const jobs = await cli(["jobs", "--org", "freeorg"]);
    expect(jobs.code).toBe(0);
    expect(jobs.json).toMatchObject({
      status: "needs_human",
      reason: "team_only",
      feature: "member_access",
      url: "https://app.buildhound.sh/freeorg/settings/billing",
      next: "ask an admin of freeorg to upgrade to Team at https://app.buildhound.sh/freeorg/settings/billing",
      error: { code: "NEEDS_TEAM", next: expect.any(String) },
    });
    const audit = await cli(["audit-log", "--org", "freeorg"]);
    expect(audit.code).toBe(0);
    expect(audit.json).toMatchObject({ status: "needs_human", reason: "team_only", feature: "audit_log", next: "buildhound billing checkout --org freeorg --plan team, then buildhound audit-log --org freeorg", error: { code: "NEEDS_TEAM" } });
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
      attention: [{ kind: "needs_plan", detail: "2 private repositories route to GitHub-hosted until a plan is chosen", next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" }],
      next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing",
    } as OverviewResult);
    expect(text.split("\n")[0]).toBe("acme, October 2026");
    expect(text).toMatch(/Ran on GitHub-hosted\s+0/);
    expect(text).toContain("\n! 2 private repositories route to GitHub-hosted until a plan is chosen\n  a person chooses Team at https://app.buildhound.sh/acme/settings/billing");
  });
});

describe("audit log for people", () => {
  it("says what each change did, with each value before and after, and the counts", () => {
    const text = prettyAudit({
      owner: "acme",
      next: "x",
      next_before: null,
      events: [{ id: "1", actor: "BenyD", action: "machine.settings.changed", target: "mini", source: "cli", detail: {}, created_at: new Date().toISOString(), summary: "changed performance on mini", changes: [{ field: "Performance", from: "Balanced", to: "Max" }] }],
      facets: { action: { settings: 1, machine_added: 2 }, machine: { mini: 3 }, actor: { BenyD: 3 }, source: { cli: 3 } },
    } as AuditResult);
    expect(text).toContain("BenyD changed performance on mini  cli, just now");
    expect(text).toContain("  Performance: Balanced to Max");
    expect(text).toMatch(/Action\s+machine added 2, settings 1/);
  });
});

describe("status for people (W-WhyHosted board)", () => {
  it("prints each family's lines: where, why, each machine's why, then comes back on its own or the fix", () => {
    const text = prettyStatus({ ...(ROUTING as unknown as StatusResult), next: "buildhound runner set --org acme --machine Benys-Mac-mini --trusted on" });
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "macOS        GitHub-hosted for now",
      "             Your machines are holding new jobs back",
      "             Benys-MacBook-Pro  in use",
      "             Benys-Mac-mini     short on memory",
      "             Comes back on its own",
    ]);
    expect(lines[6]).toBe("Linux        Your 2 Macs, 1 busy");
    expect(text).toContain("Linux x64    GitHub-hosted, your machines can't run this kind");
    expect(text).toContain("! 12 jobs with secrets ran on GitHub-hosted this week\n  Trust a Mac to run them here too.");
    expect(lines.at(-1)).toBe("Next: buildhound runner set --org acme --machine Benys-Mac-mini --trusted on");
    expect(text).not.toMatch(/[·|]|\u2014/);
  });

  it("says a family that needs a person gets its fix, not that it comes back", () => {
    const family = { ...ROUTING.families[0]!, reason: "no_machine", summary: "No machine is connected", who: "you", fix: "Run buildhound doctor on each machine listed to see why it takes no jobs.", machines: [{ id: "b", name: "mini", os: "macos", why: "offline", phrase: "offline", since: new Date(Date.now() - 2 * 3600_000).toISOString() }] };
    const text = prettyStatus({ ...(ROUTING as unknown as StatusResult), families: [family] as StatusResult["families"], trust_banner: { ...ROUTING.trust_banner, show: false }, next: "buildhound doctor --org acme" });
    expect(text.split("\n").slice(0, 4)).toEqual(["macOS        GitHub-hosted", "             No machine is connected", "             mini  offline, last seen about 2 hours ago", "             Run buildhound doctor on each machine listed to see why it takes no jobs."]);
  });

  it("names why a job ran on GitHub-hosted in the jobs table and on its page", () => {
    const list = prettyJobs({ owner: "acme", role: "admin", jobs: [JOB, HOSTED_JOB] as JobsResult["jobs"], next_before: null, next: "x" });
    expect(list).toMatch(/WHY/);
    expect(list).toMatch(/deploy\s+acme\/app\s+GitHub-hosted.*Jobs with secrets need a trusted machine/);
    const cancelled = { ...JOB, conclusion: "cancelled", cancel_reason: { code: "superseded", summary: "A newer run of ci on main replaced this one", fix: "Nothing to fix.", who: "nobody", tone: "quiet" } };
    expect(prettyJobs({ owner: "acme", role: "admin", jobs: [cancelled] as JobsResult["jobs"], next_before: null, next: "x" })).toMatch(/A newer run of ci on main replaced this one/);
    expect(prettyJob({ owner: "acme", role: "admin", job: cancelled as JobResult["job"], reruns: [], calculation: null, provenance: null, next: "x" })).toContain("Cancelled. A newer run of ci on main replaced this one.");
    const withCounts = prettyJobs({ owner: "acme", role: "admin", jobs: [JOB] as JobsResult["jobs"], next_before: null, facets: { status: { running: 2, failed: 1 }, ran_on: { machine: 1, github_hosted: 2 }, machine: {}, repository: { "acme/app": 3 }, workflow: { "": 1 }, os: {} }, next: "x" });
    expect(withCounts).toMatch(/Status\s+running 2, failed 1/);
    expect(withCounts).toMatch(/Ran on\s+GitHub-hosted 2, Your machines 1/);
    expect(withCounts).toMatch(/Workflow\s+not known 1/);
    const page = prettyJob({ owner: "acme", role: "admin", job: HOSTED_JOB as JobResult["job"], reruns: [], calculation: null, provenance: null, next: "x" });
    expect(page).toContain("Ran on GitHub-hosted. It uses secrets and no trusted Mac was free.\nSet up a trusted Mac: FileVault on, then Trust this Mac.");
  });
});

describe("plan output", () => {
  const base: PlanResult = { owner: "acme", role: "admin", plan: "team", effective: "none", trial_ends_at: null, valid_until: null, machines: 2, price_per_machine_cents: 2400, price_per_machine_annual_cents: 24000, free_machine_limit: 2, checkout_next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing", next: "a person chooses Team at https://app.buildhound.sh/acme/settings/billing" };

  it("prices Team annually by default with the monthly price beside it, and names the refund", () => {
    const text = prettyPlan(base);
    expect(text).toContain("$20 a machine a month billed annually, or $24 monthly");
    expect(text).toContain("2 machines, $40 a month");
    expect(text).toContain("the first payment, on request within 30 days");
    expect(text).not.toMatch(/trial/i);
    // No subscription reads as Free in words; JSON keeps effective "none".
    expect(text).toMatch(/Plan\s+Free/);
    expect(text).toContain("Team, $20 a machine a month");
    expect(text).not.toContain("No plan");
  });

  it("prices Personal annually by default too, at $96 a year", () => {
    const text = prettyPlan({ ...base, owner: "benyd", plan: "personal", effective: "personal", valid_until: "2026-11-15T00:00:00.000Z", price_per_machine_cents: 1000, price_per_machine_annual_cents: 9600 });
    expect(text).toContain("$8 a machine a month billed annually, or $10 monthly");
    expect(text).toContain("2 machines, $16 a month");
    expect(text).toMatch(/Status\s+Active/);
  });

  it("counts machine days with jobs, never an average, with the estimate (ADR-033, one name everywhere 2026-10-16)", () => {
    const period = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };
    const team = { ...base, effective: "team" as const, valid_until: "2026-11-15T00:00:00.000Z", billable_machines: 1.4, active_machines_today: 1, machine_days: 42, days_elapsed: 30, period, estimated_cents: 3360 };
    const text = prettyPlan(team);
    expect(text).toMatch(/Machines\s+2 connected/);
    expect(text).toMatch(/Days with jobs\s+42 of 60 machine days so far, 18 idle/);
    expect(text).toContain("about $33.60 for the month at these machine days, before tax");
    expect(text).toContain("you pay only for machine days with jobs");
    expect(text).not.toMatch(/average|ran jobs/);
    expect(text).not.toContain("$40 a month");
    const free = prettyPlan({ ...base, billable_machines: 0, active_machines_today: 0, machine_days: 0, days_elapsed: 6, period, estimated_cents: null });
    expect(free).toMatch(/Days with jobs\s+0 of 12 machine days so far, 12 idle/);
    expect(free).not.toContain("Estimate");
    // A removed machine's days still count, so the possible days never fall below the used ones.
    expect(prettyPlan({ ...team, machines: 1 })).toMatch(/Days with jobs\s+42 of 42 machine days so far\n/);
    // A server from before 2026-10-16 sends only the machine days over the days.
    expect(prettyPlan({ ...team, machine_days: undefined, days_elapsed: undefined })).toMatch(/Days with jobs\s+about 1\.4 machines a day with jobs this month/);
  });
});
