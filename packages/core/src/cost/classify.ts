import type { Rate } from "./rates/github";
import { githubRateForLabel } from "./rates/github";

export type Provider =
  | "github" | "blacksmith" | "depot" | "warpbuild" | "ubicloud" | "runs_on" | "namespace" | "buildhound" | "self_hosted" | "unknown";
export type Os = "linux" | "windows" | "macos" | "unknown";
export type RateConfidence = "high" | "medium" | "low";

export interface Classification {
  provider: Provider;
  os: Os;
  vcpu: number | null;
  runnerClass: string;
  /** USD per minute. Connected Buildhound machines and self-hosted default to 0. */
  pricePerMinute: number;
  multiplier: number;
  rateConfidence: RateConfidence;
}

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
  if (/ubuntu|linux|debian/i.test(label)) return "linux";
  return "unknown";
}

function vcpuFromLabel(label: string): number | null {
  const m = label.match(/(\d+)\s*vcpu/i) ?? label.match(/-(\d+)x$/) ?? label.match(/-(\d+)$/) ?? label.match(/cpu=(\d+)/);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Classify a job from its runs-on labels. Provider patterns win over GitHub labels,
 * because third-party runners register with GitHub as self-hosted and may carry both.
 * Nothing is priced at zero because a label is unfamiliar: unknown labels are priced at
 * linux_2 with low confidence (COST_MODEL.md).
 */
export function classify(labels: readonly string[]): Classification {
  for (const label of labels) {
    for (const p of PATTERNS) {
      if (p.re.test(label)) {
        const os = osFromLabel(label) === "unknown" && p.provider === "runs_on" ? "linux" : osFromLabel(label);
        return {
          provider: p.provider,
          os: os === "unknown" ? "linux" : os,
          vcpu: vcpuFromLabel(label),
          runnerClass: label,
          pricePerMinute: 0, // vendor tables arrive in M1; 0 here is a placeholder, never reported as final
          multiplier: 0,
          rateConfidence: "low",
        };
      }
    }
  }
  for (const label of labels) {
    const rate: Rate | undefined = githubRateForLabel(label);
    if (rate) {
      return { provider: "github", os: rate.os, vcpu: rate.vcpu, runnerClass: rate.runnerClass, pricePerMinute: rate.pricePerMinute, multiplier: rate.multiplier, rateConfidence: "high" };
    }
  }
  if (labels.includes("self-hosted")) {
    return { provider: "self_hosted", os: "unknown", vcpu: null, runnerClass: "self_hosted", pricePerMinute: 0, multiplier: 0, rateConfidence: "low" };
  }
  const linux2 = githubRateForLabel("ubuntu-latest")!;
  return { provider: "unknown", os: "unknown", vcpu: null, runnerClass: "unknown", pricePerMinute: linux2.pricePerMinute, multiplier: 0, rateConfidence: "low" };
}
