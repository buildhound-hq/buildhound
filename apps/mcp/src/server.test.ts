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
  it("agentfirst: every tool is annotated and titled, and every state-changing tool says so", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "audit_list", "audit_log_list", "billing_checkout", "billing_period", "doctor", "estimate_workflow_cost", "explain_rule", "failover_state", "get_rates", "image_build", "job_get", "jobs_list", "list_rules", "overview_get", "plan_get",
      "repos_list", "route_apply", "route_jobs", "runner_add", "runner_remove", "runner_set", "runner_status", "savings_get", "scan_fix", "scan_repo", "settings_get", "settings_set",
    ]);
    const writes = new Set(["billing_checkout", "billing_period", "image_build", "route_apply", "runner_add", "runner_remove", "runner_set", "scan_fix", "settings_set"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(!writes.has(t.name));
      expect(t.description!.startsWith("Call")).toBe(true);
      /* Claude's directory and other clients show the title; it is short and in sentence case. */
      expect(t.title, t.name).toMatch(/^[A-Z][a-zA-Z' ]{2,39}[a-z]$/);
      expect(t.annotations?.destructiveHint, t.name).toBeTypeOf("boolean");
    }
    for (const name of ["route_apply", "runner_add", "runner_remove", "scan_fix"]) {
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

  it("scan_repo pins action tags with the injected resolver, and resolve: false skips it", async () => {
    const sha = "d".repeat(40);
    const yml = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: pnpm/action-setup@v4\n`;
    const looked: string[][] = [];
    const client = await connect({
      readWorkflows: async () => [{ path: ".github/workflows/ci.yml", content: yml }],
      resolveActionRefs: async (files) => {
        looked.push(files.map((f) => f.path));
        return (owner, repo, ref) => (`${owner}/${repo}@${ref}` === "pnpm/action-setup@v4" ? sha : null);
      },
    });
    type R17 = { ruleId: string; diff: string | null };
    const pinned = JSON.parse(text(await client.callTool({ name: "scan_repo", arguments: { path: ".", rules: ["R17"] } }))).findings as R17[];
    expect(looked).toEqual([[".github/workflows/ci.yml"]]);
    expect(pinned[0]!.diff).toContain(`uses: pnpm/action-setup@${sha} # v4`);
    const plain = JSON.parse(text(await client.callTool({ name: "scan_repo", arguments: { path: ".", rules: ["R17"], resolve: false } }))).findings as R17[];
    expect(looked).toHaveLength(1);
    expect(plain[0]!.diff).toBeNull();
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
      // Without a label the CLI picks the host's default: macOS and Linux on a Mac.
      await client.callTool({ name: "runner_add", arguments: { org: "acme", confirm: true } });
      expect(ops.calls).toEqual([
        ["add", { org: "acme", label: "macos,linux", name: undefined, capacity: 2, repositories: "acme/app,acme/web", yes: true }],
        ["remove", { machine: "studio", org: "acme", yes: true }],
        ["add", { org: "acme", label: undefined, name: undefined, capacity: undefined, repositories: undefined, yes: true }],
      ]);
    });

    it("agentfirst: runner_add with check: true only reads, with no confirm", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      const r = await client.callTool({ name: "runner_add", arguments: { org: "acme", check: true } });
      expect(r.isError).toBeFalsy();
      expect(ops.calls).toEqual([["add", { org: "acme", check: true }]]);
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

    it("agentfirst: runner_set changes the repositories a machine serves, as the CLI's flags", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      await client.callTool({ name: "runner_set", arguments: { machine: "studio", org: "octo", add_repositories: ["octo/photos", "octo/site"] } });
      expect(ops.calls.at(-1)).toEqual(["set", { machine: "studio", org: "octo", addRepository: "octo/photos,octo/site" }]);
      await client.callTool({ name: "runner_set", arguments: { machine: "studio", org: "octo", remove_repositories: ["octo/site"] } });
      expect(ops.calls.at(-1)).toEqual(["set", { machine: "studio", org: "octo", removeRepository: "octo/site" }]);
      await client.callTool({ name: "runner_set", arguments: { machine: "studio", org: "octo", repositories: [] } });
      expect(ops.calls.at(-1)).toEqual(["set", { machine: "studio", org: "octo", repositories: "all" }]);
    });

    it("agentfirst: runner_set and runner_remove take org as well as owner, and ask for one when both are missing", async () => {
      const ops = fakeOps();
      const client = await connect({ runners: ops });
      await client.callTool({ name: "runner_set", arguments: { machine: "studio", org: "acme", idle_only: true } });
      expect(ops.calls.at(-1)).toEqual(["set", { machine: "studio", org: "acme", idleOnly: true }]);
      await client.callTool({ name: "runner_remove", arguments: { machine: "studio", org: "acme", confirm: true } });
      expect(ops.calls.at(-1)?.[1]).toMatchObject({ machine: "studio", org: "acme", yes: true });
      const calls = ops.calls.length;
      for (const name of ["runner_set", "runner_remove"]) {
        const missing = await client.callTool({ name, arguments: { machine: "studio", routing: "off", confirm: true } });
        expect(missing.isError).toBe(true);
        expect(JSON.parse(text(missing)).error).toMatchObject({ code: "USAGE", next: expect.stringContaining("with org") });
      }
      expect(ops.calls.length).toBe(calls);
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

describe("mcp billing_checkout (B13.2)", () => {
  it("agentfirst: billing_checkout calls the CLI's checkout, annual by default, and returns its needs_human", async () => {
    const calls: unknown[] = [];
    const billing = (async (o: object) => {
      calls.push(o);
      return { status: "needs_human", reason: "checkout", url: "https://app.buildhound.sh/acme/settings/billing?_ptxn=txn_1", next: "buildhound plan --org acme", owner: "acme" };
    }) as never;
    const client = await connect({ billing });
    const r = JSON.parse(text(await client.callTool({ name: "billing_checkout", arguments: { org: "acme", plan: "team" } })));
    expect(r).toMatchObject({ status: "needs_human", reason: "checkout", url: expect.stringContaining("_ptxn=") });
    expect(calls).toEqual([{ org: "acme", plan: "team", annual: true }]);
    await client.callTool({ name: "billing_checkout", arguments: { org: "acme", plan: "team", billing: "monthly" } });
    expect(calls.at(-1)).toEqual({ org: "acme", plan: "team", annual: false });
    const failing = await connect({ billing: (async () => { throw Object.assign(new Error("acme is an organisation"), { code: "PLAN_MISMATCH", next: "buildhound billing checkout --org acme --plan team" }); }) as never });
    const bad = await failing.callTool({ name: "billing_checkout", arguments: { org: "acme", plan: "personal" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad)).error).toMatchObject({ code: "PLAN_MISMATCH", next: "buildhound billing checkout --org acme --plan team" });
  });
});

describe("mcp billing_period (BILLING.md, Switching period)", () => {
  it("agentfirst: billing_period only says what would happen without confirm, and switches with it", async () => {
    const calls: unknown[] = [];
    const billingPeriod = (async (o: { yes?: boolean }) => {
      calls.push(o);
      return { status: "scheduled", owner: "acme", dry_run: !o.yes, billing: "monthly", switch: { billing: "annual", effective_at: "2026-11-06T09:00:00.000Z", price_id: "pri_year", quantity: 2, unit_cents: 24000, amount_cents: 48000 }, next: "buildhound plan --org acme" };
    }) as never;
    const client = await connect({ billingPeriod });
    const plan = JSON.parse(text(await client.callTool({ name: "billing_period", arguments: { org: "acme", billing: "annual" } })));
    expect(plan).toMatchObject({ status: "scheduled", dry_run: true });
    expect(calls).toEqual([{ org: "acme", billing: "annual", yes: false }]);
    await client.callTool({ name: "billing_period", arguments: { org: "acme", billing: "annual", confirm: true } });
    expect(calls.at(-1)).toEqual({ org: "acme", billing: "annual", yes: true });
    const failing = await connect({ billingPeriod: (async () => { throw Object.assign(new Error("acme has no subscription to switch"), { code: "NO_SUBSCRIPTION", next: "buildhound billing checkout --org acme --plan team --annual" }); }) as never });
    const bad = await failing.callTool({ name: "billing_period", arguments: { org: "acme", billing: "annual", confirm: true } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad)).error).toMatchObject({ code: "NO_SUBSCRIPTION", next: "buildhound billing checkout --org acme --plan team --annual" });
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
    for (const name of ["repos_list", "plan_get", "audit_log_list", "settings_get"]) await client.callTool({ name, arguments: { org: "acme" } });
    await client.callTool({ name: "settings_set", arguments: { org: "acme", performance: "quiet" } });
    expect(reads.calls.slice(3)).toEqual([["repos", { org: "acme" }], ["plan", { org: "acme" }], ["audit", { org: "acme", before: undefined }], ["settings", { org: "acme" }], ["settings", { org: "acme", performance: "quiet" }]]);
    await client.callTool({ name: "audit_list", arguments: { org: "acme" } });
    expect(reads.calls.at(-1)).toEqual(["audit", { org: "acme", before: undefined }]);
    const missing = await client.callTool({ name: "job_get", arguments: { org: "acme", id: "nope" } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(text(missing)).error).toMatchObject({ code: "NOT_FOUND", next: expect.stringContaining("jobs_list") });
  });

  it("agentfirst: a NEEDS_TEAM answer comes back as needs_human with the billing page, not as an error", async () => {
    const url = "https://app.buildhound.sh/acme/settings/billing";
    const answer = {
      status: "needs_human",
      reason: "team_only",
      feature: "audit_log",
      url,
      next: "buildhound billing checkout --org acme --plan team, then buildhound audit-log --org acme",
      error: { code: "NEEDS_TEAM", message: "the audit log is part of Team, and acme is not on Team", next: "buildhound billing checkout --org acme --plan team, then buildhound audit-log --org acme" },
    };
    const needsTeam = () => Object.assign(new Error(answer.error.message), { code: "NEEDS_TEAM", next: answer.next, answer });
    const reads = { ...fakeReads(), audit: async () => { throw needsTeam(); }, jobs: async () => { throw needsTeam(); } } as unknown as ReadOps;
    const client = await connect({ reads });
    for (const name of ["audit_log_list", "jobs_list"]) {
      const r = await client.callTool({ name, arguments: { org: "acme" } });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r))).toMatchObject({ status: "needs_human", reason: "team_only", url, next: expect.any(String), error: { code: "NEEDS_TEAM" } });
    }
  });

  it("agentfirst: read tools without the CLI's operations error with next", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "jobs_list", arguments: { org: "acme" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error.next).toBeTruthy();
  });

  describe("scan_fix", () => {
    type Fix = NonNullable<ServerDeps["fix"]>;
    function fakeFix(calls: Array<[string, Record<string, unknown>]>): Fix {
      return (async (path: string, o: Record<string, unknown>) => {
        calls.push([path, o]);
        if (o.repo === "acme/locked") throw Object.assign(new Error("your GitHub login cannot push to acme/locked"), { code: "NO_PUSH_ACCESS", next: "ask a maintainer of acme/locked to run npx buildhound scan --fix --repo acme/locked --yes" });
        const status = o.yes ? "created" : "planned";
        return { repo: "acme/app", mode: o.yes ? "applied" : "plan", base: null, pull_requests: [{ branch: "buildhound/fix-r06-no-timeout", title: "Fix: Job without timeout-minutes", rules: ["R06"], files: [], findings: 1, saving_cents_per_month: 0, status, url: null, number: null, body: "b", diff: "d" }], no_automatic_fix: [], assumptions: [], next: o.yes ? "buildhound scan --repo acme/app" : "buildhound scan --fix --yes" };
      }) as unknown as Fix;
    }

    it("agentfirst: scan_fix plans without confirm, opens pull requests only with confirm: true, and errors carry next", async () => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const client = await connect({ fix: fakeFix(calls) });
      const plan = JSON.parse(text(await client.callTool({ name: "scan_fix", arguments: { path: ".", rules: ["R06"] } })));
      expect(plan.mode).toBe("plan");
      expect(plan.next).toBe("call scan_fix again with confirm: true once the user agreed");
      expect(calls[0]).toEqual([".", { repo: undefined, rule: ["R06"], onePr: undefined, dryRun: undefined, resolve: undefined, yes: false, json: true }]);
      const done = JSON.parse(text(await client.callTool({ name: "scan_fix", arguments: { path: ".", one_pr: true, confirm: true } })));
      expect(done.mode).toBe("applied");
      expect(calls[1]![1]).toMatchObject({ onePr: true, yes: true });
      const locked = await client.callTool({ name: "scan_fix", arguments: { repo: "acme/locked", confirm: true } });
      expect(locked.isError).toBe(true);
      expect(JSON.parse(text(locked)).error).toMatchObject({ code: "NO_PUSH_ACCESS", next: expect.stringContaining("ask a maintainer") });
    });

    it("agentfirst: scan_fix without the CLI's operations errors with next", async () => {
      const r = await (await connect()).callTool({ name: "scan_fix", arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r)).error.next).toBeTruthy();
    });
  });

  describe("route_apply", () => {
    type Apply = NonNullable<ServerDeps["routeApply"]>;
    function fakeApply(calls: Array<[string, Record<string, unknown>]>): Apply {
      return (async (path: string, o: Record<string, unknown>) => {
        calls.push([path, o]);
        if (o.repo === "acme/locked") throw Object.assign(new Error("GitHub refused to change workflow files with this token"), { code: "WORKFLOW_SCOPE_REQUIRED", next: "gh auth refresh -s workflow, then buildhound route --apply --repo acme/locked --yes" });
        const status = o.yes ? "created" : "planned";
        return {
          repo: "acme/app",
          mode: o.yes ? "applied" : "plan",
          base: null,
          pull_request: { branch: "buildhound/route", title: "Route 1 job to your machines, with GitHub-hosted as the fallback", status, url: null, number: null, files: [], body: "b", diff: "d" },
          routed: [],
          not_routed: [],
          already_routed: [],
          upgrades: [],
          saving: { public_repository: false, hosted_cents_per_month: 0, minutes_per_month: 0, machine_fee_cents: 2400, macos_peak_concurrency: 1, machines_needed: 1, monthly_saving_cents: -2400, claimed_cents_per_month: 0 },
          assumptions: [],
          next: o.yes ? "buildhound runner status --org acme" : "buildhound route --apply --repo acme/app --yes",
        };
      }) as unknown as Apply;
    }

    it("agentfirst: route_apply plans without confirm, opens the pull request only with confirm: true, and errors carry next", async () => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const client = await connect({ routeApply: fakeApply(calls) });
      const plan = JSON.parse(text(await client.callTool({ name: "route_apply", arguments: { repo: "acme/app" } })));
      expect(plan.mode).toBe("plan");
      expect(plan.next).toBe("call route_apply again with confirm: true once the user agreed");
      expect(calls[0]).toEqual([".", { repo: "acme/app", days: undefined, dryRun: undefined, yes: false, json: true }]);
      const done = JSON.parse(text(await client.callTool({ name: "route_apply", arguments: { repo: "acme/app", confirm: true } })));
      expect(done.mode).toBe("applied");
      expect(done.next).toBe("buildhound runner status --org acme");
      expect(calls[1]![1]).toMatchObject({ yes: true });
      const dry = JSON.parse(text(await client.callTool({ name: "route_apply", arguments: { repo: "acme/app", confirm: true, dry_run: true } })));
      expect(calls[2]![1]).toMatchObject({ dryRun: true, yes: true });
      expect(dry.repo).toBe("acme/app");
      const locked = await client.callTool({ name: "route_apply", arguments: { repo: "acme/locked", confirm: true } });
      expect(locked.isError).toBe(true);
      expect(JSON.parse(text(locked)).error).toMatchObject({ code: "WORKFLOW_SCOPE_REQUIRED", next: expect.stringContaining("gh auth refresh -s workflow") });
    });

    it("agentfirst: route_apply without the CLI's operations errors with next", async () => {
      const r = await (await connect()).callTool({ name: "route_apply", arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r)).error.next).toBeTruthy();
    });
  });
});
