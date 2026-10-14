import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ReadOps, type RunnerOps, type ServerDeps } from "./server";

async function connect(deps?: ServerDeps) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

const macosYml = `on: push\njobs:\n  build:\n    runs-on: macos-latest\n    steps:\n      - run: pnpm lint\n`;

describe("mcp server", () => {
  it("agentfirst: every tool is annotated, and every state-changing tool says so", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "audit_list", "estimate_workflow_cost", "explain_rule", "failover_state", "get_rates", "job_get", "jobs_list", "list_rules", "overview_get", "plan_get",
      "repos_list", "route_jobs", "runner_add", "runner_remove", "runner_set", "runner_status", "savings_get", "scan_repo", "settings_get", "settings_set",
    ]);
    const writes = new Set(["runner_add", "runner_remove", "runner_set", "settings_set"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(!writes.has(t.name));
      expect(t.description!.startsWith("Call")).toBe(true);
    }
    for (const name of ["runner_add", "runner_remove"]) {
      expect(tools.find((t) => t.name === name)!.annotations?.destructiveHint).toBe(true);
      expect(Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties)).toContain("confirm");
    }
  });
  it("agentfirst: explain_rule returns JSON and an error envelope with next on unknown ids", async () => {
    const client = await connect();
    expect(JSON.parse(text(await client.callTool({ name: "explain_rule", arguments: { rule_id: "R03" } }))).slug).toBe("cancel-in-progress");
    const bad = await client.callTool({ name: "explain_rule", arguments: { rule_id: "R99" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad)).error.next).toBe("list_rules");
  });
  it("get_rates returns GitHub, every vendor and Xcode Cloud with sources", async () => {
    const client = await connect();
    const r = JSON.parse(text(await client.callTool({ name: "get_rates", arguments: {} })));
    expect(r.tables.map((t: { provider: string }) => t.provider)).toContain("ubicloud");
    expect(r.xcode_cloud.pricePerMinute).toBeLessThan(0.01);
    for (const t of r.tables) { expect(t.source).toMatch(/^https:/); expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });
  it("estimate_workflow_cost prices a macOS job with the 10x rate and honours runs_per_month", async () => {
    const client = await connect();
    const r = JSON.parse(text(await client.callTool({ name: "estimate_workflow_cost", arguments: { workflow_yaml: macosYml, runs_per_month: 100 } })));
    expect(r.runs_per_month).toBe(100);
    expect(r.cents_per_month).toBe(Math.round(100 * 8 * 0.062 * 100));
    const bad = await client.callTool({ name: "estimate_workflow_cost", arguments: { workflow_yaml: "on: [\n" } });
    expect(bad.isError).toBe(true);
  });
  it("scan_repo runs the rules over injected files and returns totals and next", async () => {
    const client = await connect({ readWorkflows: async (p) => (p === "." ? [{ path: ".github/workflows/ci.yml", content: macosYml }] : []) });
    const r = JSON.parse(text(await client.callTool({ name: "scan_repo", arguments: { path: "." } })));
    expect(r.workflows).toEqual([".github/workflows/ci.yml"]);
    expect(Array.isArray(r.findings)).toBe(true);
    expect(r.totals.cents_per_month).toBeGreaterThanOrEqual(0);
    expect(r.next).toBeTruthy();
    const none = await client.callTool({ name: "scan_repo", arguments: { path: "/nowhere" } });
    expect(JSON.parse(text(none)).error.code).toBe("NO_WORKFLOWS");
  });

  describe("runner tools", () => {
    class FakeCliError extends Error {
      constructor(readonly code: string, message: string, readonly next: string) { super(message); }
    }
    function fakeOps(): RunnerOps & { calls: Array<[string, unknown]> } {
      const calls: Array<[string, unknown]> = [];
      const machines = [
        { id: "m1", name: "studio", status: "online", labels: ["buildhound-macos"], capacity: 2, running_jobs: 0, last_heartbeat_at: null, heartbeat_age_seconds: null, image_id: null, agent_version: "0.1.0" },
        { id: "m2", name: "mini", status: "online", labels: ["buildhound-linux"], capacity: 1, running_jobs: 1, last_heartbeat_at: null, heartbeat_age_seconds: null, image_id: null, agent_version: "0.1.0" },
      ];
      const ops = {
        calls,
        status: async (o: object) => { calls.push(["status", o]); return { owner: "acme", machines, failover: {}, next: "buildhound route --repo <owner/name>" }; },
        add: async (o: object) => { calls.push(["add", o]); return { status: "ready", machine: "studio", steps: [], next: "runner_status" }; },
        set: async (o: { machine?: string }) => {
          calls.push(["set", o]);
          if (o.machine === "ghost") throw new FakeCliError("NOT_FOUND", "no machine named ghost in acme", "buildhound runner status --org acme");
          return { status: "updated", machine: { id: "m1", name: "studio", routing: "backup" }, owner: "acme", failover: {}, next: "buildhound runner status --org acme" };
        },
        remove: async (o: object) => { calls.push(["remove", o]); return { status: "removed", machine: { id: "m1", name: "studio" }, next: "x" }; },
        failover: async (o: object) => { calls.push(["failover", o]); return { owner: "acme", changed: null, failover: {}, next: "x" }; },
        route: async (path: string, o: object) => { calls.push(["route", { path, ...o }]); throw new Error("boom"); },
      };
      return ops as unknown as RunnerOps & { calls: Array<[string, unknown]> };
    }

    it("agentfirst: without the machine operations every runner tool errors with next", async () => {
      const client = await connect();
      const r = await client.callTool({ name: "runner_status", arguments: { org: "acme" } });
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r)).error.next).toBeTruthy();
    });

    it("agentfirst: runner_add and runner_remove refuse without confirm and never call the CLI", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      for (const [name, args] of [["runner_add", { org: "acme" }], ["runner_remove", { machine: "studio", owner: "acme", confirm: false }]] as const) {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError).toBe(true);
        const e = JSON.parse(text(r)).error;
        expect(e.code).toBe("CONFIRM_REQUIRED");
        expect(e.next).toContain("confirm: true");
      }
      expect(ops.calls).toEqual([]);
      await client.callTool({ name: "runner_add", arguments: { org: "acme", label: "macos,linux", capacity: 2, repositories: ["acme/app", "acme/web"], confirm: true } });
      await client.callTool({ name: "runner_remove", arguments: { machine: "studio", owner: "acme", confirm: true } });
      expect(ops.calls).toEqual([
        ["add", { org: "acme", label: "macos,linux", name: undefined, capacity: 2, repositories: "acme/app,acme/web", yes: true }],
        ["remove", { machine: "studio", org: "acme", yes: true }],
      ]);
    });

    it("agentfirst: runner_status filters to one machine and asks the local agent without org", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      const one = JSON.parse(text(await client.callTool({ name: "runner_status", arguments: { org: "acme", machine: "mini" } })));
      expect(one.machines.map((m: { id: string }) => m.id)).toEqual(["m2"]);
      const missing = await client.callTool({ name: "runner_status", arguments: { org: "acme", machine: "ghost" } });
      expect(JSON.parse(text(missing)).error.code).toBe("NOT_FOUND");
      await client.callTool({ name: "runner_status", arguments: {} });
      expect(ops.calls.at(-1)).toEqual(["status", { local: true }]);
    });

    it("agentfirst: runner_set passes owner as org and keeps the CLI's error code with a tool next", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      const ok = JSON.parse(text(await client.callTool({ name: "runner_set", arguments: { machine: "studio", owner: "acme", routing: "backup" } })));
      expect(ok.machine.routing).toBe("backup");
      expect(ops.calls[0]).toEqual(["set", { machine: "studio", org: "acme", routing: "backup" }]);
      const bad = await client.callTool({ name: "runner_set", arguments: { machine: "ghost", owner: "acme", routing: "off" } });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(text(bad)).error).toMatchObject({ code: "NOT_FOUND", next: expect.stringContaining("runner_status") });
      const invalid = await client.callTool({ name: "runner_set", arguments: { machine: "studio", owner: "acme", routing: "sometimes" } });
      expect(invalid.isError).toBe(true);
      await client.callTool({ name: "runner_set", arguments: { machine: "studio", owner: "acme", paused: true, performance: "max", plugged_in_only: false } });
      expect(ops.calls.at(-1)).toEqual(["set", { machine: "studio", org: "acme", pause: true, performance: "max", pluggedInOnly: false }]);
    });

    it("agentfirst: failover_state is read only and an unexpected failure still carries next", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      expect(JSON.parse(text(await client.callTool({ name: "failover_state", arguments: { org: "acme" } }))).owner).toBe("acme");
      expect(ops.calls).toEqual([["failover", { org: "acme" }]]);
      const r = await client.callTool({ name: "route_jobs", arguments: { repo: "acme/app" } });
      expect(JSON.parse(text(r)).error).toMatchObject({ code: "INTERNAL", next: expect.any(String) });
    });
  });
});

describe("mcp read tools (B03)", () => {
  function fakeReads(): ReadOps & { calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = [];
    const reads = {
      calls,
      jobs: async (o: object) => {
        calls.push(["jobs", o]);
        return { owner: "acme", role: "member", jobs: [], next_before: null, next: "buildhound runner status --org acme" };
      },
      job: async (id: string, o: object) => {
        calls.push(["job", { id, ...o }]);
        throw Object.assign(new Error(`job ${id} not found`), { code: "NOT_FOUND", next: "buildhound jobs --org acme" });
      },
      overview: async (o: object) => {
        calls.push(["overview", o]);
        return { owner: "acme", jobs_on_machines: 3, next: "x" };
      },
      savings: async (o: object) => {
        calls.push(["savings", o]);
        return { owner: "acme", months: [], next: "x" };
      },
      repos: async (o: object) => {
        calls.push(["repos", o]);
        return { owner: "acme", repositories: [], next: "x" };
      },
      plan: async (o: object) => {
        calls.push(["plan", o]);
        return { owner: "acme", plan: "team", next: "x" };
      },
      audit: async (o: object) => {
        calls.push(["audit", o]);
        return { owner: "acme", events: [], next: "x" };
      },
      settings: async (o: object) => {
        calls.push(["settings", o]);
        return { owner: "acme", defaults: {}, next: "x" };
      },
    };
    return reads as unknown as ReadOps & { calls: Array<[string, unknown]> };
  }

  it("agentfirst: read tools call the CLI's operations with the same options and keep its errors", async () => {
    const reads = fakeReads();
    const client = await connect({ reads });
    const jobs = JSON.parse(text(await client.callTool({ name: "jobs_list", arguments: { org: "acme", result: "failure", limit: 20 } })));
    expect(jobs.role).toBe("member");
    expect(reads.calls[0]).toEqual(["jobs", { org: "acme", repository: undefined, machine: undefined, label: undefined, result: "failure", before: undefined, limit: "20" }]);
    await client.callTool({ name: "overview_get", arguments: { org: "acme", month: "2026-10" } });
    await client.callTool({ name: "savings_get", arguments: { org: "acme", months: 3 } });
    expect(reads.calls.slice(1)).toEqual([["overview", { org: "acme", month: "2026-10" }], ["savings", { org: "acme", months: "3" }]]);
    for (const name of ["repos_list", "plan_get", "audit_list", "settings_get"]) await client.callTool({ name, arguments: { org: "acme" } });
    await client.callTool({ name: "settings_set", arguments: { org: "acme", performance: "quiet" } });
    expect(reads.calls.slice(3)).toEqual([["repos", { org: "acme" }], ["plan", { org: "acme" }], ["audit", { org: "acme", before: undefined }], ["settings", { org: "acme" }], ["settings", { org: "acme", performance: "quiet" }]]);
    const missing = await client.callTool({ name: "job_get", arguments: { org: "acme", id: "nope" } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(text(missing)).error).toMatchObject({ code: "NOT_FOUND", next: expect.stringContaining("jobs_list") });
  });

  it("agentfirst: read tools without the CLI's operations error with next", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "jobs_list", arguments: { org: "acme" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error.next).toBeTruthy();
  });
});
