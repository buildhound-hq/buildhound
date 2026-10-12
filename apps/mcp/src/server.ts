import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_RULES, Estimator, GITHUB_RATES, GITHUB_RATES_META, RULES, VENDOR_TABLES, XCODE_CLOUD, loadWorkflow, makeContext, ruleById, runRules,
} from "@buildhound/core";
import type * as Ops from "buildhound/ops";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const err = (code: string, message: string, next: string) => ({ ...json({ error: { code, message, next } }), isError: true });

/** The CLI's own operations, so a tool and its command behave the same (AGENT_FIRST.md, MCP tools). */
export interface RunnerOps {
  status: typeof Ops.runRunnerStatus;
  add: (opts: Parameters<typeof Ops.runRunnerAdd>[0]) => ReturnType<typeof Ops.runRunnerAdd>;
  set: typeof Ops.runRunnerSet;
  remove: (opts: Parameters<typeof Ops.runRunnerRemove>[0]) => ReturnType<typeof Ops.runRunnerRemove>;
  failover: typeof Ops.runFailover;
  route: typeof Ops.runRoute;
}

export interface ServerDeps {
  /** Read workflow files under a directory. Injected so the server stays testable and the core stays pure. */
  readWorkflows?: (path: string) => Promise<Array<{ path: string; content: string }>>;
  /** Machine and routing operations; absent when the server runs without the CLI (for example in tests). */
  runners?: RunnerOps;
}

/** A CLI error keeps its code and next; anything else is INTERNAL with a next that still points somewhere. */
function fromError(e: unknown, fallbackNext: string) {
  const c = e as { code?: unknown; message?: unknown; next?: unknown };
  if (typeof c?.code === "string" && typeof c.next === "string") {
    return err(c.code, String(c.message ?? c.code), c.code === "NOT_FOUND" ? "runner_status with the same owner lists the machines" : c.next);
  }
  return err("INTERNAL", e instanceof Error ? e.message : String(e), fallbackNext);
}

const NO_RUNNERS = () => err("NOT_AVAILABLE", "this server was started without the machine operations", "run the server over stdio with buildhound-mcp");
const ROUTING = z.enum(["primary", "backup", "off"]);

/** Tools are few, namespaced and annotated (AGENT_FIRST.md rules 6 and 7). Read tools carry readOnlyHint. */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "buildhound", version: "0.0.1" });

  server.registerTool(
    "explain_rule",
    {
      description: "Call to learn what a Buildhound rule detects and how its fix looks. Returns id, slug, title, severity, kind and whether the fix can change behaviour. Error RULE_NOT_FOUND lists the next call.",
      inputSchema: { rule_id: z.string().describe("Rule id such as R03") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ rule_id }) => {
      const rule = ruleById(rule_id);
      return rule ? json(rule) : err("RULE_NOT_FOUND", `no rule ${rule_id}`, "list_rules");
    },
  );

  server.registerTool(
    "list_rules",
    { description: "Call to list every Buildhound rule id with its title and severity.", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } },
    async () => json(RULES.map(({ id, title, severity }) => ({ id, title, severity }))),
  );

  server.registerTool(
    "get_rates",
    {
      description: "Call to get the per-minute rate tables the cost model uses: GitHub-hosted, every third-party runner vendor, connected Buildhound machines, and the Xcode Cloud comparison. Each table carries a source URL and verified date.",
      inputSchema: { provider: z.string().optional().describe("Filter to one provider, for example github, blacksmith, depot, warpbuild, ubicloud, jog, runs_on, buildhound") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ provider }) => {
      const tables = [{ ...GITHUB_RATES_META, rates: GITHUB_RATES }, ...VENDOR_TABLES].filter((t) => !provider || t.provider === provider);
      return json({ tables, xcode_cloud: provider && provider !== "xcode_cloud" ? undefined : XCODE_CLOUD });
    },
  );

  server.registerTool(
    "estimate_workflow_cost",
    {
      description: "Call to estimate what one GitHub Actions workflow costs per month from its YAML alone. Returns cents and minutes per month, per-job rows, and the assumptions used. No history is consulted; pass runs_per_month to override the trigger defaults.",
      inputSchema: {
        workflow_yaml: z.string().describe("Full workflow file content"),
        runs_per_month: z.number().int().positive().optional().describe("Override runs per month for every trigger"),
        public_repo: z.boolean().optional().describe("GitHub-hosted minutes are free on public repositories"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ workflow_yaml, runs_per_month, public_repo }) => {
      let w;
      try { w = loadWorkflow(".github/workflows/workflow.yml", workflow_yaml); } catch (e) { return err("YAML_INVALID", (e as Error).message, "fix the YAML and call estimate_workflow_cost again"); }
      const estimator = new Estimator({}, Boolean(public_repo));
      const est = estimator.estimateWorkflow(w.model, null, w.path);
      if (runs_per_month) {
        const scale = est.runsPerMonth ? runs_per_month / est.runsPerMonth : 0;
        for (const j of est.jobs) { j.runsPerMonth = runs_per_month; j.minutesPerMonth = Math.round(j.minutesPerMonth * scale); j.centsPerMonth = Math.round(j.centsPerMonth * scale); }
        est.runsPerMonth = runs_per_month;
        est.minutesPerMonth = est.jobs.reduce((a, j) => a + j.minutesPerMonth, 0);
        est.centsPerMonth = est.jobs.reduce((a, j) => a + j.centsPerMonth, 0);
        est.assumptions.push(`runs_per_month overridden to ${runs_per_month}`);
      }
      return json({ cents_per_month: est.centsPerMonth, minutes_per_month: est.minutesPerMonth, runs_per_month: est.runsPerMonth, jobs: est.jobs, assumptions: est.assumptions });
    },
  );

  server.registerTool(
    "scan_repo",
    {
      description: "Call to audit the workflow files under a local path for wasted CI spend with the static rules. Returns findings with evidence, monthly estimates and diffs, plus totals. Pass rules to limit which run. For run-history based rules use the CLI with --repo.",
      inputSchema: {
        path: z.string().default(".").describe("Repository root containing .github/workflows"),
        rules: z.array(z.string()).optional().describe("Rule ids to run, default all"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ path, rules }) => {
      if (!deps.readWorkflows) return err("NOT_AVAILABLE", "scan_repo needs file access; this server was started without it", "run the server over stdio with buildhound-mcp");
      const files = await deps.readWorkflows(path);
      if (!files.length) return err("NO_WORKFLOWS", `no workflow files under ${path}/.github/workflows`, "pass the repository root as path");
      const selected = rules?.length ? ALL_RULES.filter((r) => rules.includes(r.meta.id)) : ALL_RULES;
      const findings = [];
      for (const f of files) findings.push(...(await runRules(selected, makeContext({ path: f.path, content: f.content }))));
      findings.sort((a, b) => b.estimate.centsPerMonth - a.estimate.centsPerMonth);
      return json({
        path,
        workflows: files.map((f) => f.path),
        findings,
        totals: { minutes_per_month: findings.reduce((a, f) => a + f.estimate.minutesPerMonth, 0), cents_per_month: findings.reduce((a, f) => a + f.estimate.centsPerMonth, 0) },
        next: "explain_rule for any finding, or the CLI: buildhound scan --repo <owner/name> for history-based rules",
      });
    },
  );

  server.registerTool(
    "runner_status",
    {
      description: "Call to see an account's connected machines (status, heartbeat age, running jobs over capacity, labels, image, agent version, routing) and the failover state per label. Without org it asks the agent on this machine over its local socket.",
      inputSchema: {
        org: z.string().optional().describe("GitHub organisation or user login"),
        machine: z.string().optional().describe("Only this machine, by id or name"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ org, machine }) => {
      if (!deps.runners) return NO_RUNNERS();
      try {
        const r = await deps.runners.status(org ? { org } : { local: true });
        if (!machine || "local" in r) return json(r);
        const machines = r.machines.filter((m) => m.id === machine || m.name === machine);
        if (!machines.length) return err("NOT_FOUND", `no machine named ${machine} in ${r.owner}`, `runner_status with org ${r.owner} and no machine`);
        return json({ ...r, machines });
      } catch (e) {
        return fromError(e, "runner_status with org set");
      }
    },
  );

  server.registerTool(
    "runner_add",
    {
      description: "Call only when the user asked to connect THIS machine as a single-use CI runner. Registers it, writes the agent config, installs and starts the agent; every step is idempotent and reported. Requires confirm: true. May return status needs_human with one URL for a GitHub step.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machine"),
        label: z.string().default("macos").describe("What the machine runs: macos, linux, or macos,linux on a Mac"),
        name: z.string().optional().describe("Machine name, default the hostname"),
        capacity: z.number().int().min(1).max(64).optional().describe("Jobs at once; default 1 on laptops and small machines, else 2"),
        repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional().describe("Personal accounts: only these owner/name repositories"),
        confirm: z.boolean().optional().describe("Must be true: connecting a machine changes this computer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, label, name, capacity, repositories, confirm }) => {
      if (!deps.runners) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `connecting this machine to ${org} installs and starts the agent`, "call runner_add again with confirm: true once the user agreed");
      try {
        return json(await deps.runners.add({ org, label, name, capacity, repositories: repositories?.join(","), yes: true }));
      } catch (e) {
        return fromError(e, "runner_status with org set");
      }
    },
  );

  server.registerTool(
    "runner_set",
    {
      description:
        "Call to change a machine's routing or settings. Routing: primary takes jobs whenever it can, backup only when no primary can, off stays connected and visible but takes none. Settings: paused (running jobs finish), performance (quiet, balanced or max), idle_only, plugged_in_only; the machine picks them up within 30 seconds, and a later change made on the machine wins. Set at least one field. Idempotent and reversible; returns the settings, whether anything changed and the failover state.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        owner: z.string().describe("GitHub organisation or user that owns the machine"),
        routing: ROUTING.optional(),
        paused: z.boolean().optional().describe("true stops new jobs; false takes jobs again"),
        performance: z.enum(["quiet", "balanced", "max"]).optional(),
        idle_only: z.boolean().optional().describe("take jobs only while nobody is using the machine"),
        plugged_in_only: z.boolean().optional().describe("take jobs only while plugged in"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ machine, owner, routing, paused, performance, idle_only, plugged_in_only }) => {
      if (!deps.runners) return NO_RUNNERS();
      try {
        return json(
          await deps.runners.set({
            machine,
            org: owner,
            ...(routing !== undefined ? { routing } : {}),
            ...(paused === true ? { pause: true } : paused === false ? { resume: true } : {}),
            ...(performance !== undefined ? { performance } : {}),
            ...(idle_only !== undefined ? { idleOnly: idle_only } : {}),
            ...(plugged_in_only !== undefined ? { pluggedInOnly: plugged_in_only } : {}),
          }),
        );
      } catch (e) {
        return fromError(e, `runner_status with org ${owner}`);
      }
    },
  );

  server.registerTool(
    "runner_remove",
    {
      description: "Call only when the user asked to disconnect a machine. Deregisters it (the registration is kept 48 hours) and stops the agent when it is this machine; new jobs route to the healthy side. Requires confirm: true.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        owner: z.string().describe("GitHub organisation or user that owns the machine"),
        confirm: z.boolean().optional().describe("Must be true: removing a machine stops it taking jobs"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ machine, owner, confirm }) => {
      if (!deps.runners) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `removing ${machine} from ${owner} stops it taking jobs`, "call runner_remove again with confirm: true once the user agreed");
      try {
        return json(await deps.runners.remove({ machine, org: owner, yes: true }));
      } catch (e) {
        return fromError(e, `runner_status with org ${owner}`);
      }
    },
  );

  server.registerTool(
    "failover_state",
    {
      description: "Call to see, per label family, whether new jobs route to the account's machines or to GitHub-hosted, the mode (auto, forced_machine, forced_hosted) and why. Read only; overriding it is the CLI's buildhound failover --set.",
      inputSchema: { org: z.string().describe("GitHub organisation or user login") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ org }) => {
      if (!deps.runners) return NO_RUNNERS();
      try {
        return json(await deps.runners.failover({ org }));
      } catch (e) {
        return fromError(e, `runner_status with org ${org}`);
      }
    },
  );

  server.registerTool(
    "route_jobs",
    {
      description: "Call to rank where each job should run by computed monthly cost: stay on GitHub-hosted, a connected machine, or a runner vendor, with the calculation, payback and any referral agreement disclosed. Pass repo to use observed minutes from run history. Read only.",
      inputSchema: {
        path: z.string().default(".").describe("Repository root containing .github/workflows"),
        repo: z.string().optional().describe("owner/name: use observed minutes from the last days of runs"),
        providers: z.array(z.string()).optional().describe("Providers to consider, for example blacksmith, ubicloud"),
        days: z.number().int().positive().optional().describe("Days of history with repo, default 30"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ path, repo, providers, days }) => {
      if (!deps.runners) return NO_RUNNERS();
      try {
        return json(await deps.runners.route(path, { repo, providers: providers?.join(","), days }));
      } catch (e) {
        return fromError(e, "scan_repo with the same path");
      }
    },
  );

  return server;
}
