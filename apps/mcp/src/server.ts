import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_RULES, Estimator, GITHUB_RATES, GITHUB_RATES_META, RULES, VENDOR_TABLES, XCODE_CLOUD, loadWorkflow, makeContext, ruleById, runRules,
} from "@buildhound/core";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const err = (code: string, message: string, next: string) => ({ ...json({ error: { code, message, next } }), isError: true });

export interface ServerDeps {
  /** Read workflow files under a directory. Injected so the server stays testable and the core stays pure. */
  readWorkflows?: (path: string) => Promise<Array<{ path: string; content: string }>>;
}

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
      inputSchema: { provider: z.string().optional().describe("Filter to one provider, for example github, blacksmith, depot, warpbuild, ubicloud, runs_on, buildhound") },
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

  return server;
}
