/**
 * Runner routing candidates, shared by R14 and the CLI (RULES.md R14, COST_MODEL.md, ADR-012).
 *
 * Neutrality is not negotiable (CLAUDE.md rule 15): every candidate is priced from the rate tables,
 * "stay where you are" is always present, ranking is by computed cost only, and a referral agreement
 * (none exist in v1) is disclosed on every row and never touches the order. A connected Buildhound
 * machine is one candidate like any vendor: zero per minute plus the flat Team fee per machine.
 */
import { isScalar, isSeq, type Document } from "yaml";
import { classify, type Arch, type Classification, type Os, type Provider, type RateConfidence } from "../cost/classify";
import { GITHUB_RATES, type Rate } from "../cost/rates/github";
import { vendorRate, XCODE_CLOUD } from "../cost/rates/vendors";
import { payback } from "../cost/payback";
import type { RuleConfig } from "./types";

/** Flat fee per connected machine for organisations, in cents (ADR-014, COST_MODEL.md "Payback"). */
export const BUILDHOUND_MACHINE_FEE_CENTS = 2000;

export interface RoutingInput {
  jobId: string;
  labels: string[];
  /** Observed minutes on the current provider, scaled to 30 days. */
  minutesPerMonth: number;
  /** Peak concurrent runs of this job, for the connected-machine capacity check. */
  peakConcurrency: number;
  /** provider -> observed duration ratio against the current provider. Absent means 1.0, never a vendor claim. */
  measuredDurationFactors: Record<string, number>;
  config: RuleConfig["routing"];
  repositoryPrivate: boolean;
}

export interface RoutingCandidate {
  provider: string;
  /** A representative label for that provider at the same OS and nearest vCPU. */
  label: string;
  vcpu: number | null;
  pricePerMinute: number;
  rateConfidence: RateConfidence;
  durationFactor: number;
  durationSource: "measured" | "unchanged";
  centsPerMonth: number;
  /** Account-level cost the switch adds per month. Vendors 0 in v1; a connected machine pays the flat fee per machine needed. */
  monthlyFixedCents: number;
  machinesNeeded: number | null;
  /** Current monthly total minus this candidate's total. Negative when the candidate costs more. */
  savingCents: number;
  /** Staying on the current provider. Present in every result. */
  stay: boolean;
  installed: boolean;
  referralAgreement: false;
}

export interface RoutingCurrent {
  provider: string;
  labels: string[];
  runnerClass: string;
  os: Os;
  arch: Arch;
  vcpu: number | null;
  pricePerMinute: number;
  rateConfidence: RateConfidence;
  minutesPerMonth: number;
  centsPerMonth: number;
  monthlyFixedCents: number;
}

export interface XcodeCloudComparison {
  notARunner: true;
  provider: "xcode_cloud";
  pricePerMinute: number;
  centsPerMonth: number;
  source: string;
  note: string;
}

export interface RoutingResult {
  jobId: string;
  current: RoutingCurrent;
  /** Ranked by monthly total (per-minute cost plus fixed cost) ascending. Includes the stay candidate. */
  candidates: RoutingCandidate[];
  /** macOS jobs only: Apple's hosted CI, shown for comparison because it cannot run GitHub Actions. */
  xcodeCloud?: XcodeCloudComparison;
}

const cents = (minutes: number, factor: number, price: number): number => Math.round(minutes * factor * price * 100);

/** Nearest GitHub-hosted rate at or above the vCPU count for an OS and arch, else the largest. */
function githubRateFor(os: Os, arch: Arch, vcpu: number): Rate | undefined {
  const rows = GITHUB_RATES.filter((r) => r.os === os && (os === "macos" || (arch === "arm64") === /_arm$/.test(r.runnerClass))).sort((a, b) => a.vcpu - b.vcpu);
  return rows.find((r) => r.vcpu >= vcpu) ?? rows.at(-1);
}

/** A label the provider documents for that OS, arch and vCPU count (COST_MODEL.md label patterns). */
export function representativeLabel(provider: Provider, os: Os, arch: Arch, vcpu: number): string | null {
  const arm = arch === "arm64";
  switch (provider) {
    case "github": {
      const rate = githubRateFor(os, arch, vcpu);
      return rate ? (rate.labels[0] ?? rate.runnerClass) : null;
    }
    case "blacksmith":
      if (os === "macos") return `blacksmith-${vcpu}vcpu-macos-latest`;
      if (os === "windows") return `blacksmith-${vcpu}vcpu-windows-2025`;
      return `blacksmith-${vcpu}vcpu-ubuntu-2404${arm ? "-arm" : ""}`;
    case "depot":
      if (os === "macos") return "depot-macos-latest";
      if (os === "windows") return `depot-windows-2025${vcpu > 2 ? `-${vcpu}` : ""}`;
      return `depot-ubuntu-24.04${arm ? "-arm" : ""}${vcpu > 2 ? `-${vcpu}` : ""}`;
    case "warpbuild":
      if (os === "macos") return `warp-macos-latest-arm64-${vcpu}x`;
      if (os === "windows") return `warp-windows-latest-x64-${vcpu}x`;
      return `warp-ubuntu-latest-${arm ? "arm64" : "x64"}-${vcpu}x`;
    case "ubicloud":
      if (os !== "linux") return null;
      return `ubicloud-standard-${vcpu}${arm ? "-arm" : ""}`;
    case "runs_on":
      if (os !== "linux") return null;
      return `runs-on=\${{ github.run_id }}/cpu=${vcpu}`;
    case "buildhound":
      if (os === "windows") return null;
      return os === "macos" ? "buildhound-macos" : "buildhound-linux";
    default:
      return null;
  }
}

function rateFor(provider: Provider, os: Os, arch: Arch, vcpu: number): { pricePerMinute: number; vcpu: number; confidence: RateConfidence } | null {
  if (provider === "github") {
    const r = githubRateFor(os, arch, vcpu);
    return r ? { pricePerMinute: r.pricePerMinute, vcpu: r.vcpu, confidence: "high" } : null;
  }
  if (os === "unknown") return null;
  const r = vendorRate(provider, os, arch, vcpu);
  if (!r) return null;
  return { pricePerMinute: r.pricePerMinute, vcpu: r.vcpu, confidence: provider === "runs_on" ? "low" : r.derived ? "medium" : "high" };
}

function fixedCents(provider: string, hostedCentsPerMonth: number, peakConcurrency: number): { monthlyFixedCents: number; machinesNeeded: number | null } {
  if (provider !== "buildhound") return { monthlyFixedCents: 0, machinesNeeded: null };
  const p = payback({ hostedCentsPerMonth, machineFeeCents: BUILDHOUND_MACHINE_FEE_CENTS, peakConcurrency });
  return { monthlyFixedCents: BUILDHOUND_MACHINE_FEE_CENTS * p.machinesNeeded, machinesNeeded: p.machinesNeeded };
}

/**
 * Compute every routing candidate for one job. Candidates are the providers in `config.providers`
 * at the same OS and the nearest vCPU count; providers with no rate for that OS are omitted.
 * The current provider is always present as the stay candidate even when it is not configured.
 */
export function routingCandidates(input: RoutingInput): RoutingResult {
  const current: Classification = classify(input.labels);
  const minutes = Math.max(0, Math.round(input.minutesPerMonth));
  const targetVcpu = current.vcpu ?? 2;
  const currentPrice = !input.repositoryPrivate && current.provider === "github" ? 0 : current.pricePerMinute;
  const currentCents = cents(minutes, 1, currentPrice);
  const currentFixed = fixedCents(current.provider, currentCents, input.peakConcurrency);
  const currentTotal = currentCents + currentFixed.monthlyFixedCents;
  const isInstalled = (provider: string) => provider === "github" || provider === current.provider || input.config.installed.includes(provider);

  const stay: RoutingCandidate = {
    provider: current.provider,
    label: input.labels.join(", "),
    vcpu: current.vcpu,
    pricePerMinute: currentPrice,
    rateConfidence: current.rateConfidence,
    durationFactor: 1,
    durationSource: "measured",
    centsPerMonth: currentCents,
    monthlyFixedCents: currentFixed.monthlyFixedCents,
    machinesNeeded: currentFixed.machinesNeeded,
    savingCents: 0,
    stay: true,
    installed: true,
    referralAgreement: false,
  };
  const candidates: RoutingCandidate[] = [stay];
  for (const provider of input.config.providers as Provider[]) {
    if (provider === current.provider) continue;
    const label = representativeLabel(provider, current.os, current.arch, targetVcpu);
    const rate = rateFor(provider, current.os, current.arch, targetVcpu);
    if (!label || !rate) continue;
    const measured = input.measuredDurationFactors[provider];
    const factor = measured !== undefined && measured > 0 ? measured : 1;
    const price = !input.repositoryPrivate && provider === "github" ? 0 : rate.pricePerMinute;
    const perMinute = cents(minutes, factor, price);
    const fixed = fixedCents(provider, currentTotal, input.peakConcurrency);
    candidates.push({
      provider,
      label,
      vcpu: rate.vcpu,
      pricePerMinute: price,
      rateConfidence: rate.confidence,
      durationFactor: factor,
      durationSource: measured !== undefined ? "measured" : "unchanged",
      centsPerMonth: perMinute,
      monthlyFixedCents: fixed.monthlyFixedCents,
      machinesNeeded: fixed.machinesNeeded,
      savingCents: currentTotal - (perMinute + fixed.monthlyFixedCents),
      stay: false,
      installed: isInstalled(provider),
      referralAgreement: false,
    });
  }
  // Computed cost only. Array.prototype.sort is stable, so equal totals keep provider order with stay first.
  candidates.sort((a, b) => a.centsPerMonth + a.monthlyFixedCents - (b.centsPerMonth + b.monthlyFixedCents));

  const result: RoutingResult = {
    jobId: input.jobId,
    current: {
      provider: current.provider,
      labels: input.labels,
      runnerClass: current.runnerClass,
      os: current.os,
      arch: current.arch,
      vcpu: current.vcpu,
      pricePerMinute: currentPrice,
      rateConfidence: current.rateConfidence,
      minutesPerMonth: minutes,
      centsPerMonth: currentCents,
      monthlyFixedCents: currentFixed.monthlyFixedCents,
    },
    candidates,
  };
  if (current.os === "macos") {
    result.xcodeCloud = {
      notARunner: true,
      provider: "xcode_cloud",
      pricePerMinute: XCODE_CLOUD.pricePerMinute,
      centsPerMonth: cents(minutes, 1, XCODE_CLOUD.pricePerMinute),
      source: XCODE_CLOUD.source,
      note: "Xcode Cloud is not a GitHub Actions runner and does not allow customer hardware; shown for comparison only.",
    };
  }
  return result;
}

/** The failover form for a connected machine: the hosted default survives when no machine is online. */
/**
 * The routing expression written into a workflow: the connected machine when Buildhound has set the variable,
 * the hosted label otherwise. Public repositories also keep pull requests from forks on the hosted label, so a
 * stranger's code never runs on a customer's machine; private repositories do not run fork pull requests by default.
 */
export function buildhoundLabelExpression(os: Os, hostedDefault: string, publicRepo = false): string {
  const variable = os === "macos" ? "BUILDHOUND_MACOS" : "BUILDHOUND_LINUX";
  if (publicRepo) return `\${{ github.event.pull_request.head.repo.fork && '${hostedDefault}' || vars.${variable} || '${hostedDefault}' }}`;
  return `\${{ vars.${variable} || '${hostedDefault}' }}`;
}

/**
 * Replace a job's runs-on with one label while keeping every comment (CLAUDE.md rule 1).
 * Scalars and sequence items are edited in place; trailing comments of dropped items move to the kept one.
 */
export function setRunsOn(doc: Document, jobId: string, label: string): void {
  const path = ["jobs", jobId, "runs-on"];
  const node = doc.getIn(path, true);
  if (isScalar(node)) {
    node.value = label;
    return;
  }
  if (isSeq(node) && node.items.length) {
    const [first, ...rest] = node.items;
    const comments = rest.map((n) => (isScalar(n) ? n.comment : null)).filter((c): c is string => typeof c === "string" && c.length > 0);
    if (isScalar(first)) first.value = label;
    else node.items[0] = doc.createNode(label);
    const kept = node.items[0];
    if (comments.length && isScalar(kept)) kept.comment = [kept.comment, ...comments].filter(Boolean).join(" ");
    node.items.length = 1;
    return;
  }
  doc.setIn(path, label);
}
