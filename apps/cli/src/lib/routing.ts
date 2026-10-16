import * as core from "@buildhound/core";
import { classify, GITHUB_RATES, VENDOR_TABLES, vendorRate, XCODE_CLOUD } from "@buildhound/core";
import type { History, Provider, RateConfidence, RateOverrides, RuleConfig } from "@buildhound/core";
import type { FixedCost } from "./config";

export interface RoutingInput {
  jobId: string;
  labels: string[];
  minutesPerMonth: number;
  peakConcurrency: number;
  /** Observed duration ratio per provider. Vendor claims never go here. */
  measuredDurationFactors: Record<string, number>;
  config: RuleConfig;
  repositoryPrivate: boolean;
  /** Extra inputs the CLI knows about; the core implementation may ignore them. */
  overrides?: RateOverrides;
  fixedCosts?: Record<string, FixedCost>;
}

export interface RoutingCandidate {
  provider: string;
  label: string;
  pricePerMinute: number;
  rateConfidence: RateConfidence;
  durationFactor: number;
  centsPerMonth: number;
  monthlyFixedCents: number;
  savingCents: number;
  installed: boolean;
  referralAgreement: boolean;
}

export interface RoutingCurrent {
  provider: string;
  label: string;
  os: string;
  arch: string;
  vcpu: number | null;
  pricePerMinute: number;
  rateConfidence: RateConfidence;
  minutesPerMonth: number;
  centsPerMonth: number;
}

export interface XcodeCloudComparison {
  pricePerMinute: number;
  centsPerMonth: number;
  tier: { hours: number; usd: number } | null;
  source: string;
  verifiedAt: string;
  note: string;
}

export interface RoutingResult {
  current: RoutingCurrent;
  candidates: RoutingCandidate[];
  xcodeCloud?: XcodeCloudComparison;
}

const BUILDHOUND_MACHINE_FEE_CENTS = 2400;

/** Candidate labels per provider at a given size; a best effort used only until core ships routingCandidates. */
function labelFor(provider: Provider, os: string, arch: string, vcpu: number): string | null {
  const arm = arch === "arm64";
  switch (provider) {
    case "github": {
      const rate = GITHUB_RATES.filter((r) => r.os === os && r.labels.length && (os !== "linux" || (r.runnerClass.endsWith("_arm") === arm))).sort((a, b) => a.vcpu - b.vcpu).find((r) => r.vcpu >= vcpu);
      return rate?.labels[0] ?? null;
    }
    case "blacksmith":
      return os === "macos" ? `blacksmith-${vcpu}vcpu-macos` : os === "windows" ? `blacksmith-${vcpu}vcpu-windows-2022` : `blacksmith-${vcpu}vcpu-ubuntu-2404${arm ? "-arm" : ""}`;
    case "depot":
      return os === "macos" ? "depot-macos-latest" : os === "windows" ? `depot-windows-2022-${vcpu}` : `depot-ubuntu-24.04${arm ? "-arm" : ""}-${vcpu}`;
    case "warpbuild":
      return os === "macos" ? `warp-macos-latest-arm64-${vcpu}x` : os === "windows" ? `warp-windows-latest-x64-${vcpu}x` : `warp-ubuntu-latest-${arm ? "arm64" : "x64"}-${vcpu}x`;
    case "ubicloud":
      return os === "linux" ? `ubicloud-standard-${vcpu}${arm ? "-arm" : ""}` : null;
    case "jog":
      return os === "linux" && !arm ? (vcpu > 2 ? `jog-${vcpu}` : "jog") : null;
    case "buildhound":
      return os === "macos" ? "buildhound-macos" : os === "linux" ? "buildhound-linux" : null;
    default:
      return null;
  }
}

function fallbackCandidates(i: RoutingInput): RoutingResult {
  const overrides = i.overrides ?? {};
  const c = classify(i.labels, overrides);
  const currentPrice = !i.repositoryPrivate && c.provider === "github" ? 0 : c.pricePerMinute;
  const current: RoutingCurrent = {
    provider: c.provider,
    label: i.labels[0] ?? c.runnerClass,
    os: c.os,
    arch: c.arch,
    vcpu: c.vcpu,
    pricePerMinute: currentPrice,
    rateConfidence: c.rateConfidence,
    minutesPerMonth: i.minutesPerMonth,
    centsPerMonth: Math.round(i.minutesPerMonth * currentPrice * 100),
  };
  const os = c.os === "unknown" ? "linux" : c.os;
  const vcpu = c.vcpu ?? 2;
  const stay: RoutingCandidate = { provider: c.provider, label: current.label, pricePerMinute: currentPrice, rateConfidence: c.rateConfidence, durationFactor: 1, centsPerMonth: current.centsPerMonth, monthlyFixedCents: 0, savingCents: 0, installed: true, referralAgreement: false };
  const candidates: RoutingCandidate[] = [stay];
  for (const provider of i.config.routing.providers as Provider[]) {
    if (provider === c.provider) continue;
    // Vendors sell fixed sizes, so the label names the size that was priced (the nearest at or above the job's vCPU).
    const rate = provider === "github" ? undefined : vendorRate(provider, os, c.arch, vcpu);
    const label = labelFor(provider, os, c.arch, rate?.vcpu ?? vcpu);
    if (!label) continue;
    let price: number | undefined;
    let confidence: RateConfidence = "high";
    const override = overrides[`${provider}:${label}`] ?? overrides[provider];
    if (override !== undefined) price = override;
    else if (provider === "github") {
      const gh = GITHUB_RATES.find((r) => r.labels.includes(label));
      if (!gh) continue;
      price = i.repositoryPrivate ? gh.pricePerMinute : 0;
    } else {
      if (!rate) continue;
      price = rate.pricePerMinute;
      confidence = provider === "runs_on" ? "low" : rate.derived ? "medium" : "high";
    }
    const durationFactor = i.measuredDurationFactors[provider] ?? 1;
    const centsPerMonth = Math.round(i.minutesPerMonth * durationFactor * price * 100);
    const machines = Math.max(1, Math.ceil(i.peakConcurrency / 2));
    const monthlyFixedCents = i.fixedCosts?.[provider]?.monthlyFixedCents ?? (provider === "buildhound" ? BUILDHOUND_MACHINE_FEE_CENTS * machines : 0);
    candidates.push({
      provider,
      label,
      pricePerMinute: price,
      rateConfidence: confidence,
      durationFactor,
      centsPerMonth,
      monthlyFixedCents,
      savingCents: current.centsPerMonth - centsPerMonth - monthlyFixedCents,
      installed: i.config.routing.installed.includes(provider),
      referralAgreement: false,
    });
  }
  candidates.sort((a, b) => a.centsPerMonth + a.monthlyFixedCents - (b.centsPerMonth + b.monthlyFixedCents) || (a === stay ? -1 : b === stay ? 1 : 0));
  const result: RoutingResult = { current, candidates };
  if (c.os === "macos") result.xcodeCloud = xcodeCloudComparison(i.minutesPerMonth);
  return result;
}

/** Xcode Cloud is not a GitHub label; it is shown as a comparison for macOS jobs only (COST_MODEL.md). */
export function xcodeCloudComparison(minutesPerMonth: number): XcodeCloudComparison {
  const hours = minutesPerMonth / 60;
  const tier = XCODE_CLOUD.tiers.find((t) => t.hours >= hours) ?? null;
  return {
    pricePerMinute: XCODE_CLOUD.pricePerMinute,
    centsPerMonth: Math.round(minutesPerMonth * XCODE_CLOUD.pricePerMinute * 100),
    tier: tier ? { hours: tier.hours, usd: tier.usd } : null,
    source: XCODE_CLOUD.source,
    verifiedAt: XCODE_CLOUD.verifiedAt,
    note: "Xcode Cloud is not a GitHub Actions runner and does not allow customer hardware; shown for comparison only",
  };
}

/**
 * Candidates for one job, ranked by computed cost, "stay" included (CLAUDE.md rule 15).
 * Uses core's routingCandidates when it exports one, otherwise the local computation above.
 */
export function routingCandidates(i: RoutingInput): RoutingResult {
  const fn = (core as unknown as Record<string, unknown>).routingCandidates;
  if (typeof fn === "function") {
    const r = (fn as (i: RoutingInput) => RoutingResult)(i);
    if (r && Array.isArray(r.candidates) && r.current) return r;
  }
  return fallbackCandidates(i);
}

/** Highest number of observed runs of one job overlapping in time, from history. 1 without history. */
export function peakConcurrency(history: History | null, jobName: string): number {
  if (!history) return 1;
  const events: Array<[number, number]> = [];
  for (const j of history.jobs) {
    if (!(j.name === jobName || j.name.startsWith(jobName + " (")) || !j.startedAt) continue;
    const end = j.completedAt ?? j.startedAt;
    events.push([j.startedAt.getTime(), 1], [end.getTime(), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, peak = 0;
  for (const [, d] of events) {
    open += d;
    peak = Math.max(peak, open);
  }
  return Math.max(1, peak);
}

/** Every provider the fallback knows how to label; used to validate --providers. */
export const KNOWN_PROVIDERS: readonly string[] = ["github", ...VENDOR_TABLES.map((t) => t.provider)];
