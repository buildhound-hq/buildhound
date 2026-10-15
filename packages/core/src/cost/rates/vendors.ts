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
    provider: "jog",
    source: "https://usejog.com/",
    verifiedAt: "2026-10-13",
    notes: "Label `jog`, Ubuntu 24.04 x64 only, 2 vCPU and 8 GB; 4 and 8 vCPU sizes are offered without a list price. Prepaid credits, no free tier.",
    rates: [...lin("linux", "x64", 0.0012, 2, [2, 4, 8], [2])],
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
    provider: "namespace",
    source: "https://namespace.so/pricing",
    verifiedAt: "2026-10-15",
    notes:
      "Pay-as-you-go prices. The Team ($100 a month, 100,000 unit minutes) and Business ($250, 250,000) plans prepay the same sizes at two thirds of these, for example $0.04 a minute for 4 vCPU macOS. macOS runs mostly on M5 Max, some on M4 Pro. Sizes are by vCPU at the standard memory.",
    rates: [
      { os: "linux", arch: "x64", vcpu: 2, pricePerMinute: 0.003 },
      { os: "linux", arch: "x64", vcpu: 4, pricePerMinute: 0.006 },
      { os: "linux", arch: "x64", vcpu: 8, pricePerMinute: 0.012 },
      { os: "linux", arch: "x64", vcpu: 16, pricePerMinute: 0.024 },
      { os: "linux", arch: "x64", vcpu: 32, pricePerMinute: 0.048 },
      { os: "linux", arch: "x64", vcpu: 64, pricePerMinute: 0.12 },
      { os: "linux", arch: "arm64", vcpu: 2, pricePerMinute: 0.003 },
      { os: "linux", arch: "arm64", vcpu: 4, pricePerMinute: 0.006 },
      { os: "linux", arch: "arm64", vcpu: 8, pricePerMinute: 0.012 },
      { os: "linux", arch: "arm64", vcpu: 16, pricePerMinute: 0.024 },
      { os: "linux", arch: "arm64", vcpu: 32, pricePerMinute: 0.048 },
      { os: "windows", arch: "x64", vcpu: 2, pricePerMinute: 0.006 },
      { os: "windows", arch: "x64", vcpu: 4, pricePerMinute: 0.012 },
      { os: "windows", arch: "x64", vcpu: 8, pricePerMinute: 0.024 },
      { os: "windows", arch: "x64", vcpu: 16, pricePerMinute: 0.048 },
      { os: "macos", arch: "arm64", vcpu: 4, pricePerMinute: 0.06 },
      { os: "macos", arch: "arm64", vcpu: 6, pricePerMinute: 0.09 },
      { os: "macos", arch: "arm64", vcpu: 8, pricePerMinute: 0.12 },
      { os: "macos", arch: "arm64", vcpu: 12, pricePerMinute: 0.18 },
      { os: "macos", arch: "arm64", vcpu: 16, pricePerMinute: 0.24 },
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

/**
 * macOS offers sold as a plan or a machine rather than per minute on a runner label, shown beside the per-minute
 * vendors as comparisons only (the pricing page; never a routing target). Prices from each vendor's public page.
 */
export interface FlatMacOffer {
  vendor: "manzanita" | "macrun" | "bitrise_build_hub";
  name: string;
  source: string;
  verifiedAt: string;
  /** What one unit buys: a runner, a Mac or a plan tier. */
  unit: string;
  usdPerMonth: number;
  /** Jobs one unit runs at once; null when the vendor does not say. */
  concurrentJobs: number | null;
  /** Minutes a unit covers before the vendor's fair use or tier limit applies; null when unlimited or unstated. */
  includedMinutes: number | null;
  hardware: string;
  notes: string;
}

export const FLAT_MAC_OFFERS: readonly FlatMacOffer[] = [
  {
    vendor: "manzanita",
    name: "Manzanita Standard",
    source: "https://manzanita.run/",
    verifiedAt: "2026-10-15",
    unit: "runner",
    usdPerMonth: 149,
    concurrentJobs: 1,
    includedMinutes: 15000,
    hardware: "M4 Pro, 6 vCPU, 22 GB",
    notes: "A fresh VM per job, no per-minute charge. Above 15,000 minutes a runner in 30 days it starts a conversation, not a charge. XL is $299 for 12 vCPU and 44 GB.",
  },
  {
    vendor: "macrun",
    name: "MacRun CI runner",
    source: "https://macrun.dev/pricing",
    verifiedAt: "2026-10-15",
    unit: "Mac",
    usdPerMonth: 139,
    concurrentJobs: null,
    includedMinutes: null,
    hardware: "M6, 16 GB, 256 GB",
    notes: "A dedicated rented Mac, unlimited minutes. Launch offer $69 a month; the M4 is $119; annual billing is 10 months for 12. Concurrent jobs per Mac are not stated.",
  },
  {
    vendor: "bitrise_build_hub",
    name: "Bitrise Build Hub Basic",
    source: "https://bitrise.io/pricing",
    verifiedAt: "2026-10-15",
    unit: "plan",
    usdPerMonth: 180,
    concurrentJobs: null,
    includedMinutes: 6000,
    hardware: "M4 Large",
    notes: "Hosted macOS for GitHub Actions in monthly tiers ($15 to $180 on Basic, $210 to $810 on Pro, 10% off annually); Basic covers up to 6,000 M4 Large minutes, Pro up to 27,000. Its FAQ prices M4 Large at $0.03 a minute. Builds stop when the tier's budget runs out.",
  },
];

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
