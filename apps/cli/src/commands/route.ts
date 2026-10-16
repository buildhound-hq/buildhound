import { Command } from "commander";
import { applyEdit, DEFAULT_HARDWARE_CENTS, DEFAULT_RULE_CONFIG, parseRoutingExpression, payback, routingExpression, secretBearingJobs, TRUSTED_EVENTS, upgradeRoutingExpressions } from "@buildhound/core";
import type { RoutingUpgrade, RuleConfig } from "@buildhound/core";
import { EXIT, Provider, trustedTwin, variableNameForLabel } from "@buildhound/shared";
import { confirm } from "../lib/confirm";
import { audit, resolveSource } from "../lib/audit";
import type { Rest } from "../lib/fix-pr";
import { defaultTokenPermission, peakConcurrency, routingCandidates, SECRETS_TRUSTED, TRUSTED_UNTIL } from "../lib/routing";
import type { XcodeCloudComparison } from "../lib/routing";
import { CliError, emit, wantsJson } from "../output";
import { prettyRouteApply, runRouteApply } from "./route-apply";
import type { RouteApplyOptions } from "./route-apply";
import { color, count, money, needed, next, table } from "../lib/style";
import { parseDays } from "./scan";

// Team billed monthly: the saving never uses the cheaper annual price, so none is overstated (BILLING.md).
const TEAM_MACHINE_FEE_CENTS = 2400;

export interface RouteOptions {
  repo?: string | undefined;
  token?: string | undefined;
  providers?: string | undefined;
  days?: string | number | undefined;
  json?: boolean | undefined;
}

export interface RouteCandidate {
  provider: string;
  label: string;
  price_per_minute: number;
  rate_confidence: string;
  duration_factor: number;
  duration_source: string;
  cents_per_month: number;
  monthly_fixed_cents: number;
  saving_cents: number;
  installed: boolean;
  referral_agreement: boolean;
}

export interface RouteJob {
  workflow: string;
  job: string;
  current: { provider: string; label: string; os: string; vcpu: number | null; price_per_minute: number; rate_confidence: string; minutes_per_month: number; cents_per_month: number; basis: "history" | "default" };
  candidates: RouteCandidate[];
  recommended: string;
  /** The value to write as the job's runs-on: for a connected machine, the routing expression for this repository's visibility. */
  runs_on: string;
  action: "stay" | "move";
  /**
   * Why the job is secret-bearing (SECURITY.md, Trusted machines): secrets other than GITHUB_TOKEN, inherited secrets,
   * an environment, `id-token: write` or a write token. Empty when it is not. Such a job is never given the plain
   * variable: when a connected machine ranks first it gets the family's trusted one (CLAUDE.md rule 19, ADR-023).
   */
  secrets: string[];
  /** True when `runs_on` reads a trusted variable (`BUILDHOUND_MACOS_TRUSTED`), which only machines a person marked Trusted serve. */
  trusted: boolean;
  xcode_cloud: { price_per_minute: number; cents_per_month: number; tier: { hours: number; usd: number } | null; source: string; verified_at: string; note: string } | null;
  /**
   * Machines the team already has for this job: how many its peak needs and the monthly saving after the Team fee
   * (zero or below: no saving). No hardware is priced (2026-10-15); `hardware_cents` and `payback_months` are
   * deprecated, kept for agents that read them.
   */
  payback: { machine_fee_cents: number; hardware_cents: number; peak_concurrency: number; machines_needed: number; monthly_saving_cents: number; payback_months: number | null };
}

export interface RouteUpgrade {
  workflow: string;
  /** `to` is null when the job reads a Buildhound variable in a form Buildhound did not write: a person checks it. */
  jobs: Array<{ job: string; from: string; to: string | null }>;
  diff: string | null;
}

export interface RouteResult {
  repo: string;
  history_days: number | null;
  threshold_cents_per_month: number;
  min_saving_percent: number;
  providers: string[];
  jobs: RouteJob[];
  skipped: Array<{ workflow: string; job: string; cents_per_month: number; reason: string }>;
  /** Routed jobs whose expression lets a job a stranger triggers reach the machine, with the diff to the trusted-events form. */
  upgrades: RouteUpgrade[];
  assumptions: string[];
  next: string;
}

/** Every routed job on a public repository that is not on the trusted-events form, with the comment-preserving diff that upgrades it. */
export function routingUpgrades(workflows: ReadonlyArray<{ path: string; content: string }>, publicRepo: boolean): RouteUpgrade[] {
  const out: RouteUpgrade[] = [];
  for (const w of workflows) {
    let found: RoutingUpgrade[] = [];
    let diff: string;
    try {
      diff = applyEdit(w.path, w.content, (doc) => {
        found = upgradeRoutingExpressions(doc, publicRepo);
      }).diff;
    } catch {
      continue;
    }
    if (!found.length) continue;
    out.push({ workflow: w.path, jobs: found.map((u) => ({ job: u.jobId, from: u.from, to: u.to })), diff: found.some((u) => u.to !== null) ? diff : null });
  }
  return out;
}

function xcode(x: XcodeCloudComparison | undefined): RouteJob["xcode_cloud"] {
  if (!x) return null;
  return { price_per_minute: x.pricePerMinute, cents_per_month: x.centsPerMonth, tier: x.tier, source: x.source, verified_at: x.verifiedAt, note: x.note };
}

export function parseProviders(v: string | undefined, next: string): string[] | null {
  if (!v) return null;
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!Provider.options.includes(p as Provider)) throw new CliError("UNKNOWN_PROVIDER", `unknown provider "${p}"; known providers are ${Provider.options.join(", ")}`, next, EXIT.usage);
  }
  return list;
}

export async function runRoute(path: string, opts: RouteOptions, deps: { github?: Rest } = {}): Promise<RouteResult> {
  const next = `buildhound route ${path}${opts.repo ? ` --repo ${opts.repo}` : ""}`;
  const days = parseDays(opts.days, next);
  const only = parseProviders(opts.providers, next);
  const src = await resolveSource({ path, repo: opts.repo, token: opts.token, days, next });
  const a = await audit(src, []);
  const routing: RuleConfig["routing"] = { ...DEFAULT_RULE_CONFIG.routing, ...src.config.rules.routing };
  if (only) routing.providers = only;
  const config: RuleConfig = { ...DEFAULT_RULE_CONFIG, ...src.config.rules, routing };
  const jobs: RouteJob[] = [];
  const skipped: RouteResult["skipped"] = [];
  const assumptions = [...a.assumptions];
  if (!src.history) assumptions.push("duration factor 1.0 for every candidate: nothing has been measured yet; vendor claims are never used");
  assumptions.push(`the saving on machines you already have uses the Team fee of ${TEAM_MACHINE_FEE_CENTS} cents a machine a month, with nothing to buy; two macOS jobs at once per machine`);
  if (!src.config.routingEnabled) assumptions.push("routing is disabled in buildhound.toml; candidates are shown but nothing is recommended");
  const publicRepo = !src.repository.private;
  const tokenPermission = await defaultTokenPermission(src, opts.token, deps.github);
  const secretsByWorkflow = new Map(src.workflows.map((w) => [w.path, secretBearingJobs(w.content, tokenPermission)]));
  if (!src.history) assumptions.push("repository visibility not read from GitHub, so treated as private: routing expressions get the short form and are not checked against the public repository rules; pass --repo to check them");
  else if (publicRepo) assumptions.push(`public repository: a connected machine takes only ${TRUSTED_EVENTS.join(", ")} and same-repository pull_request jobs; everything else stays on GitHub-hosted`);

  for (const w of a.workflows) {
    for (const job of w.model.jobs) {
      const entries = w.estimate.jobs.filter((j) => j.jobId === job.id);
      const labelSets = job.matrix && job.runsOn.length > 1 ? job.runsOn.map((l) => [l]) : [job.runsOn];
      labelSets.forEach((labels, idx) => {
        const est = entries[idx];
        if (!est) return;
        const name = labelSets.length > 1 ? `${job.id} [${labels.join(",")}]` : job.id;
        const routed = labels.length === 1 ? parseRoutingExpression(labels[0]!) : null;
        if (routed) {
          const secretsHere = secretsByWorkflow.get(w.path)?.get(job.id) ?? [];
          const toTrusted = secretsHere.length > 0 && !routed.variable.endsWith("_TRUSTED");
          skipped.push({
            workflow: w.path,
            job: name,
            cents_per_month: est.centsPerMonth,
            reason: toTrusted
              ? `routed by vars.${routed.variable}, but it ${SECRETS_TRUSTED} (${secretsHere.join("; ")}); route --apply moves it to vars.${routed.variable}_TRUSTED`
              : `already routed to connected machines by vars.${routed.variable}, falling back to ${routed.hostedDefault}`,
          });
          return;
        }
        if (est.centsPerMonth < routing.minJobCentsPerMonth) {
          skipped.push({ workflow: w.path, job: name, cents_per_month: est.centsPerMonth, reason: `under the ${routing.minJobCentsPerMonth} cents a month threshold` });
          return;
        }
        if (!src.repository.private && est.provider === "github") {
          skipped.push({ workflow: w.path, job: name, cents_per_month: est.centsPerMonth, reason: "public repository on GitHub-hosted runners is free; a vendor would charge" });
          return;
        }
        const peak = peakConcurrency(src.history, job.name ?? job.id);
        const r = routingCandidates({ jobId: job.id, labels, minutesPerMonth: est.minutesPerMonth, peakConcurrency: peak, measuredDurationFactors: {}, config, repositoryPrivate: src.repository.private, overrides: src.config.overrides, fixedCosts: src.config.fixedCosts });
        const candidates: RouteCandidate[] = r.candidates.map((c) => ({
          provider: c.provider,
          label: c.label,
          price_per_minute: c.pricePerMinute,
          rate_confidence: c.rateConfidence,
          duration_factor: c.durationFactor,
          duration_source: c.durationFactor === 1 ? "not measured, assumed 1.0" : "measured",
          cents_per_month: c.centsPerMonth,
          monthly_fixed_cents: c.monthlyFixedCents,
          saving_cents: c.savingCents,
          installed: c.installed,
          referral_agreement: c.referralAgreement,
        }));
        const best = candidates[0];
        const currentCents = r.current.centsPerMonth;
        const secrets = secretsByWorkflow.get(w.path)?.get(job.id) ?? [];
        const trustedOnly = secrets.length > 0 && best?.provider === "buildhound";
        const move = Boolean(best) && src.config.routingEnabled && best!.label !== r.current.label && best!.saving_cents >= (currentCents * routing.minSavingPercent) / 100;
        // A connected machine for a job that can reach secrets is the family's trusted twin, served only by Trusted machines.
        const target = move && trustedOnly ? trustedTwin(best!.label) : best?.label;
        const pb = payback({ hostedCentsPerMonth: currentCents, machineFeeCents: TEAM_MACHINE_FEE_CENTS, peakConcurrency: peak, capacityPerMachine: 2 });
        jobs.push({
          workflow: w.path,
          job: name,
          current: { provider: r.current.provider, label: r.current.label, os: r.current.os, vcpu: r.current.vcpu, price_per_minute: r.current.pricePerMinute, rate_confidence: r.current.rateConfidence, minutes_per_month: r.current.minutesPerMonth, cents_per_month: currentCents, basis: est.basis },
          candidates,
          recommended: move ? best!.label : r.current.label,
          runs_on: !move ? r.current.label : best!.provider === "buildhound" ? routingExpression(variableNameForLabel(target!), r.current.label, publicRepo) : best!.label,
          action: move ? "move" : "stay",
          secrets,
          trusted: move && trustedOnly,
          xcode_cloud: xcode(r.xcodeCloud),
          payback: { machine_fee_cents: TEAM_MACHINE_FEE_CENTS, hardware_cents: DEFAULT_HARDWARE_CENTS, peak_concurrency: peak, machines_needed: pb.machinesNeeded, monthly_saving_cents: pb.monthlySavingCents, payback_months: pb.paybackMonths },
        });
      });
    }
  }
  jobs.sort((x, y) => y.current.cents_per_month - x.current.cents_per_month);
  if (jobs.some((j) => j.trusted)) {
    assumptions.push(`a job that ${SECRETS_TRUSTED} reads BUILDHOUND_MACOS_TRUSTED or BUILDHOUND_LINUX_TRUSTED; ${TRUSTED_UNTIL}${tokenPermission ? "" : ". The repository's default GITHUB_TOKEN permission could not be read, so a job without a permissions block counts as able to write"}`);
  }
  const topProvider = jobs.find((j) => j.action === "move")?.candidates[0]?.provider;
  return {
    repo: src.repo,
    history_days: src.history ? src.history.days : null,
    threshold_cents_per_month: routing.minJobCentsPerMonth,
    min_saving_percent: routing.minSavingPercent,
    providers: routing.providers,
    jobs,
    skipped,
    upgrades: routingUpgrades(src.workflows, publicRepo),
    assumptions,
    next: opts.repo ? `buildhound rates${topProvider ? ` --provider ${topProvider}` : ""}` : `buildhound route ${path} --repo ${src.repo === "local/repo" ? "<owner/name>" : src.repo} --token $(gh auth token)`,
  };
}

const shortPath = (p: string): string => p.replace(/^\.github\/workflows\//, "");

/** One job on machines the team already has, after the Team fee; nothing is bought, so no payback period (2026-10-15). */
export function ownedRouteLine(p: RouteJob["payback"]): string {
  const need = `On machines you already have: ${count(p.machines_needed, "machine")} for ${count(p.peak_concurrency, "job")} at once`;
  const plan = `Team at $${p.machine_fee_cents / 100} a machine a month`;
  return p.monthly_saving_cents > 0 ? `${need}, saves ${money(p.monthly_saving_cents)} a month after ${plan}.` : `${need}; ${plan} costs more than this job, so it adds speed, not savings.`;
}

export function prettyRoute(r: RouteResult): string {
  const source = r.history_days ? `from the last ${r.history_days} days of runs` : "from default minutes, no run history";
  const lines = [`${r.jobs.length ? `Showing ${count(r.jobs.length, "job")}` : "No jobs"} over ${money(r.threshold_cents_per_month)} a month for ${r.repo}, ${source}`];
  for (const j of r.jobs) {
    lines.push(
      "",
      color.bold(`${shortPath(j.workflow)}  ${j.job}`),
      `Now ${j.current.label}, ${money(j.current.cents_per_month)} a month for ${j.current.minutes_per_month} minutes. ${j.action === "stay" ? `Recommended: stay on ${j.current.label}` : `Recommended: ${j.recommended}`}`,
    );
    const rows = j.candidates.map((c) => [c.label, c.provider, `$${c.price_per_minute.toFixed(4)}`, `x${c.duration_factor.toFixed(2)}`, money(c.cents_per_month), c.monthly_fixed_cents ? money(c.monthly_fixed_cents) : "", money(c.saving_cents), c.rate_confidence, [c.installed ? "installed" : "", c.referral_agreement ? "referral" : ""].filter(Boolean).join(", ")]);
    if (rows.length) lines.push("", ...table(["LABEL", "PROVIDER", "$/MIN", "TIME", "$/MONTH", "FIXED", "SAVES", "RATE", "NOTE"], rows, { right: [2, 3, 4, 5, 6] }));
    lines.push("");
    if (j.xcode_cloud) lines.push(`Xcode Cloud would cost ${money(j.xcode_cloud.cents_per_month)} a month${j.xcode_cloud.tier ? ` (${j.xcode_cloud.tier.hours} hour tier, $${j.xcode_cloud.tier.usd})` : ""}. ${j.xcode_cloud.note.replace(/\.?$/, ".")}`);
    lines.push(ownedRouteLine(j.payback));
    if (j.trusted) lines.push(`Only Trusted machines take it, since it ${SECRETS_TRUSTED} (${j.secrets.join("; ")}); ${TRUSTED_UNTIL}.`);
  }
  for (const u of r.upgrades) {
    lines.push("", ...needed(`${shortPath(u.workflow)}: routing expressions to upgrade on this public repository`));
    for (const j of u.jobs) lines.push(`  ${j.job}: ${j.to ? "upgrade to the form that keeps forks and events from outside the repository on GitHub-hosted" : "not a form Buildhound wrote; check it keeps forks and events from outside the repository on GitHub-hosted"}`);
    if (u.diff) lines.push("", ...u.diff.trimEnd().split("\n").map((l) => `  ${l}`));
  }
  if (r.skipped.length) lines.push("", `Skipped ${count(r.skipped.length, "job")} under the threshold, free or already routed: ${r.skipped.map((x) => `${x.job} (${money(x.cents_per_month)})`).join(", ")}`);
  if (r.assumptions.length) lines.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function routeCommand(): Command {
  return new Command("route")
    .description("Runner candidates for every job over the spend threshold, ranked by computed cost, with the monthly saving on a machine you already have; --apply opens the routing pull request")
    .argument("[path]", "directory containing .github/workflows", ".")
    .option("--repo <owner/name>", "use observed minutes from the last --days of runs")
    .option("--token <token>", "GitHub token for --repo; else GITHUB_TOKEN, else `gh auth token`")
    .option("--providers <names>", "comma-separated providers to consider, for example blacksmith,ubicloud")
    .option("--days <n>", "days of history to fetch with --repo", "30")
    .option("--apply", "open a pull request that routes each job a connected machine can run, with GitHub-hosted as the fallback; plans only, until --yes")
    .option("--dry-run", "with --apply: print the pull request without writing to GitHub")
    .option("--yes", "with --apply: open the pull request without asking")
    .option("--json", "JSON output")
    .action(async (path: string, opts: RouteApplyOptions & { apply?: boolean }) => {
      if (opts.apply) return routeApply(path, opts);
      const stray = opts.dryRun ? "--dry-run" : opts.yes ? "--yes" : null;
      if (stray) throw new CliError("USAGE", `${stray} only works with --apply`, `buildhound route${path === "." ? "" : ` ${path}`}${opts.repo ? ` --repo ${opts.repo}` : ""} --apply`, EXIT.usage);
      emit(await runRoute(path, opts), opts, prettyRoute);
    });
}

/**
 * `route --apply` (AGENT_FIRST.md rule 2): without --yes and without a terminal it returns the plan with `next` set to
 * the same command with --yes; in a terminal it shows the plan and asks once before opening anything.
 */
async function routeApply(path: string, opts: RouteApplyOptions): Promise<void> {
  const interactive = !opts.yes && !opts.dryRun && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !wantsJson(opts);
  if (!interactive) return emit(await runRouteApply(path, opts), opts, prettyRouteApply);
  const plan = await runRouteApply(path, { ...opts, yes: false });
  if (!plan.pull_request) return emit(plan, opts, prettyRouteApply);
  process.stdout.write(prettyRouteApply(plan, false) + "\n\n");
  await confirm(false, `Open this pull request on ${plan.repo}?`, plan.next.replace(/ --yes$/, ""));
  emit(await runRouteApply(path, { ...opts, yes: true }), opts, prettyRouteApply);
}
