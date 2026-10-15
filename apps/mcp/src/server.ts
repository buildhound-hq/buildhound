import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_RULES, Estimator, GITHUB_RATES, GITHUB_RATES_META, RULES, VENDOR_TABLES, XCODE_CLOUD, loadWorkflow, makeContext, ruleById, runRules,
} from "@buildhound/core";
import type { ActionRefResolver } from "@buildhound/core";
import pkg from "../package.json" with { type: "json" };
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

/** The read operations the dashboard shares with the CLI (B03). */
export interface ReadOps {
  jobs: typeof Ops.runJobs;
  job: typeof Ops.runJob;
  overview: typeof Ops.runOverview;
  savings: typeof Ops.runSavings;
  repos: typeof Ops.runRepos;
  plan: typeof Ops.runPlan;
  audit: typeof Ops.runAudit;
  settings: typeof Ops.runSettings;
}

export interface ServerDeps {
  /** Read workflow files under a directory. Injected so the server stays testable and the core stays pure. */
  readWorkflows?: (path: string) => Promise<Array<{ path: string; content: string }>>;
  /** Looks up the commit SHAs of the action tags in these files before the rules run, so R17 can pin them; absent means no lookups. */
  resolveActionRefs?: (files: Array<{ path: string; content: string }>) => Promise<ActionRefResolver>;
  /** Machine and routing operations; absent when the server runs without the CLI (for example in tests). */
  runners?: RunnerOps;
  /** Jobs, overview and savings; absent like `runners`. */
  reads?: ReadOps;
  /** `buildhound doctor`'s checks of this machine, the account and the network; absent like `runners`. */
  doctor?: typeof Ops.runDoctor;
  /** `buildhound image build`: the macOS image on this Mac, through the Buildhound agent; absent like `runners`. */
  image?: (opts: Parameters<typeof Ops.runImageBuild>[0]) => ReturnType<typeof Ops.runImageBuild>;
}

/** A CLI error keeps its code and next; anything else is INTERNAL with a next that still points somewhere. */
function fromError(e: unknown, fallbackNext: string, notFoundNext = "runner_status with the same owner lists the machines") {
  const c = e as { code?: unknown; message?: unknown; next?: unknown };
  if (typeof c?.code === "string" && typeof c.next === "string") {
    return err(c.code, String(c.message ?? c.code), c.code === "NOT_FOUND" ? notFoundNext : c.next);
  }
  return err("INTERNAL", e instanceof Error ? e.message : String(e), fallbackNext);
}

const NO_RUNNERS = () => err("NOT_AVAILABLE", "this server was started without the machine operations", "run the server over stdio with buildhound-mcp");
const ROUTING = z.enum(["primary", "backup", "off"]);

/** Tools are few, namespaced and annotated (AGENT_FIRST.md rules 6 and 7). Read tools carry readOnlyHint. */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "buildhound", version: pkg.version });

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
      description: "Call to scan the workflow files under a local path for a CI report on wasted CI spend, with the static rules. Returns findings, each with evidence, a monthly estimate and its fix as a diff, plus totals. Pass rules to limit which run. For run-history based rules use the CLI with --repo.",
      inputSchema: {
        path: z.string().default(".").describe("Repository root containing .github/workflows"),
        rules: z.array(z.string()).optional().describe("Rule ids to run, default all"),
        resolve: z.boolean().optional().describe("false skips looking up action tags on GitHub, so R17 findings come without a pinning diff"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ path, rules, resolve }) => {
      if (!deps.readWorkflows) return err("NOT_AVAILABLE", "scan_repo needs file access; this server was started without it", "run the server over stdio with buildhound-mcp");
      const files = await deps.readWorkflows(path);
      if (!files.length) return err("NO_WORKFLOWS", `no workflow files under ${path}/.github/workflows`, "pass the repository root as path");
      const selected = rules?.length ? ALL_RULES.filter((r) => rules.includes(r.meta.id)) : ALL_RULES;
      const findings = [];
      const resolveActionRef = resolve !== false && deps.resolveActionRefs && selected.some((r) => r.meta.id === "R17") ? await deps.resolveActionRefs(files) : undefined;
      for (const f of files) findings.push(...(await runRules(selected, makeContext({ path: f.path, content: f.content, ...(resolveActionRef ? { resolveActionRef } : {}) }))));
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

  const READ = { readOnlyHint: true, destructiveHint: false } as const;
  const ORG = z.string().describe("GitHub organisation or user login");

  server.registerTool(
    "jobs_list",
    {
      description:
        "Call to list the jobs an account's machines ran, newest first: repository, job name, machine, result, wait, run time and what GitHub-hosted would have cost. A member of an organisation sees only repositories they can read on GitHub. Page with before set to the previous next_before.",
      inputSchema: {
        org: ORG,
        repository: z.string().optional().describe("Only this repository, owner/name"),
        machine: z.string().optional().describe("Only this machine, by id or name"),
        label: z.string().optional().describe("Only this label, such as buildhound-macos"),
        result: z.string().optional().describe("success, failure, cancelled, or running"),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().optional().describe("next_before from the previous page"),
      },
      annotations: READ,
    },
    async ({ org, repository, machine, label, result, limit, before }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.jobs({ org, repository, machine, label, result, before, ...(limit !== undefined ? { limit: String(limit) } : {}) }));
      } catch (e) {
        return fromError(e, `jobs_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "job_get",
    {
      description: "Call to see one job's story: when it queued and started, where it ran, any re-runs and why, and its cost against GitHub-hosted with the calculation. Ids come from jobs_list.",
      inputSchema: { org: ORG, id: z.string().describe("The job id from jobs_list") },
      annotations: READ,
    },
    async ({ org, id }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.job(id, { org }));
      } catch (e) {
        return fromError(e, `jobs_list with org ${org}`, `jobs_list with org ${org} lists the job ids`);
      }
    },
  );

  server.registerTool(
    "overview_get",
    {
      description: "Call to see a month at a glance for an account: jobs on its machines and their GitHub-hosted cost, jobs that fell back to GitHub-hosted, the machines, recent jobs, and what needs a person (offline machines, jobs waiting, plan holds).",
      inputSchema: { org: ORG, month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM, UTC; this month when omitted") },
      annotations: READ,
    },
    async ({ org, month }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.overview({ org, month }));
      } catch (e) {
        return fromError(e, `overview_get with org ${org}`);
      }
    },
  );

  server.registerTool(
    "savings_get",
    {
      description: "Call to see, month by month and per machine, what the jobs on an account's machines would have cost on GitHub-hosted, with how it is calculated.",
      inputSchema: { org: ORG, months: z.number().int().min(1).max(24).optional().describe("How many months back; 6 when omitted") },
      annotations: READ,
    },
    async ({ org, months }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.savings({ org, ...(months !== undefined ? { months: String(months) } : {}) }));
      } catch (e) {
        return fromError(e, `savings_get with org ${org}`);
      }
    },
  );

  server.registerTool(
    "repos_list",
    {
      description: "Call to see every repository the GitHub App can see on an account, whether its jobs route to the account's machines (routed, needs_plan, not_routed), and its jobs there in the last 30 days.",
      inputSchema: { org: ORG },
      annotations: READ,
    },
    async ({ org }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.repos({ org }));
      } catch (e) {
        return fromError(e, `repos_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "plan_get",
    {
      description: "Call to see an account's plan: what it can buy (Personal or Team, by GitHub account type), what it has now, connected machines, the machines that ran a job each day averaged over the month so far (billable_machines: a machine counts only on days it ran a job), an estimate in cents, and the price per machine billed monthly and annually. Never per minute.",
      inputSchema: { org: ORG },
      annotations: READ,
    },
    async ({ org }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.plan({ org }));
      } catch (e) {
        return fromError(e, `plan_get with org ${org}`);
      }
    },
  );

  // audit_log_list is the name that says what it reads (docs/BRAND.md, Glossary); audit_list stays for agents that know it.
  for (const name of ["audit_log_list", "audit_list"]) {
    server.registerTool(
      name,
      {
        description: `Call to see an account's audit log, newest first: every admin change to machines, routing and defaults, who made it and from where (dashboard, cli, mcp, menu_bar). Admins only.${name === "audit_list" ? " Same as audit_log_list." : ""}`,
        inputSchema: { org: ORG, before: z.string().optional().describe("The next page: next_before from the previous one") },
        annotations: READ,
      },
      async ({ org, before }) => {
        if (!deps.reads) return NO_RUNNERS();
        try {
          return json(await deps.reads.audit({ org, before }));
        } catch (e) {
          return fromError(e, `${name} with org ${org}`);
        }
      },
    );
  }

  server.registerTool(
    "settings_get",
    {
      description: "Call to read an account's defaults: the performance mode a newly connected machine starts with.",
      inputSchema: { org: ORG },
      annotations: READ,
    },
    async ({ org }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.settings({ org }));
      } catch (e) {
        return fromError(e, `settings_get with org ${org}`);
      }
    },
  );

  server.registerTool(
    "settings_set",
    {
      description: "Call to set an account's default performance mode for newly connected machines (quiet, balanced or max). Reversible and idempotent; machines already connected keep their own setting. Admins only.",
      inputSchema: { org: ORG, performance: z.enum(["quiet", "balanced", "max"]) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ org, performance }) => {
      if (!deps.reads) return NO_RUNNERS();
      try {
        return json(await deps.reads.settings({ org, performance }));
      } catch (e) {
        return fromError(e, `settings_get with org ${org}`);
      }
    },
  );

  server.registerTool(
    "runner_status",
    {
      description: "Call to see an account's connected machines (status, heartbeat age, running jobs over capacity, labels, image, Buildhound agent version, routing) and the failover state per label. Without org it asks the Buildhound agent on this machine over its local socket.",
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
      description: "Call only when the user asked to connect THIS machine as a single-use CI runner. Registers it, writes the Buildhound agent's config, installs and starts the Buildhound agent; every step is idempotent and reported. Requires confirm: true. May return status needs_human with one URL for a GitHub step.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machine"),
        label: z.string().optional().describe("What the machine runs: macos, linux, or macos,linux; omit it for both on a Mac. Linux hosts are not supported yet (NOT_SUPPORTED)"),
        name: z.string().optional().describe("Machine name, default the hostname"),
        capacity: z.number().int().min(1).max(64).optional().describe("Jobs at once; omit to let the Buildhound agent plan it from memory: one macOS job, then as many 8 GB Linux jobs as fit, laptops one at a time"),
        repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional().describe("Personal accounts: only these owner/name repositories"),
        confirm: z.boolean().optional().describe("Must be true: connecting a machine changes this computer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, label, name, capacity, repositories, confirm }) => {
      if (!deps.runners) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `connecting this machine to ${org} installs and starts the Buildhound agent`, "call runner_add again with confirm: true once the user agreed");
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
        "Call to change a machine's routing or settings. Routing: primary takes jobs whenever it can, backup only when no primary can, off stays connected and visible but takes none. Settings: paused (running jobs finish), performance (quiet, balanced or max), idle_only (only when not in use), plugged_in_only; the machine picks them up within 30 seconds, and a later change made on the machine wins. Repositories, on a personal account: repositories replaces the list a machine serves (an empty list serves every repository the Buildhound GitHub App covers), add_repositories and remove_repositories change it; the machine applies it on its next check-in, and a repository the App does not cover returns needs_human with the GitHub page where a person adds it. Set at least one field. Idempotent and reversible; returns the settings, the repositories, whether anything changed and the failover state.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        org: z.string().optional().describe("GitHub organisation or user that owns the machine; the same as owner"),
        owner: z.string().optional().describe("GitHub organisation or user that owns the machine; pass this or org"),
        routing: ROUTING.optional(),
        paused: z.boolean().optional().describe("true stops new jobs; false takes jobs again"),
        performance: z.enum(["quiet", "balanced", "max"]).optional(),
        idle_only: z.boolean().optional().describe("only when not in use: take jobs only while nobody is using the machine"),
        plugged_in_only: z.boolean().optional().describe("take jobs only while plugged in"),
        repositories: z.array(z.string()).optional().describe("personal accounts: the repositories the machine serves, as owner/name; [] serves every repository the App covers"),
        add_repositories: z.array(z.string()).optional().describe("personal accounts: also serve these repositories, as owner/name"),
        remove_repositories: z.array(z.string()).optional().describe("personal accounts: stop serving these repositories"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ machine, org, owner: ownerArg, routing, paused, performance, idle_only, plugged_in_only, repositories, add_repositories, remove_repositories }) => {
      if (!deps.runners) return NO_RUNNERS();
      const owner = org ?? ownerArg;
      if (!owner) return err("USAGE", "org is required: the GitHub organisation or user that owns the machine", "call runner_set again with org");
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
            ...(repositories !== undefined ? { repositories: repositories.length ? repositories.join(",") : "all" } : {}),
            ...(add_repositories?.length ? { addRepository: add_repositories.join(",") } : {}),
            ...(remove_repositories?.length ? { removeRepository: remove_repositories.join(",") } : {}),
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
      description: "Call only when the user asked to disconnect a machine. Removes it (the registration is kept 48 hours) and stops the Buildhound agent when it is this machine; new jobs route to the healthy side. Requires confirm: true.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        org: z.string().optional().describe("GitHub organisation or user that owns the machine; the same as owner"),
        owner: z.string().optional().describe("GitHub organisation or user that owns the machine; pass this or org"),
        confirm: z.boolean().optional().describe("Must be true: removing a machine stops it taking jobs"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ machine, org, owner: ownerArg, confirm }) => {
      if (!deps.runners) return NO_RUNNERS();
      const owner = org ?? ownerArg;
      if (!owner) return err("USAGE", "org is required: the GitHub organisation or user that owns the machine", "call runner_remove again with org");
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
    "doctor",
    {
      description:
        "Call when setting up or when something looks off on this machine: checks Node, GitHub sign-in, the Buildhound API, the account and plan, the Buildhound agent and its images, power, memory, disk, heavy processes (simulators, Docker, other VMs), FileVault, the network and routing. Returns { ok, checks: [{ id, status: ok|warn|fail|skip, title, detail?, fix? }], next }; ok is false only when a check failed. Read only: it never stops or changes anything.",
      inputSchema: { org: z.string().optional().describe("GitHub organisation or user; default the account this machine is connected to, else the signed-in user") },
      annotations: READ,
    },
    async ({ org }) => {
      if (!deps.doctor) return NO_RUNNERS();
      try {
        return json(await deps.doctor({ org }));
      } catch (e) {
        return fromError(e, "doctor again, or buildhound doctor in a terminal");
      }
    },
  );

  server.registerTool(
    "image_build",
    {
      description:
        "Call on a Mac to give it the macOS image macOS jobs run in, when the user wants macOS jobs on it (runner_add's next says so): Apple's licence means each Mac builds its own from Apple's restore image and its Xcode. check: true only checks the Mac and returns each problem with its one fix (Xcode, the iOS simulator runtime, disk space, power), changing nothing. Otherwise it starts the build in the Buildhound agent, or returns the one already running, at once: { status: ready|building|waiting|needs_human|blocked|failed, step, step_number, steps, title, percent, seconds_left, total_seconds_left, next_step, next }. Call it again to follow it, or read runner_status. needs_human is the one password step: give the person the command to run in a terminal on this Mac; the build then continues on its own. An image that already has this Mac's Xcode is ready without building. Starting a build needs confirm: true (it downloads about 27 GB once and takes about 30 minutes).",
      inputSchema: {
        check: z.boolean().optional().describe("Only check this Mac and say what to fix; read only"),
        rebuild: z.boolean().optional().describe("Build a new image even when the one in use already has this Mac's Xcode"),
        confirm: z.boolean().optional().describe("Must be true to start a new build; following one already running needs no confirm"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ check, rebuild, confirm }) => {
      if (!deps.image) return NO_RUNNERS();
      try {
        return json(await deps.image({ check, rebuild, yes: confirm === true }));
      } catch (e) {
        const c = e as { code?: unknown };
        if (c?.code === "CONFIRM_REQUIRED") return err("CONFIRM_REQUIRED", "building the macOS image downloads about 27 GB once, takes about 30 minutes and asks the person for their password once", "call image_build again with confirm: true once the user agreed, or check: true to see what this Mac needs first");
        return fromError(e, "image_build with check: true");
      }
    },
  );

  server.registerTool(
    "route_jobs",
    {
      description: "Call to rank where each job should run by computed monthly cost: stay on GitHub-hosted, a connected machine, or a runner vendor, with the calculation, the monthly saving on a machine the team already has (after the plan, nothing to buy) and any referral agreement disclosed. Each job's runs_on is the exact line to write; upgrades lists routed jobs on a public repository whose expression must change, with the diff. Pass repo to use observed minutes from run history. Read only.",
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
