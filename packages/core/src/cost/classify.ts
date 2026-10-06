import { githubRateForLabel } from "./rates/github";
import { vendorRate } from "./rates/vendors";

export type Provider =
  | "github" | "blacksmith" | "depot" | "warpbuild" | "ubicloud" | "runs_on" | "namespace" | "buildhound" | "self_hosted" | "unknown";
export type Os = "linux" | "windows" | "macos" | "unknown";
export type Arch = "x64" | "arm64";
export type RateConfidence = "high" | "medium" | "low";

export interface Classification {
  provider: Provider;
  os: Os;
  arch: Arch;
  vcpu: number | null;
  runnerClass: string;
  /** USD per minute. Connected Buildhound machines and self-hosted default to 0. */
  pricePerMinute: number;
  multiplier: number;
  rateConfidence: RateConfidence;
}

/** Per-account overrides keyed by provider or by `provider:label`. Values are USD per minute. */
export type RateOverrides = Record<string, number>;

const PATTERNS: Array<{ provider: Provider; re: RegExp }> = [
  { provider: "buildhound", re: /^buildhound-/ },
  { provider: "blacksmith", re: /^blacksmith-/ },
  { provider: "depot", re: /^depot-/ },
  { provider: "warpbuild", re: /^warp-/ },
  { provider: "ubicloud", re: /^ubicloud-/ },
  { provider: "runs_on", re: /^(runs-on=|runner=)/ },
  { provider: "namespace", re: /^namespace-profile-/ },
];

function osFromLabel(label: string): Os {
  if (/macos|darwin/i.test(label)) return "macos";
  if (/windows/i.test(label)) return "windows";
  if (/ubuntu|linux|debian|^runs-on=|^runner=/i.test(label)) return "linux";
  return "unknown";
}

function archFromLabel(label: string, os: Os): Arch {
  if (os === "macos") return "arm64";
  return /arm64|-arm\b|-arm-|aarch64/i.test(label) ? "arm64" : "x64";
}

function vcpuFromLabel(label: string): number | null {
  const m =
    label.match(/(\d+)\s*vcpu/i) ??
    label.match(/-(\d+)x(?:-|$)/) ??
    label.match(/cpu=(\d+)/) ??
    label.match(/-(\d+)$/);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Classify a job from its runs-on labels. Provider patterns win over GitHub labels, because
 * third-party runners register with GitHub as self-hosted and may carry both. Nothing is priced
 * at zero because a label is unfamiliar: unknown labels are priced at linux_2 with low confidence.
 */
export function classify(labels: readonly string[], overrides: RateOverrides = {}): Classification {
  for (const label of labels) {
    for (const p of PATTERNS) {
      if (!p.re.test(label)) continue;
      const os = osFromLabel(label);
      const effectiveOs: Os = os === "unknown" ? "linux" : os;
      const arch = archFromLabel(label, effectiveOs);
      const vcpu = vcpuFromLabel(label) ?? (p.provider === "buildhound" ? 4 : 2);
      const override = overrides[`${p.provider}:${label}`] ?? overrides[p.provider];
      if (override !== undefined) {
        return { provider: p.provider, os: effectiveOs, arch, vcpu, runnerClass: label, pricePerMinute: override, multiplier: 0, rateConfidence: "high" };
      }
      if (p.provider === "namespace") {
        return { provider: p.provider, os: effectiveOs, arch, vcpu, runnerClass: label, pricePerMinute: githubRateForLabel("ubuntu-latest")!.pricePerMinute, multiplier: 0, rateConfidence: "low" };
      }
      const rate = vendorRate(p.provider, effectiveOs, arch, vcpu);
      if (!rate) {
        return { provider: p.provider, os: effectiveOs, arch, vcpu, runnerClass: label, pricePerMinute: githubRateForLabel("ubuntu-latest")!.pricePerMinute, multiplier: 0, rateConfidence: "low" };
      }
      const confidence: RateConfidence = p.provider === "runs_on" ? "low" : rate.derived ? "medium" : "high";
      return { provider: p.provider, os: effectiveOs, arch, vcpu, runnerClass: label, pricePerMinute: rate.pricePerMinute, multiplier: 0, rateConfidence: confidence };
    }
  }
  for (const label of labels) {
    const rate = githubRateForLabel(label);
    if (rate) {
      return { provider: "github", os: rate.os, arch: archFromLabel(label, rate.os), vcpu: rate.vcpu, runnerClass: rate.runnerClass, pricePerMinute: rate.pricePerMinute, multiplier: rate.multiplier, rateConfidence: "high" };
    }
  }
  if (labels.includes("self-hosted")) {
    const override = overrides["self_hosted"];
    return { provider: "self_hosted", os: "unknown", arch: "x64", vcpu: null, runnerClass: "self_hosted", pricePerMinute: override ?? 0, multiplier: 0, rateConfidence: override === undefined ? "low" : "high" };
  }
  const linux2 = githubRateForLabel("ubuntu-latest")!;
  return { provider: "unknown", os: "unknown", arch: "x64", vcpu: null, runnerClass: "unknown", pricePerMinute: linux2.pricePerMinute, multiplier: 0, rateConfidence: "low" };
}
