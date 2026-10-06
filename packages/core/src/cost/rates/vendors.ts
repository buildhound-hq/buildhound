/**
 * Third-party runner rates per minute in USD, read from each vendor's public pricing on 2026-10-06
 * (COST_MODEL.md, "Third-party and self-hosted runners"). Larger sizes marked `derived` are assumed
 * linear in vCPU and carry medium confidence. No price lives outside this folder (CLAUDE.md rule 4).
 */
import type { Provider } from "../classify";

export interface VendorRate {
  os: "linux" | "windows" | "macos";
  arch: "x64" | "arm64";
  vcpu: number;
  pricePerMinute: number;
  derived?: boolean;
}

export interface VendorTable {
  provider: Provider;
  source: string;
  verifiedAt: string;
  /** Per-vCPU price for sizes not listed, used with low confidence. */
  rates: VendorRate[];
  notes: string;
}

const lin = (os: VendorRate["os"], arch: VendorRate["arch"], base: number, baseVcpu: number, sizes: number[], listed: number[] = []): VendorRate[] =>
  sizes.map((v) => ({ os, arch, vcpu: v, pricePerMinute: Number(((base / baseVcpu) * v).toFixed(5)), derived: !listed.includes(v) }));

export const VENDOR_TABLES: readonly VendorTable[] = [
  {
    provider: "blacksmith",
    source: "https://www.blacksmith.sh/pricing",
    verifiedAt: "2026-10-06",
    notes: "3,000 free minutes a month. Linux sizes above 2 vCPU assumed linear.",
    rates: [
      ...lin("linux", "x64", 0.004, 2, [2, 4, 8, 16, 32], [2]),
      ...lin("linux", "arm64", 0.0025, 2, [2, 4, 8, 16, 32], [2]),
      ...lin("windows", "x64", 0.008, 2, [2, 4, 8, 16, 32], [2]),
      { os: "macos", arch: "arm64", vcpu: 6, pricePerMinute: 0.08 },
      { os: "macos", arch: "arm64", vcpu: 12, pricePerMinute: 0.16, derived: true },
    ],
  },
  {
    provider: "depot",
    source: "https://depot.dev/docs/github-actions/runner-types",
    verifiedAt: "2026-10-06",
    notes: "Plans $20 a month with 2,000 minutes, $200 with 20,000; additional usage $0.006 a minute.",
    rates: [
      ...lin("linux", "x64", 0.006, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      ...lin("linux", "arm64", 0.006, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      ...lin("windows", "x64", 0.008, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      { os: "macos", arch: "arm64", vcpu: 6, pricePerMinute: 0.08 },
    ],
  },
  {
    provider: "warpbuild",
    source: "https://www.warpbuild.com/pricing",
    verifiedAt: "2026-10-06",
    notes: "",
    rates: [
      ...lin("linux", "x64", 0.004, 2, [2, 4, 8, 16, 32], [2, 4, 8, 16, 32]),
      ...lin("linux", "arm64", 0.003, 2, [2, 4, 8, 16, 32], [2, 4, 8, 16, 32]),
      ...lin("windows", "x64", 0.016, 4, [4, 8, 16, 32], [4, 8, 16, 32]),
      { os: "macos", arch: "arm64", vcpu: 6, pricePerMinute: 0.08 },
      { os: "macos", arch: "arm64", vcpu: 12, pricePerMinute: 0.16 },
    ],
  },
  {
    provider: "ubicloud",
    source: "https://www.ubicloud.com/docs/about/pricing",
    verifiedAt: "2026-10-06",
    notes: "$2.50 monthly credit. Standard tier; premium x64 is $0.002 at 2 vCPU. No macOS or Windows.",
    rates: [
      ...lin("linux", "x64", 0.00125, 2, [2, 4, 8, 16, 30], [2, 4, 8, 16, 30]),
      ...lin("linux", "arm64", 0.00125, 2, [2, 4, 8, 16, 30], [2, 4, 8, 16, 30]),
    ],
  },
  {
    provider: "runs_on",
    source: "https://runs-on.com/pricing",
    verifiedAt: "2026-10-06",
    notes: "Compute is the customer's own AWS bill. Vendor spot examples, us-east-1. Licence €300 to €3,600 a year. Low confidence until the account overrides it.",
    rates: [
      { os: "linux", arch: "x64", vcpu: 2, pricePerMinute: 0.0009 },
      { os: "linux", arch: "x64", vcpu: 8, pricePerMinute: 0.0027 },
      { os: "linux", arch: "x64", vcpu: 32, pricePerMinute: 0.0078 },
    ],
  },
  {
    provider: "buildhound",
    source: "https://buildhound.sh/pricing",
    verifiedAt: "2026-10-06",
    notes: "Connected machines. Zero per minute; the flat per-machine fee is an account-level line. Two macOS guests per Mac.",
    rates: [
      { os: "macos", arch: "arm64", vcpu: 4, pricePerMinute: 0 },
      { os: "linux", arch: "arm64", vcpu: 4, pricePerMinute: 0 },
      { os: "linux", arch: "x64", vcpu: 4, pricePerMinute: 0 },
    ],
  },
];

/** Xcode Cloud is not a GitHub label; it is shown as a comparison for macOS jobs only. */
export const XCODE_CLOUD = {
  source: "https://developer.apple.com/xcode-cloud/get-started/",
  verifiedAt: "2026-10-06",
  tiers: [
    { hours: 25, usd: 0 },
    { hours: 100, usd: 49.99 },
    { hours: 250, usd: 99.99 },
    { hours: 1000, usd: 399.99 },
    { hours: 10000, usd: 3999.99 },
  ],
  /** Marginal price per minute on the 100-hour tier, used for comparisons. */
  pricePerMinute: 49.99 / (100 * 60),
} as const;

export function vendorTable(provider: Provider): VendorTable | undefined {
  return VENDOR_TABLES.find((t) => t.provider === provider);
}

/** Nearest rate at or above the requested vCPU count for a provider, os and arch. */
export function vendorRate(provider: Provider, os: VendorRate["os"], arch: VendorRate["arch"], vcpu: number): VendorRate | undefined {
  const t = vendorTable(provider);
  if (!t) return undefined;
  const candidates = t.rates.filter((r) => r.os === os && r.arch === arch).sort((a, b) => a.vcpu - b.vcpu);
  return candidates.find((r) => r.vcpu >= vcpu) ?? candidates.at(-1);
}
