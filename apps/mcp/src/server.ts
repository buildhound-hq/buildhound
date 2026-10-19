import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_RULES, Estimator, GITHUB_RATES, GITHUB_RATES_META, RULES, VENDOR_TABLES, XCODE_CLOUD, comparisonOffers, loadWorkflow, makeContext, ruleById, runRules,
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
  /** `buildhound runner cleanup`: Buildhound's leftovers on a machine, previewed or cleared; absent on servers built before it. */
  cleanup?: (opts: Parameters<typeof Ops.runRunnerCleanup>[0]) => ReturnType<typeof Ops.runRunnerCleanup>;
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
  /** `buildhound search`: machines, repositories and jobs matching words; absent on servers built before it. */
  search?: typeof Ops.runSearch;
  /** `buildhound status`: where each kind of job goes now and why; absent on servers built before it. */
  status?: typeof Ops.runStatus;
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
  /** `buildhound billing checkout`: Paddle's checkout URL for a person to pay; absent like `runners`. */
  billing?: typeof Ops.runBillingCheckout;
  /** `buildhound billing period`: annual or monthly from the next renewal; absent like `runners`. */
  billingPeriod?: typeof Ops.runBillingPeriod;
  /** `buildhound scan --fix`: the CI report's fixes as pull requests on GitHub; absent like `runners`. */
  fix?: typeof Ops.runScanFix;
  /** `buildhound route --apply`: the routing pull request on GitHub; absent like `runners`. */
  routeApply?: typeof Ops.runRouteApply;
  /** `buildhound cache list` and `cache clear`: the package caches on the account's machines; absent like `runners`. */
  caches?: {
    list: typeof Ops.runCacheList;
    clear: (opts: Parameters<typeof Ops.runCacheClear>[0]) => ReturnType<typeof Ops.runCacheClear>;
    reset?: (opts: Parameters<typeof Ops.runCacheReset>[0]) => ReturnType<typeof Ops.runCacheReset>;
  };
  /** `buildhound run` and `buildhound rerun`: start a workflow or re-run a job through the GitHub App; absent like `runners`. */
  runs?: {
    run: (opts: Parameters<typeof Ops.runRun>[0]) => ReturnType<typeof Ops.runRun>;
    rerun: (opts: Parameters<typeof Ops.runRerun>[0]) => ReturnType<typeof Ops.runRerun>;
  };
  /** `buildhound repo-icon`: a repository's icon in the dashboard, read, set or cleared; absent like `runners`. */
  repoIcon?: (opts: Parameters<typeof Ops.runRepoIcon>[0]) => ReturnType<typeof Ops.runRepoIcon>;
  /** `buildhound image build`: the macOS image on this Mac, through the Buildhound agent; absent like `runners`. */
  image?: (opts: Parameters<typeof Ops.runImageBuild>[0]) => ReturnType<typeof Ops.runImageBuild>;
}

/**
 * A CLI error keeps its code and next; anything else is INTERNAL with a next that still points somewhere. A
 * needs_human answer (the CLI's NeedsHumanError, NEEDS_TEAM for one) is a result, not an error: the agent hands
 * its URL to a person, as with billing_checkout (AGENT_FIRST.md, the three human steps).
 */
function fromError(e: unknown, fallbackNext: string, notFoundNext = "runner_status with the same owner lists the machines") {
  const answer = (e as { answer?: { status?: unknown } } | null)?.answer;
  if (answer?.status === "needs_human") return json(answer);
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
      title: "Explain a rule",
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
    { title: "List rules", description: "Call to list every Buildhound rule id with its title and severity.", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } },
    async () => json(RULES.map(({ id, title, severity }) => ({ id, title, severity }))),
  );

  server.registerTool(
    "get_rates",
    {
      title: "Get runner rates",
      description: "Call to get the per-minute rate tables the cost model uses: GitHub-hosted, every third-party runner vendor, connected Buildhound machines, and the Xcode Cloud comparison. Also returns offers, the other ways to run CI it compares and never routes to: CI services (Codemagic, CircleCI, Buildkite, Bitrise Build Hub, AWS CodeBuild), flat macOS plans (Manzanita, MacRun) and orchestrators priced by host or repository (ushr, Cirun). Each table and offer carries a source URL and verified date.",
      inputSchema: { provider: z.string().optional().describe("Filter to one provider or offer, for example github, blacksmith, depot, warpbuild, ubicloud, jog, runs_on, buildhound, codemagic, circleci, bitrise_build_hub, manzanita") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ provider }) => {
      const tables = [{ ...GITHUB_RATES_META, rates: GITHUB_RATES }, ...VENDOR_TABLES].filter((t) => !provider || t.provider === provider);
      const offers = comparisonOffers().filter((o) => !provider || o.vendor === provider);
      return json({ tables, xcode_cloud: provider && provider !== "xcode_cloud" ? undefined : XCODE_CLOUD, offers });
    },
  );

  server.registerTool(
    "estimate_workflow_cost",
    {
      title: "Estimate a workflow's cost",
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
      title: "Scan a repository",
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

  server.registerTool(
    "scan_fix",
    {
      title: "Open the report's fixes",
      description:
        "Call when the user wants the CI report's fixes opened as pull requests on GitHub. Without confirm: true it only plans and returns { mode: \"plan\", pull_requests: [{ branch, title, rules, files, body, diff, status: \"planned\" }], no_automatic_fix, next }; with confirm: true it opens one pull request per rule (one in all with one_pr) using the user's GitHub login, and a second call updates them instead of opening more. On a private repository whose account has no plan it opens nothing and returns { status: \"needs_human\", reason: \"needs_plan\", url, next }: hand url to the user, who chooses a plan, then call again. Errors: REPO_UNKNOWN, TOKEN_REQUIRED, NO_PUSH_ACCESS, WORKFLOW_SCOPE_REQUIRED, each with next.",
      inputSchema: {
        path: z.string().default(".").describe("Repository checkout; its origin remote names the GitHub repository"),
        repo: z.string().optional().describe("owner/name on GitHub, instead of reading it from the checkout"),
        rules: z.array(z.string()).optional().describe("Rule ids to open pull requests for, default every rule with a fix"),
        one_pr: z.boolean().optional().describe("One pull request for every fix instead of one per rule"),
        dry_run: z.boolean().optional().describe("Plan only, even with confirm"),
        resolve: z.boolean().optional().describe("false skips looking up action tags on GitHub, so R17 has no fix"),
        confirm: z.boolean().optional().describe("Must be true to open pull requests; ask the user first"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, repo, rules, one_pr, dry_run, resolve, confirm }) => {
      if (!deps.fix) return NO_RUNNERS();
      try {
        const r = await deps.fix(path, { repo, rule: rules, onePr: one_pr, dryRun: dry_run, resolve, yes: confirm === true, json: true });
        return json(r.mode === "plan" && r.pull_requests.some((p) => p.status === "planned") ? { ...r, next: "call scan_fix again with confirm: true once the user agreed" } : r);
      } catch (e) {
        return fromError(e, "scan_fix with confirm omitted shows the plan");
      }
    },
  );

  const READ = { readOnlyHint: true, destructiveHint: false } as const;
  const ORG = z.string().describe("GitHub organisation or user login");

  server.registerTool(
    "jobs_list",
    {
      title: "List jobs",
      description:
        "Call to list an account's jobs, on its machines and on GitHub-hosted, newest first: repository, job name, workflow, machine (GitHub-hosted for those), result, wait and run time, with ran_on: machine|github_hosted. A job meant for the account's machines (its workflow reads a Buildhound variable) that ran on GitHub-hosted has hosted_reason { code, summary, job, fix, who: automatic|you|nobody, next } saying why; other GitHub-hosted jobs have hosted_reason null. Every filter takes several values. facets: true adds counts per value of each filter. A member of an organisation sees only repositories they can read on GitHub, and only while it is on Team; otherwise the answer is needs_human with reason team_only. Page with before set to the previous next_before.",
      inputSchema: {
        org: ORG,
        status: z.array(z.enum(["running", "failed", "succeeded", "cancelled"])).optional().describe("Only jobs with these results"),
        ran_on: z.array(z.enum(["machine", "github_hosted"])).optional().describe("Only jobs that ran here; both by default"),
        machine: z.array(z.string()).optional().describe("Only these machines, by id or name; github-hosted for jobs that ran there"),
        repository: z.array(z.string()).optional().describe("Only these repositories, owner/name"),
        workflow: z.array(z.string()).optional().describe("Only these workflows, by name"),
        os: z.array(z.enum(["macos", "linux", "windows"])).optional(),
        label: z.string().optional().describe("Only this label, such as buildhound-macos"),
        result: z.string().optional().describe("One conclusion as GitHub names it, or running"),
        facets: z.boolean().optional().describe("true adds counts per value of each filter"),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().optional().describe("next_before from the previous page"),
      },
      annotations: READ,
    },
    async ({ org, status, ran_on, machine, repository, workflow, os, label, result, facets, limit, before }) => {
      if (!deps.reads) return NO_RUNNERS();
      const csv = (v: string[] | undefined) => (v?.length ? v.join(",") : undefined);
      try {
        return json(
          await deps.reads.jobs({
            org,
            repository: csv(repository),
            machine: csv(machine),
            label,
            result,
            before,
            ...(status?.length ? { status: csv(status) } : {}),
            ...(ran_on?.length ? { ranOn: csv(ran_on) } : {}),
            ...(workflow?.length ? { workflow: csv(workflow) } : {}),
            ...(os?.length ? { os: csv(os) } : {}),
            ...(facets ? { facets: true } : {}),
            ...(limit !== undefined ? { limit: String(limit) } : {}),
          }),
        );
      } catch (e) {
        return fromError(e, `jobs_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search an account",
      description:
        "Call to find an account's machines (by name or kind), repositories (by name) and jobs (by job, workflow, repository, branch, commit message or run number), as the dashboard's search does: { owner, q, scope, groups: { machines, repositories, jobs: [{ kind, id, title, subtitle, path, at, status }] }, total, next }. A job's id goes to job_get; path is the dashboard page. A member sees only repositories they can read. Read only.",
      inputSchema: {
        org: ORG,
        q: z.string().max(200).describe("What to look for; jobs:, machines: or repositories: before it narrows the search"),
        scope: z.enum(["all", "jobs", "machines", "repositories"]).optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Results per group, 5 by default"),
      },
      annotations: READ,
    },
    async ({ org, q, scope, limit }) => {
      if (!deps.reads?.search) return NO_RUNNERS();
      try {
        return json(await deps.reads.search(q, { org, ...(scope ? { scope } : {}), ...(limit !== undefined ? { limit: String(limit) } : {}) }));
      } catch (e) {
        return fromError(e, `search with org ${org}`);
      }
    },
  );

  server.registerTool(
    "routing_status",
    {
      title: "Routing status",
      description:
        "Call to learn where an account's new jobs go now for each kind of job (macOS, Linux, Linux arm64, Linux x64) and why: { owner, role, families: [{ label, name, where: machines|github_hosted, reason, summary, fix, who: automatic|you|nobody, tone, next, mode, changed_at, machines: [{ id, name, os, why, phrase, since }], secrets: { where, reason, summary, fix, who, next } | null }], trust_banner: { show, count, summary, fix, can_dismiss, next }, next }. who: automatic comes back on its own, so nobody needs to act; you means a person runs next. Each machine's why says why it takes jobs or not: free, busy, offline, paused, in_use, on_battery, memory_pressure, heat, low_power and the like. The same JSON as buildhound status --json. Read only.",
      inputSchema: { org: ORG },
      annotations: READ,
    },
    async ({ org }) => {
      if (!deps.reads?.status) return NO_RUNNERS();
      try {
        return json(await deps.reads.status({ org }));
      } catch (e) {
        return fromError(e, `routing_status with org ${org}`);
      }
    },
  );

  server.registerTool(
    "job_get",
    {
      title: "Get a job",
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

  const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("The repository, owner/name");

  server.registerTool(
    "workflows_list",
    {
      title: "List runnable workflows",
      description:
        "Call to see which workflows in a repository can be started by hand (those with on: workflow_dispatch), read through the Buildhound GitHub App on the default branch: { repository, default_branch, branches, workflows: [{ id, name, path, inputs: [{ name, type, required, default, options }] }], not_dispatchable: [{ name, path, reason }], can_run, docs_url, next }. can_run is false for a member, who may look but not start. Read only. Errors: NOT_FOUND, INVALID_REQUEST, TOKEN_REQUIRED.",
      inputSchema: { repo: REPO },
      annotations: READ,
    },
    async ({ repo }) => {
      if (!deps.runs) return NO_RUNNERS();
      try {
        return json(await deps.runs.run({ repo }));
      } catch (e) {
        return fromError(e, `workflows_list with repo ${repo}`, `repos_list with org ${repo.split("/")[0]} lists the repositories`);
      }
    },
  );

  server.registerTool(
    "workflow_run",
    {
      title: "Run a workflow",
      description:
        "Call only when the user asked to start a workflow. Starts one that has on: workflow_dispatch through the Buildhound GitHub App, on a branch or tag (default the default branch) with its inputs as strings; its jobs route like any other run, to the user's machines or, when none can take them, to GitHub-hosted runners that GitHub bills, and a job that uses secrets reaches only a trusted machine. The same request within a minute answers status already_dispatched and starts nothing. Admins only. Requires confirm: true. Returns { status: dispatched|already_dispatched, repository, workflow: { id, name, path }, ref, inputs, runs_url, next }. Errors: CONFIRM_REQUIRED, NOT_DISPATCHABLE (no workflow_dispatch, disabled, or archived), INVALID_REQUEST (inputs), NOT_FOUND, NOT_ADMIN.",
      inputSchema: {
        repo: REPO,
        workflow: z.string().min(1).describe("The workflow file name (release.yml), its path, id or name; workflows_list lists them"),
        ref: z.string().optional().describe("Branch or tag to run on; the default branch when omitted"),
        inputs: z.record(z.string(), z.string()).optional().describe("workflow_dispatch inputs by name, every value a string"),
        confirm: z.boolean().optional().describe("Must be true: it starts a run, which may be billed on GitHub-hosted runners"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ repo, workflow, ref, inputs, confirm }) => {
      if (!deps.runs) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `starting ${workflow} in ${repo} runs its jobs on the user's machines or on GitHub-hosted runners that GitHub bills`, "call workflow_run again with confirm: true once the user agreed");
      try {
        return json(await deps.runs.run({ repo, workflow, ref, input: Object.entries(inputs ?? {}).map(([k, v]) => `${k}=${v}`), yes: true }));
      } catch (e) {
        return fromError(e, `workflows_list with repo ${repo}`, `workflows_list with repo ${repo} lists the workflows`);
      }
    },
  );

  server.registerTool(
    "job_rerun",
    {
      title: "Run a job again",
      description:
        "Call only when the user asked to re-run a job. Re-runs a finished job the account's machines ran (ids from jobs_list), or with failed: true every failed or cancelled job of its run, through the Buildhound GitHub App; it routes like any other run, to the user's machines or GitHub-hosted. Admins only. Requires confirm: true. Returns { status: requested, scope: job|failed_jobs, repository, run_id, job, run_url, next }. Errors: CONFIRM_REQUIRED, RUN_IN_PROGRESS (the job or its run has not finished, or a re-run was just asked), NOT_FOUND, NOT_ADMIN.",
      inputSchema: {
        org: ORG,
        id: z.string().describe("The job id from jobs_list"),
        failed: z.boolean().optional().describe("true re-runs every failed or cancelled job of the job's run"),
        confirm: z.boolean().optional().describe("Must be true: a re-run starts work, which may be billed on GitHub-hosted runners"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ org, id, failed, confirm }) => {
      if (!deps.runs) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `re-running ${failed ? "the failed jobs of the run" : `job ${id}`} starts work on the user's machines or on GitHub-hosted runners that GitHub bills`, "call job_rerun again with confirm: true once the user agreed");
      try {
        return json(await deps.runs.rerun({ org, job: id, failed, yes: true }));
      } catch (e) {
        return fromError(e, `job_get with org ${org} and id ${id}`, `jobs_list with org ${org} lists the job ids`);
      }
    },
  );

  server.registerTool(
    "overview_get",
    {
      title: "Get the overview",
      description: "Call to see a month at a glance for an account: jobs on its machines and their GitHub-hosted cost, jobs that fell back to GitHub-hosted, the machines with the label families each serves, recent jobs, and what needs a person (offline machines, jobs waiting, plan holds). With Fall back to GitHub-hosted off, waiting families come merged by cause in waits: [{ labels, names, cause: working|paused|offline|down, act, machines, title, text, next }]; act false is status (a machine that serves them is online, so they start as soon as one is free), and only act true items also appear in attention, as kind waiting_for_machine with labels and cause.",
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
      title: "Get the savings",
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
    "repo_icon_get",
    {
      title: "Repository icon",
      description:
        "Call to see which icon a repository shows in the Buildhound dashboard and what it could show: { repository, icon_url, icon_source: custom|homepage|owner, choice (what an admin picked, null for the order: uploaded image, homepage favicon, owner picture), homepage, favicon: { state, url, checked_at }, owner_url, custom_url, next }. Read only. Errors: NOT_FOUND, TOKEN_REQUIRED.",
      inputSchema: { repo: REPO },
      annotations: READ,
    },
    async ({ repo }) => {
      if (!deps.repoIcon) return NO_RUNNERS();
      try {
        return json(await deps.repoIcon({ repo }));
      } catch (e) {
        return fromError(e, `repo_icon_get with repo ${repo}`, `repos_list with org ${repo.split("/")[0]} lists the repositories`);
      }
    },
  );

  server.registerTool(
    "repo_icon_set",
    {
      title: "Set repository icon",
      description:
        "Call when the user asked to change a repository's icon in the Buildhound dashboard. source homepage shows its GitHub homepage's favicon (read weekly by Buildhound), owner shows the owner's GitHub picture; both drop an uploaded image. file uploads the user's own square PNG, SVG, ICO, WebP or JPEG of at most 256 KB from this machine (source custom). Admins only, recorded in the account's audit log. Idempotent: the same request again changes nothing (status unchanged). Returns the same shape as repo_icon_get with status updated|unchanged. Errors: INVALID_IMAGE, FILE_NOT_FOUND, NOT_ADMIN, NOT_FOUND, USAGE.",
      inputSchema: {
        repo: REPO,
        source: z.enum(["homepage", "owner", "custom"]).describe("homepage, owner, or custom with file"),
        file: z.string().optional().describe("Path to the image on this machine, for source custom"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ repo, source, file }) => {
      if (!deps.repoIcon) return NO_RUNNERS();
      if (source === "custom" && !file) return err("USAGE", "source custom needs file, the path to the image", "call repo_icon_set again with file set to a PNG, SVG, ICO, WebP or JPEG up to 256 KB");
      try {
        return json(await deps.repoIcon(source === "custom" ? { repo, file } : { repo, source }));
      } catch (e) {
        return fromError(e, `repo_icon_get with repo ${repo}`, `repos_list with org ${repo.split("/")[0]} lists the repositories`);
      }
    },
  );

  server.registerTool(
    "repo_icon_clear",
    {
      title: "Clear repository icon",
      description:
        "Call only when the user asked to clear a repository's icon. Drops what an admin set, an uploaded image included, so the repository shows its homepage's favicon, else its owner's picture. Admins only, recorded in the audit log. Requires confirm: true. Idempotent: clearing again changes nothing (status unchanged). Returns the same shape as repo_icon_get with status cleared|unchanged. Errors: CONFIRM_REQUIRED, NOT_ADMIN, NOT_FOUND.",
      inputSchema: {
        repo: REPO,
        confirm: z.boolean().optional().describe("Must be true: an uploaded image is deleted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ repo, confirm }) => {
      if (!deps.repoIcon) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `clearing the icon of ${repo} drops an uploaded image`, "call repo_icon_clear again with confirm: true once the user agreed");
      try {
        return json(await deps.repoIcon({ repo, clear: true, yes: true }));
      } catch (e) {
        return fromError(e, `repo_icon_get with repo ${repo}`, `repos_list with org ${repo.split("/")[0]} lists the repositories`);
      }
    },
  );

  server.registerTool(
    "repos_list",
    {
      title: "List repositories",
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
      title: "Get the plan",
      description: "Call to see an account's plan: what it can buy (Personal or Team, by GitHub account type), what it has now, connected machines, the machine days with jobs so far this period (machine_days, against machines times days_elapsed: you pay only for machine days with jobs, idle machine days cost nothing; billable_machines is machine_days over days_elapsed, kept for older clients), an estimate in cents, and the price per machine billed monthly and annually. Never per minute.",
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

  server.registerTool(
    "billing_checkout",
    {
      title: "Start a checkout",
      description:
        "Call when a person wants to pay for Personal (a personal GitHub account) or Team (an organisation) so private repositories route to their machines. Returns needs_human with Paddle's checkout URL: give the URL to the person, wait until they say they have paid, then call plan_get. Charges nothing by itself. The first payment covers the machines connected now; each renewal settles the period's machine days with jobs against what was paid, so idle machine days come off the next payment; never per minute; the first payment is refundable on request within 30 days. Admins only.",
      inputSchema: { org: ORG, plan: z.enum(["personal", "team"]).describe("personal for a personal account, team for an organisation"), billing: z.enum(["monthly", "annual"]).default("annual").describe("annual by default ($8 or $20 a machine a month), or monthly ($10 or $24)") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ org, plan, billing }) => {
      if (!deps.billing) return NO_RUNNERS();
      try {
        return json(await deps.billing({ org, plan, annual: billing === "annual" }));
      } catch (e) {
        return fromError(e, `billing_checkout with org ${org}`);
      }
    },
  );

  server.registerTool(
    "billing_period",
    {
      title: "Switch the billing period",
      description:
        "Call when a person wants their Personal or Team subscription billed annually instead of monthly, or monthly instead of annually. The switch applies at the next renewal on the same plan and machines, and nothing is charged now; asking for the period billed now drops a scheduled switch. Without confirm: true it returns what would happen (dry_run: true) and changes nothing; show that to the person and call again with confirm: true once they agree. Admins only.",
      inputSchema: { org: ORG, billing: z.enum(["monthly", "annual"]).describe("the period to bill from the next renewal"), confirm: z.boolean().default(false).describe("true makes the switch; otherwise only says what would happen") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ org, billing, confirm }) => {
      if (!deps.billingPeriod) return NO_RUNNERS();
      try {
        return json(await deps.billingPeriod({ org, billing, yes: confirm }));
      } catch (e) {
        return fromError(e, `billing_period with org ${org}`);
      }
    },
  );

  // audit_log_list is the name that says what it reads (docs/BRAND.md, Glossary); audit_list stays for agents that know it.
  for (const name of ["audit_log_list", "audit_list"]) {
    server.registerTool(
      name,
      {
        title: "List the audit log",
        description: `Call to see an account's audit log, newest first: every admin change to machines, routing and defaults, who made it and from where (dashboard, cli, mcp, menu_bar), each with summary ("changed performance on Benys-Mac-mini") and changes [{ field, from, to }]. Filter with q (words) and arrays of action groups (settings, repositories, trust, routing, fallback, machine_added, machine_removed, billing, other), machines, actors and sources, and from/to dates; facets: true adds counts per value; fold: true folds the same change to several machines within a minute into one entry with targets. Admins only. On an organisation without Team it returns needs_human with reason team_only and the billing page, where an admin upgrades; events are still recorded.${name === "audit_list" ? " Same as audit_log_list." : ""}`,
        inputSchema: {
          org: ORG,
          q: z.string().max(200).optional().describe("Words in the person, the machine or repository, or the change"),
          action: z.array(z.enum(["settings", "repositories", "trust", "routing", "fallback", "machine_added", "machine_removed", "billing", "other"])).optional(),
          machine: z.array(z.string()).optional().describe("Machine names"),
          actor: z.array(z.string()).optional().describe("GitHub logins"),
          source: z.array(z.enum(["dashboard", "cli", "mcp", "menu_bar"])).optional(),
          from: z.string().optional().describe("ISO date or time, UTC"),
          to: z.string().optional().describe("ISO date (the whole day) or time, UTC"),
          facets: z.boolean().optional(),
          fold: z.boolean().optional(),
          before: z.string().optional().describe("The next page: next_before from the previous one"),
        },
        annotations: READ,
      },
      async ({ org, q, action, machine, actor, source, from, to, facets, fold, before }) => {
        if (!deps.reads) return NO_RUNNERS();
        const csv = (v: string[] | undefined) => (v?.length ? v.join(",") : undefined);
        try {
          const filters = { search: q, action: csv(action), machine: csv(machine), actor: csv(actor), source: csv(source), from, to, ...(facets ? { facets: true } : {}), ...(fold ? { fold: true } : {}) };
          const given = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
          return json(await deps.reads.audit({ org, before, ...given }));
        } catch (e) {
          return fromError(e, `${name} with org ${org}`);
        }
      },
    );
  }

  server.registerTool(
    "settings_get",
    {
      title: "Get account defaults",
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
      title: "Set account defaults",
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
      title: "Machine status",
      description:
        "Call to see an account's connected machines (status, heartbeat age, running jobs over capacity, labels, image, Buildhound agent version, routing, stay_awake: never, plugged_in or always, plugged_in when none is set), each machine's health (cpu_percent, memory_percent, disk_free_gb, uptime_seconds, failing_checks: keys of the agent's doctor checks that fail, among sleep, power_restart, filevault, disk and image; null until the machine reports them), its recent activity (connected, disconnected, rebooted, updated, paused, resumed, hosted) and the failover state per label. Without org it asks the Buildhound agent on this machine over its local socket.",
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
      title: "Connect this machine",
      description: "Call only when the user asked to connect THIS machine as a single-use CI runner. Registers it, writes the Buildhound agent's config, installs and starts the Buildhound agent; every step is idempotent and reported. Requires confirm: true. May return status needs_human with one URL for a GitHub step, a plan, or Team (team_only: a member connects their own machine only when the organisation is on Team). check: true only reads this machine and returns { status: checked, ready, can_connect, checks: [{ id, status, title, fix? }], next }, changing nothing and needing no confirm: on Linux it says whether the machine can run job VMs (KVM, cores, memory, disk, systemd, root). A Linux host connects as root once, for the system service, the job VMs' network and KVM: without root the tool returns needs_human with reason root_needed and the one sudo command for a person; a failed check returns HOST_NOT_READY with its fix. A connected machine's result carries trust: { status: trusted } or { status: needs_human, reason: trust_needs_person, url, blocked_by?: filevault_off|disk_encryption_off, next }. Only jobs that use secrets need it and only a person marks a machine Trusted: hand url and next to the user, never run sudo fdesetup yourself.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machine"),
        label: z.string().optional().describe("What the machine runs: macos, linux, or macos,linux; omit it for both on a Mac or Linux on a Linux host. check: true says whether a machine is ready"),
        name: z.string().optional().describe("Machine name, default the hostname"),
        capacity: z.number().int().min(1).max(64).optional().describe("Jobs at once; omit to let the Buildhound agent plan it from memory: one macOS job, then as many 8 GB Linux jobs as fit, laptops one at a time"),
        repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional().describe("Personal accounts: only these owner/name repositories"),
        check: z.boolean().optional().describe("true only checks whether this machine can run job VMs; registers and writes nothing, no confirm needed"),
        confirm: z.boolean().optional().describe("Must be true: connecting a machine changes this computer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, label, name, capacity, repositories, check, confirm }) => {
      if (!deps.runners) return NO_RUNNERS();
      if (check === true) {
        try {
          return json(await deps.runners.add({ org, check: true }));
        } catch (e) {
          return fromError(e, `runner_add with org ${org} and check: true`);
        }
      }
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
      title: "Change a machine",
      description:
        "Call to change a machine's routing or settings. Routing: primary takes jobs whenever it can, backup only when no primary can, off stays connected and visible but takes none. Settings: paused (running jobs finish), performance (quiet, balanced or max), comfort (adaptive eases a running job off before refusing new ones, or off), idle_only (only when not in use), plugged_in_only, stay_awake (hold off idle sleep between jobs: never, plugged_in on mains power only, the default, or always; closing a laptop's lid still sleeps it unless an external display is connected); the machine picks them up within 30 seconds, and a later change made on the machine wins. Repositories, on a personal account: repositories replaces the list a machine serves (an empty list serves every repository the Buildhound GitHub App covers), add_repositories and remove_repositories change it; the machine applies it on its next check-in, and a repository the App does not cover returns needs_human with the GitHub page where a person adds it. Set at least one field. Idempotent and reversible; returns the settings, the repositories, whether anything changed and the failover state.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        org: z.string().optional().describe("GitHub organisation or user that owns the machine; the same as owner"),
        owner: z.string().optional().describe("GitHub organisation or user that owns the machine; pass this or org"),
        routing: ROUTING.optional(),
        paused: z.boolean().optional().describe("true stops new jobs; false takes jobs again"),
        performance: z.enum(["quiet", "balanced", "max"]).optional(),
        comfort: z.enum(["adaptive", "off"]).optional().describe("adaptive comfort: ease a running job off (lower priority, a smaller next job) before refusing new jobs; off keeps today's checks"),
        stay_awake: z.enum(["never", "plugged_in", "always"]).optional().describe("hold off idle sleep between jobs: never, plugged_in (on mains power only, the default) or always"),
        idle_only: z.boolean().optional().describe("only when not in use: take jobs only while nobody is using the machine"),
        plugged_in_only: z.boolean().optional().describe("take jobs only while plugged in"),
        repositories: z.array(z.string()).optional().describe("personal accounts: the repositories the machine serves, as owner/name; [] serves every repository the App covers"),
        add_repositories: z.array(z.string()).optional().describe("personal accounts: also serve these repositories, as owner/name"),
        remove_repositories: z.array(z.string()).optional().describe("personal accounts: stop serving these repositories"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ machine, org, owner: ownerArg, routing, paused, performance, comfort, stay_awake, idle_only, plugged_in_only, repositories, add_repositories, remove_repositories }) => {
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
            ...(comfort !== undefined ? { comfort } : {}),
            ...(stay_awake !== undefined ? { stayAwake: stay_awake } : {}),
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
      title: "Remove a machine",
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
    "runner_cleanup",
    {
      title: "Free up space on a machine",
      description:
        "Call when a machine is low on disk, or the user asks to free up space on it. Without confirm: true it only reads what the machine's last check-in reported: what Buildhound keeps there (the image in use, old images, the image build cache, package caches) and what clearing its leftovers frees, as { status: preview, machine, disk_free_bytes, storage: { used, reclaimable }, reclaimable_bytes, cleanup, next }. With confirm: true it asks the machine to clear them on its next check-in, within 30 seconds: images superseded by a newer one, the macOS image build's cache and package caches over their limits, never the image in use or anything a running job uses, never the user's own files; returns { status: requested, machine, requested_at, reclaimable_bytes, next }, and calling without confirm afterwards shows the result (cleanup.status done, bytes_freed). Idempotent: asking again while a request waits returns it. When reclaimable_bytes is 0 the rest of the disk is the user's own files. Errors: USAGE, NOT_FOUND, NOT_ADMIN, TOKEN_REQUIRED.",
      inputSchema: {
        machine: z.string().describe("Machine id or name"),
        org: z.string().describe("GitHub organisation or user that owns the machine"),
        confirm: z.boolean().optional().describe("true clears the leftovers; without it the tool only reads what clearing would free"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ machine, org, confirm }) => {
      if (!deps.runners?.cleanup) return NO_RUNNERS();
      try {
        const r = await deps.runners.cleanup({ machine, org, yes: confirm === true });
        // The preview's next is the CLI's --yes; an agent calls this tool again instead.
        return json(r.status === "preview" && r.next.endsWith(" --yes") ? { ...r, next: "call runner_cleanup again with confirm: true once the user agreed" } : r);
      } catch (e) {
        return fromError(e, `runner_status with org ${org}`);
      }
    },
  );

  const REPOSITORY = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

  server.registerTool(
    "cache_list",
    {
      title: "List package caches",
      description:
        "Call to see what the package caches (npm, pnpm, Yarn, Bun, pip, Go and the like, kept per repository) take on an account's machines, as each machine's last check-in reported: { owner, machines: [{ machine, reported_at, bytes, limit_bytes, repositories: [{ repository, bytes, last_used_at, in_use }], pending_clear }], bytes, next }. reported_at is null for a machine whose Buildhound agent does not report sizes yet. Read only. Errors: NOT_FOUND (no such machine, or none connected), NOT_ADMIN, TOKEN_REQUIRED.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machines"),
        machine: z.string().optional().describe("Only this machine, by id or name"),
        repository: REPOSITORY.optional().describe("Only this repository's caches, as owner/name"),
      },
      annotations: READ,
    },
    async ({ org, machine, repository }) => {
      if (!deps.caches) return NO_RUNNERS();
      try {
        return json(await deps.caches.list({ org, machine, repository }));
      } catch (e) {
        return fromError(e, `cache_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "cache_clear",
    {
      title: "Clear package caches",
      description:
        "Call only when the user asked to clear package caches, for example when a job keeps reading a broken package. Asks the account's machines, or the one named, to drop one repository's caches or every repository's; each machine clears on its next check-in, within 30 seconds, a cache a running job holds goes when that job ends, and jobs download those packages again next time. Requires confirm: true. Idempotent: asking again replaces the request. Returns { status: requested, owner, repository, machines: [{ id, name, requested_at }], next }. Errors: CONFIRM_REQUIRED, NOT_FOUND, NOT_ADMIN, TOKEN_REQUIRED.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machines"),
        machine: z.string().optional().describe("Only this machine, by id or name; default every machine of the account"),
        repository: REPOSITORY.optional().describe("Only this repository's caches, as owner/name; default every repository"),
        confirm: z.boolean().optional().describe("Must be true: clearing makes the next jobs download their packages again"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, machine, repository, confirm }) => {
      if (!deps.caches) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `clearing ${repository ? `${repository}'s package caches` : "every repository's package caches"} on ${machine ?? `every machine of ${org}`} makes the next jobs download those packages again`, "call cache_clear again with confirm: true once the user agreed");
      try {
        return json(await deps.caches.clear({ org, machine, repository, yes: true }));
      } catch (e) {
        return fromError(e, `cache_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "cache_reset",
    {
      title: "Reset caches",
      description:
        "Call only when the user asked to start a machine's caches over, for example when clearing a repository's caches did not fix a job or the cache folder looks broken. Asks the account's machines, or the one named, for the clean slate: every repository's package caches, the tool cache and anything else in the machine's cache folder go; each machine resets on its next check-in, within 30 seconds, a cache a running job holds goes when that job ends, and the next jobs download everything again. For one repository use cache_clear. Requires confirm: true. Idempotent: asking again replaces the request. Returns { status: requested, owner, machines: [{ id, name, requested_at }], next }. Errors: CONFIRM_REQUIRED, NOT_FOUND, NOT_ADMIN, TOKEN_REQUIRED.",
      inputSchema: {
        org: z.string().describe("GitHub organisation or user that owns the machines"),
        machine: z.string().optional().describe("Only this machine, by id or name; default every machine of the account"),
        confirm: z.boolean().optional().describe("Must be true: a reset makes the next jobs download everything again"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ org, machine, confirm }) => {
      if (!deps.caches?.reset) return NO_RUNNERS();
      if (confirm !== true) return err("CONFIRM_REQUIRED", `resetting the caches on ${machine ?? `every machine of ${org}`} drops every repository's package caches and the tool cache, so the next jobs download everything again`, "call cache_reset again with confirm: true once the user agreed");
      try {
        return json(await deps.caches.reset({ org, machine, yes: true }));
      } catch (e) {
        return fromError(e, `cache_list with org ${org}`);
      }
    },
  );

  server.registerTool(
    "failover_state",
    {
      title: "Failover state",
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
      title: "Check this machine",
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
      title: "Build the macOS image",
      description:
        "Call on a Mac to give it the macOS image macOS jobs run in, when the user wants macOS jobs on it (runner_add's next says so): Apple's licence means each Mac builds its own from Apple's restore image and its Xcode. check: true only checks the Mac and returns each problem with its one fix (Xcode, the iOS simulator runtime, disk space, power), changing nothing. Otherwise it starts the build in the Buildhound agent, or returns the one already running, at once: { status: ready|building|waiting|needs_human|blocked|failed, step, step_number, steps, title, percent, seconds_left, total_seconds_left, next_step, next }. Call it again to follow it, or read runner_status. needs_human is the one password step: give the person the command to run in a terminal on this Mac; the build then continues on its own. An image that already has this Mac's Xcode is ready without building. Starting a build needs confirm: true (it downloads about 27 GB once and takes about 30 to 45 minutes).",
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
        if (c?.code === "CONFIRM_REQUIRED") return err("CONFIRM_REQUIRED", "building the macOS image downloads about 27 GB once, takes about 30 to 45 minutes and asks the person for their password once", "call image_build again with confirm: true once the user agreed, or check: true to see what this Mac needs first");
        return fromError(e, "image_build with check: true");
      }
    },
  );

  server.registerTool(
    "route_jobs",
    {
      title: "Rank where jobs could run",
      description: "Call to rank where each job should run by computed monthly cost: stay on GitHub-hosted, a connected machine, or a runner vendor, with the calculation, the monthly saving on a machine the team already has (after the plan, nothing to buy) and any referral agreement disclosed. Each job's runs_on is the exact line to write; upgrades lists routed jobs on a public repository whose expression must change, with the diff. Pass repo to use observed minutes from run history. Read only; route_apply opens the routing pull request.",
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

  server.registerTool(
    "route_apply",
    {
      title: "Open the routing pull request",
      description:
        "Call when the user wants their jobs routed to the machines they connected. Opens one pull request (branch buildhound/route) that changes each job a connected machine can run to the routing expression, GitHub-hosted as the fallback, with the measured speed-up, the monthly saving and its calculation, the assumption and the stay option in its body. A job that can reach secrets gets its family's trusted variable (BUILDHOUND_MACOS_TRUSTED or BUILDHOUND_LINUX_TRUSTED), which only machines a person marked Trusted serve, and runs on GitHub-hosted until one is connected; routed[].secrets says why. Without confirm: true it only plans and returns { mode: \"plan\", pull_request: { branch, title, files, body, diff, status: \"planned\" } | null, routed, not_routed, upgrades, saving, next }; with confirm: true it opens the pull request with the user's GitHub login, and a second call updates it or reports unchanged instead of opening another. On a private repository whose account has no plan it opens nothing and returns { status: \"needs_human\", reason: \"needs_plan\", url, next }: hand url to the user, who chooses a plan, then call again. Errors: REPO_UNKNOWN, TOKEN_REQUIRED, NO_PUSH_ACCESS, WORKFLOW_SCOPE_REQUIRED, each with next.",
      inputSchema: {
        path: z.string().default(".").describe("Repository checkout; its origin remote names the GitHub repository"),
        repo: z.string().optional().describe("owner/name on GitHub, instead of reading it from the checkout"),
        days: z.number().int().positive().optional().describe("Days of run history for the speed-up and the saving, default 30"),
        dry_run: z.boolean().optional().describe("Plan only, even with confirm"),
        confirm: z.boolean().optional().describe("Must be true to open the pull request; ask the user first"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ path, repo, days, dry_run, confirm }) => {
      if (!deps.routeApply) return NO_RUNNERS();
      try {
        const r = await deps.routeApply(path, { repo, days, dryRun: dry_run, yes: confirm === true, json: true });
        return json(r.mode === "plan" && r.pull_request?.status === "planned" ? { ...r, next: "call route_apply again with confirm: true once the user agreed" } : r);
      } catch (e) {
        return fromError(e, "route_apply with confirm omitted shows the plan");
      }
    },
  );

  return server;
}
