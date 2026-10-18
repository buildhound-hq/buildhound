import { DEFAULT_RULE_CONFIG, planRoutingPullRequest, selectRoutingMoves } from "@buildhound/core";
import type { RoutingPullRequest, RuleConfig, SpeedMeasure } from "@buildhound/core";
import type { PlanResponse } from "@buildhound/shared";
import { ApiClient, resolveApiUrl } from "../lib/api";
import { audit, resolveSource } from "../lib/audit";
import { openFixPullRequest, prepareWrite, writeError } from "../lib/fix-pr";
import type { FixStatus, Rest, WriteTarget } from "../lib/fix-pr";
import { defaultTokenPermission, peakConcurrency, peakConcurrencyOf, routingCandidates } from "../lib/routing";
import { color, count, done, money, next as nextLine } from "../lib/style";
import { findToken } from "../lib/token";
import { NeedsHumanError } from "../output";
import type { RouteOptions } from "./route";
import { parseDays } from "./scan";

/**
 * `buildhound route --apply` (ROADMAP B13.3): the routing pull request. Every job a connected machine can run moves to
 * the routing expression for the repository's visibility, with its GitHub-hosted label as the fallback, and on a public
 * repository every older expression is upgraded. A job that can reach secrets reads its family's trusted variable
 * (`BUILDHOUND_MACOS_TRUSTED`), which only machines a person marked Trusted serve (ADR-023, CLAUDE.md rule 19). Built and opened like `scan --fix`: the person's token, the default
 * branch's head, one branch (`buildhound/route`), a rerun updates it or reports `unchanged`, never a duplicate.
 */

export interface RouteApplyOptions extends RouteOptions {
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
}

export interface RoutedJob {
  workflow: string;
  job: string;
  name: string;
  from: string;
  to: string;
  variable: string;
  /** Why the job reads the trusted variable: the classifier's reasons. Empty for a job any connected machine may run. */
  secrets: string[];
  /** Its runs-on before, when it already read the plain variable and moves to the trusted one; null otherwise. */
  today: string | null;
  os: "macos" | "linux";
  minutes_per_month: number;
  cents_per_month: number;
  basis: "history" | "default";
  /** Medians of successful runs on each side; `speed_up` null until each side has three. */
  speed: { hosted: SpeedJson | null; machine: SpeedJson | null; speed_up: number | null } | null;
  /** `route`'s ranking by computed monthly cost, "stay" included (CLAUDE.md rule 15). */
  ranking: { stay_cents: number; cheapest: { provider: string; label: string; cents: number } } | null;
}

interface SpeedJson { runs: number; median_seconds: number; median_wait_seconds: number | null }

export interface RouteApplyResult {
  repo: string;
  /** plan: nothing written, confirm with --yes; dry_run: nothing written by request; applied: the pull request opened or updated. */
  mode: "plan" | "dry_run" | "applied";
  base: { branch: string; sha: string } | null;
  /** Null when nothing would change: every job already routed, or none a connected machine can run. */
  pull_request: { branch: string; title: string; status: FixStatus; url: string | null; number: number | null; note?: string; files: Array<{ path: string; added: number; removed: number }>; body: string; diff: string } | null;
  routed: RoutedJob[];
  not_routed: Array<{ workflow: string; job: string; label: string | null; reason: string }>;
  already_routed: Array<{ workflow: string; job: string; variable: string }>;
  upgrades: Array<{ workflow: string; jobs: Array<{ job: string; from: string; to: string | null }> }>;
  saving: {
    public_repository: boolean;
    hosted_cents_per_month: number;
    minutes_per_month: number;
    machine_fee_cents: number;
    macos_peak_concurrency: number;
    machines_needed: number;
    monthly_saving_cents: number;
    claimed_cents_per_month: number;
  };
  assumptions: string[];
  next: string;
}

const UNKNOWN_REPO = "<owner/name>";

/** The command to run again, with --yes when `yes`. Flags are kept so an agent repeats exactly what it asked for. */
export function applyCommand(path: string, opts: RouteApplyOptions, extra: { yes?: boolean; repo?: string } = {}): string {
  const parts = ["buildhound route"];
  if (path !== ".") parts.push(path);
  parts.push("--apply");
  const repo = extra.repo ?? opts.repo;
  if (repo) parts.push(`--repo ${repo}`);
  if (opts.days !== undefined && String(opts.days) !== "30") parts.push(`--days ${opts.days}`);
  if (extra.yes) parts.push("--yes");
  return parts.join(" ");
}

function speedJson(s: SpeedMeasure | null): RoutedJob["speed"] {
  if (!s) return null;
  const one = (x: SpeedMeasure["hosted"]): SpeedJson | null => (x ? { runs: x.runs, median_seconds: x.medianSeconds, median_wait_seconds: x.medianWaitSeconds } : null);
  return { hosted: one(s.hosted), machine: one(s.machine), speed_up: s.speedUp };
}

function routedJson(m: RoutingPullRequest["routed"][number]): RoutedJob {
  return {
    workflow: m.workflow,
    job: m.jobId,
    name: m.name,
    from: m.from,
    to: m.to,
    variable: m.variable,
    secrets: m.secrets ?? [],
    today: m.today ?? null,
    os: m.os,
    minutes_per_month: m.minutesPerMonth,
    cents_per_month: m.centsPerMonth,
    basis: m.basis,
    speed: speedJson(m.speed),
    ranking: m.ranking ? { stay_cents: m.ranking.stayCents, cheapest: m.ranking.cheapest } : null,
  };
}

/**
 * Plan the routing pull request and, with --yes, open or update it. Without --yes (or with --dry-run) nothing is
 * written. A secret-bearing job never gets the plain variable (CLAUDE.md rule 19): it gets its family's trusted one, as
 * `route` recommends, and one already on the plain variable moves to the trusted one.
 */
/**
 * The account's plan from the control plane, or null when it cannot be read (no token, an account Buildhound does not
 * know yet, the network): routing then goes ahead as before, with an assumption line saying the plan was not checked.
 * A needs_human answer (NEEDS_TEAM for a member of an organisation without Team) ends the command with that answer.
 */
async function readPlan(owner: string, token: string | undefined, next: string): Promise<PlanResponse | null> {
  const found = findToken(token);
  if (!found) return null;
  try {
    const r = await new ApiClient(resolveApiUrl(undefined), found).request<PlanResponse>("GET", `/v1/accounts/${encodeURIComponent(owner)}/plan`, undefined, next);
    if (r.kind === "needs_human") throw new NeedsHumanError(r.body);
    return r.body;
  } catch (e) {
    if (e instanceof NeedsHumanError) throw e;
    return null;
  }
}

export async function runRouteApply(path: string, opts: RouteApplyOptions, deps: { github?: Rest; plan?: (owner: string) => Promise<PlanResponse | null> } = {}): Promise<RouteApplyResult> {
  const command = applyCommand(path, opts);
  const apply = Boolean(opts.yes) && !opts.dryRun;
  const days = parseDays(opts.days, command);
  let src = await resolveSource({ path, repo: opts.repo, token: opts.token, days, next: command });
  const assumptions: string[] = src.note ? [src.note] : [];

  let target: WriteTarget | null = null;
  if (apply) {
    target = await prepareWrite({
      src,
      repoGiven: Boolean(opts.repo),
      token: opts.token,
      github: deps.github,
      command: applyCommand(path, opts, { yes: true }),
      unknownRepo: applyCommand(path, opts, { yes: true, repo: UNKNOWN_REPO }),
      purpose: `opening the routing pull request needs a GitHub token that can push to ${src.repo}`,
      maintainer: (full) => `ask a maintainer of ${full} to run npx buildhound route --apply --repo ${full} --yes`,
    });
    src = target.src;
    assumptions.push(...target.assumptions);
  }

  // A private repository routes only on a plan (CLAUDE.md rule 9): the control plane keeps its variable cleared until
  // then, so the pull request would merge and every job would stay on GitHub-hosted. Stop before writing anything, as
  // the dashboard does (route-repository.ts). Visibility is known once GitHub was read: run history or the write target.
  if (src.repository.private && (src.history || target) && src.repo !== "local/repo") {
    const owner = src.repo.split("/")[0]!;
    const again = applyCommand(path, opts, { yes: true });
    const plan = await (deps.plan ?? ((o: string) => readPlan(o, opts.token, again)))(owner);
    if (plan?.effective === "none") {
      const url = plan.checkout_url ?? `https://app.buildhound.sh/${owner}/settings/billing`;
      throw new NeedsHumanError({
        status: "needs_human",
        reason: "needs_plan",
        url,
        next: `a person chooses a plan for ${owner}, then ${again}`,
        error: { code: "NEEDS_PLAN", message: `${src.repo} is private and ${owner} has no plan, so its jobs would stay on GitHub-hosted; private repositories route on ${plan.plan === "team" ? "Team" : "Personal"}`, next: `a person chooses a plan for ${owner}, then ${again}` },
      });
    }
    if (!plan) assumptions.push(`${owner}'s plan could not be checked; a private repository routes only once the account has Personal or Team`);
  }

  const tokenPermission = await defaultTokenPermission(src, opts.token, target?.gh ?? deps.github);
  const a = await audit(src, []);
  assumptions.push(...a.assumptions);
  const routing: RuleConfig["routing"] = { ...DEFAULT_RULE_CONFIG.routing, ...src.config.rules.routing };
  const config: RuleConfig = { ...DEFAULT_RULE_CONFIG, ...src.config.rules, routing };

  const { moves, kept, already, secretRouted, arm64Routed } = selectRoutingMoves({
    audited: a.workflows,
    workflows: src.workflows,
    repositoryPrivate: src.repository.private,
    history: src.history,
    defaultTokenPermission: tokenPermission,
    overrides: src.config.overrides,
    routingEnabled: src.config.routingEnabled,
    rank: (job) => {
      const ranked = routingCandidates({ jobId: job.jobId, labels: [job.label], minutesPerMonth: job.minutesPerMonth, peakConcurrency: peakConcurrency(src.history, job.name), measuredDurationFactors: {}, config, repositoryPrivate: src.repository.private, overrides: src.config.overrides, fixedCosts: src.config.fixedCosts });
      const best = ranked.candidates[0];
      return best ? { stayCents: ranked.current.centsPerMonth, cheapest: { provider: best.provider, label: best.label, cents: best.centsPerMonth + best.monthlyFixedCents } } : null;
    },
  });

  const plan = planRoutingPullRequest({
    repository: src.repository,
    workflows: src.workflows,
    moves,
    kept,
    macosPeakConcurrency: peakConcurrencyOf(src.history, moves.filter((m) => m.os === "macos").map((m) => m.name)),
    historyDays: src.history ? src.history.days : null,
  });
  if (!src.history) assumptions.push("no run history read, so the speed-up is not measured, minutes are estimated from defaults, and the repository is treated as private; pass --repo to read it");
  if (arm64Routed) assumptions.push("jobs on GitHub's arm64 runners read BUILDHOUND_LINUX_ARM64 and run only on arm64 machines, an arm64 Linux host or a Mac, never an x86-64 host; the pull request body names each");
  if (secretRouted) assumptions.push("jobs that can reach secrets read BUILDHOUND_MACOS_TRUSTED or BUILDHOUND_LINUX_TRUSTED, which only machines a person marked Trusted serve; until one is connected they run on GitHub-hosted");
  if (secretRouted && !tokenPermission) assumptions.push("the repository's default GITHUB_TOKEN permission could not be read, so a job without a permissions block counts as able to write and goes to Trusted machines only");
  if (moves.length) assumptions.push(`each routed job runs the same on your machine as on GitHub-hosted; the pull request body names this under Assumption`);

  let outcome: Awaited<ReturnType<typeof openFixPullRequest>> | null = null;
  if (apply && target && plan.files.length) {
    try {
      outcome = await openFixPullRequest(target.gh, target.owner, target.name, target.base, { branch: plan.branch, title: plan.title, body: plan.body, commitMessage: plan.commitMessage, files: plan.files, trailer: plan.trailer, noun: "routing change" });
    } catch (e) {
      throw writeError(e, src.repo, applyCommand(path, opts, { yes: true }), [], `npx buildhound route --apply --repo ${src.repo} --yes`);
    }
  }

  const owner = src.repo.split("/")[0]!;
  const unknown = src.repo === "local/repo";
  const next = apply
    ? `buildhound runner status --org ${owner}`
    : plan.files.length
      ? applyCommand(path, opts, { yes: true, ...(unknown ? { repo: UNKNOWN_REPO } : {}) })
      : unknown ? `buildhound route ${path} --repo <owner/name>` : `buildhound runner status --org ${owner}`;

  const s = plan.saving;
  return {
    repo: src.repo,
    mode: apply ? "applied" : opts.dryRun ? "dry_run" : "plan",
    base: target ? { branch: target.base.branch, sha: target.base.sha } : null,
    pull_request: plan.files.length
      ? {
          branch: plan.branch,
          title: plan.title,
          status: outcome?.status ?? "planned",
          url: outcome?.url ?? null,
          number: outcome?.number ?? null,
          ...(outcome?.note ? { note: outcome.note } : {}),
          files: plan.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
          body: plan.body,
          diff: plan.files.map((f) => f.diff).join(""),
        }
      : null,
    routed: plan.routed.map(routedJson),
    not_routed: kept.map((k) => ({ workflow: k.workflow, job: k.jobId, label: k.label, reason: k.reason })),
    already_routed: already,
    upgrades: plan.upgrades,
    saving: {
      public_repository: s.publicRepository,
      hosted_cents_per_month: s.hostedCentsPerMonth,
      minutes_per_month: s.minutesPerMonth,
      machine_fee_cents: s.machineFeeCents,
      macos_peak_concurrency: s.macosPeakConcurrency,
      machines_needed: s.machinesNeeded,
      monthly_saving_cents: s.monthlySavingCents,
      claimed_cents_per_month: s.claimedCentsPerMonth,
    },
    assumptions,
    next,
  };
}

const STATUS_WORD: Record<FixStatus, string> = { planned: "Would open", created: "Opened", updated: "Updated", unchanged: "Already open", skipped: "Skipped" };
const shortPath = (p: string): string => p.replace(/^\.github\/workflows\//, "");

/** The plan or the result for a person: the pull request, each job it routes, what stays and why, and the saving. */
export function prettyRouteApply(r: RouteApplyResult, withNext = true): string {
  const lines: string[] = [];
  const p = r.pull_request;
  if (!p) lines.push(`Nothing to route on ${r.repo}: every job is already routed, or none can run on a connected machine.`);
  else {
    const head = `${STATUS_WORD[p.status]}: ${p.title}${p.url ? `  ${p.url}` : ""}`;
    lines.push(p.status === "planned" ? `${head}${r.mode === "dry_run" ? " (dry run, nothing written)" : ""}` : p.status === "skipped" ? `- ${head}` : done(head));
    lines.push(`  ${p.branch}`);
    for (const f of p.files) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
    if (p.note) lines.push(`  ${p.note}`);
  }
  if (r.routed.length) {
    lines.push("", color.bold("Routed"));
    for (const j of r.routed) {
      const speed = j.speed?.speed_up ? `${j.speed.speed_up.toFixed(2)}x faster` : "speed-up not measured yet";
      const trusted = j.secrets.length ? ", Trusted machines only" : "";
      lines.push(`  ${shortPath(j.workflow)}  ${j.job}  ${j.today ? `vars.${j.variable.replace(/_TRUSTED$/, "")}` : j.from} to vars.${j.variable}${trusted}, ${money(j.cents_per_month)} a month on GitHub-hosted, ${speed}`);
    }
  }
  for (const u of r.upgrades) for (const j of u.jobs) lines.push(`  ${shortPath(u.workflow)}  ${j.job}  ${j.to ? "expression upgraded so forks stay on GitHub-hosted" : "hand-written expression left for a person to check"}`);
  if (r.not_routed.length) {
    lines.push("", "Not routed");
    for (const k of r.not_routed) lines.push(`  ${shortPath(k.workflow)}  ${k.job}  ${k.reason}`);
  }
  if (r.routed.length) {
    const s = r.saving;
    lines.push("", s.public_repository
      ? "Public repository: GitHub-hosted is free here, so no saving is claimed; this routes for speed."
      : s.monthly_saving_cents > 0
        ? `Saves about ${money(s.monthly_saving_cents)} a month: ${money(s.hosted_cents_per_month)} on GitHub-hosted less Team at ${money(s.machine_fee_cents)} for ${count(s.machines_needed, "machine")}.`
        : `${money(s.hosted_cents_per_month)} a month on GitHub-hosted against Team at ${money(s.machine_fee_cents)} for ${count(s.machines_needed, "machine")}: it adds speed, not savings.`);
  }
  if (r.assumptions.length) lines.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  if (withNext) lines.push("", nextLine(r.next));
  return lines.join("\n");
}
