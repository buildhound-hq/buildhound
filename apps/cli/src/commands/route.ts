import { Command } from "commander";
import { DEFAULT_RULE_CONFIG, payback } from "@buildhound/core";
import type { RuleConfig } from "@buildhound/core";
import { EXIT, Provider } from "@buildhound/shared";
import { audit, resolveSource } from "../lib/audit";
import { peakConcurrency, routingCandidates } from "../lib/routing";
import type { XcodeCloudComparison } from "../lib/routing";
import { CliError, emit } from "../output";
import { parseDays } from "./scan";

const TEAM_MACHINE_FEE_CENTS = 2000;
const MAC_MINI_CENTS = 89900;

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
  action: "stay" | "move";
  xcode_cloud: { price_per_minute: number; cents_per_month: number; tier: { hours: number; usd: number } | null; source: string; verified_at: string; note: string } | null;
  payback: { machine_fee_cents: number; hardware_cents: number; peak_concurrency: number; machines_needed: number; monthly_saving_cents: number; payback_months: number | null };
}

export interface RouteResult {
  repo: string;
  history_days: number | null;
  threshold_cents_per_month: number;
  min_saving_percent: number;
  providers: string[];
  jobs: RouteJob[];
  skipped: Array<{ workflow: string; job: string; cents_per_month: number; reason: string }>;
  assumptions: string[];
  next: string;
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

export async function runRoute(path: string, opts: RouteOptions): Promise<RouteResult> {
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
  assumptions.push(`payback uses the Team fee of ${TEAM_MACHINE_FEE_CENTS} cents a machine a month and a ${MAC_MINI_CENTS} cent Mac mini; two macOS jobs at once per machine`);
  if (!src.config.routingEnabled) assumptions.push("routing is disabled in buildhound.toml; candidates are shown but nothing is recommended");

  for (const w of a.workflows) {
    for (const job of w.model.jobs) {
      const entries = w.estimate.jobs.filter((j) => j.jobId === job.id);
      const labelSets = job.matrix && job.runsOn.length > 1 ? job.runsOn.map((l) => [l]) : [job.runsOn];
      labelSets.forEach((labels, idx) => {
        const est = entries[idx];
        if (!est) return;
        const name = labelSets.length > 1 ? `${job.id} [${labels.join(",")}]` : job.id;
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
        const move = Boolean(best) && src.config.routingEnabled && best!.label !== r.current.label && best!.saving_cents >= (currentCents * routing.minSavingPercent) / 100;
        const pb = payback({ hostedCentsPerMonth: currentCents, machineFeeCents: TEAM_MACHINE_FEE_CENTS, hardwareCents: MAC_MINI_CENTS, peakConcurrency: peak, capacityPerMachine: 2 });
        jobs.push({
          workflow: w.path,
          job: name,
          current: { provider: r.current.provider, label: r.current.label, os: r.current.os, vcpu: r.current.vcpu, price_per_minute: r.current.pricePerMinute, rate_confidence: r.current.rateConfidence, minutes_per_month: r.current.minutesPerMonth, cents_per_month: currentCents, basis: est.basis },
          candidates,
          recommended: move ? best!.label : r.current.label,
          action: move ? "move" : "stay",
          xcode_cloud: xcode(r.xcodeCloud),
          payback: { machine_fee_cents: TEAM_MACHINE_FEE_CENTS, hardware_cents: MAC_MINI_CENTS, peak_concurrency: peak, machines_needed: pb.machinesNeeded, monthly_saving_cents: pb.monthlySavingCents, payback_months: pb.paybackMonths },
        });
      });
    }
  }
  jobs.sort((x, y) => y.current.cents_per_month - x.current.cents_per_month);
  const topProvider = jobs.find((j) => j.action === "move")?.candidates[0]?.provider;
  return {
    repo: src.repo,
    history_days: src.history ? src.history.days : null,
    threshold_cents_per_month: routing.minJobCentsPerMonth,
    min_saving_percent: routing.minSavingPercent,
    providers: routing.providers,
    jobs,
    skipped,
    assumptions,
    next: opts.repo ? `buildhound rates${topProvider ? ` --provider ${topProvider}` : ""}` : `buildhound route ${path} --repo ${src.repo === "local/repo" ? "<owner/name>" : src.repo} --token $(gh auth token)`,
  };
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function prettyRoute(r: RouteResult): string {
  const lines = [`${r.repo}: ${r.jobs.length} job${r.jobs.length === 1 ? "" : "s"} over ${usd(r.threshold_cents_per_month)} a month${r.history_days ? ` (last ${r.history_days} days of runs)` : " (default minutes, no run history)"}`];
  for (const j of r.jobs) {
    lines.push("", `${j.workflow} / ${j.job}: ${j.current.label} ${usd(j.current.cents_per_month)} a month (${j.current.minutes_per_month} minutes), recommended: ${j.recommended}${j.action === "stay" ? " (stay)" : ""}`);
    const rows = j.candidates.map((c) => [c.label, c.provider, `$${c.price_per_minute.toFixed(4)}/min`, `x${c.duration_factor.toFixed(2)}`, usd(c.cents_per_month), c.monthly_fixed_cents ? `+${usd(c.monthly_fixed_cents)} fixed` : "", usd(c.saving_cents), c.rate_confidence, c.installed ? "installed" : "", c.referral_agreement ? "referral" : ""]);
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
    for (const row of rows) lines.push("  " + row.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
    if (j.xcode_cloud) lines.push(`  Xcode Cloud comparison: ${usd(j.xcode_cloud.cents_per_month)} a month${j.xcode_cloud.tier ? ` (${j.xcode_cloud.tier.hours} hour tier, $${j.xcode_cloud.tier.usd})` : ""}; ${j.xcode_cloud.note}`);
    lines.push(`  Connected machine payback: ${j.payback.machines_needed} machine${j.payback.machines_needed === 1 ? "" : "s"} for peak concurrency ${j.payback.peak_concurrency}, saves ${usd(j.payback.monthly_saving_cents)} a month${j.payback.payback_months ? `, pays for itself in month ${j.payback.payback_months}` : ", does not pay back at this volume"}`);
  }
  if (r.skipped.length) lines.push("", `Skipped ${r.skipped.length} job${r.skipped.length === 1 ? "" : "s"} under the threshold or free: ${r.skipped.map((s) => `${s.job} (${usd(s.cents_per_month)})`).join(", ")}`);
  if (r.assumptions.length) lines.push("", "Assumptions:", ...r.assumptions.map((a) => `  - ${a}`));
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function routeCommand(): Command {
  return new Command("route")
    .description("Runner candidates for every job over the spend threshold, ranked by computed cost, with payback for a connected machine")
    .argument("[path]", "directory containing .github/workflows", ".")
    .option("--repo <owner/name>", "use observed minutes from the last --days of runs")
    .option("--token <token>", "GitHub token for --repo; else GITHUB_TOKEN, else `gh auth token`")
    .option("--providers <names>", "comma-separated providers to consider, for example blacksmith,ubicloud")
    .option("--days <n>", "days of history to fetch with --repo", "30")
    .option("--json", "JSON output")
    .action(async (path: string, opts: RouteOptions) => {
      emit(await runRoute(path, opts), opts, prettyRoute);
    });
}
