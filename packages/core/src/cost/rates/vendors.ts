/**
 * Third-party runner rates per minute in USD, read from each vendor's public pricing on 2026-10-06 and checked
 * again on the date in each table (COST_MODEL.md, "Third-party and self-hosted runners"). Larger sizes marked `derived` are assumed
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

/** A monthly plan a vendor sells its minutes in. `includedMinutes` are the plan's own unit, named by `unit`. */
export interface VendorPlan {
  name: string;
  usdPerMonth: number;
  includedMinutes: number;
  unit?: string;
  /** The plan offers these runners; macOS is often on the larger plans only. */
  os: VendorRate["os"][];
}

export interface VendorTable {
  provider: Provider;
  source: string;
  verifiedAt: string;
  /** Per-vCPU price for sizes not listed, used with low confidence. */
  rates: VendorRate[];
  notes: string;
  /** Free minutes a month at the smallest Linux size, when the vendor gives them. */
  freeMinutesPerMonth?: number;
  /** A monthly credit in USD instead of free minutes. */
  creditUsdPerMonth?: number;
  /** Plans the minutes are sold in; without them the rates are pay as you go. */
  plans?: VendorPlan[];
  /** No minutes without a plan: a month costs at least the cheapest plan that offers the runner. */
  planRequired?: boolean;
  /** A yearly licence on top of the customer's own cloud bill, in euros. */
  licenceEurPerYear?: { min: number; max: number };
}

const lin = (os: VendorRate["os"], arch: VendorRate["arch"], base: number, baseVcpu: number, sizes: number[], listed: number[] = []): VendorRate[] =>
  sizes.map((v) => ({ os, arch, vcpu: v, pricePerMinute: Number(((base / baseVcpu) * v).toFixed(5)), derived: !listed.includes(v) }));

export const VENDOR_TABLES: readonly VendorTable[] = [
  {
    provider: "blacksmith",
    source: "https://www.blacksmith.sh/pricing",
    verifiedAt: "2026-10-16",
    notes: "3,000 free 2 vCPU x64 minutes a month per organisation, usable on every runner type. Prices are linear in vCPU (the pricing page, 2026-10-16). Windows is in public beta. Organisations only.",
    freeMinutesPerMonth: 3000,
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
    verifiedAt: "2026-10-16",
    notes: "Plans $20 a month with 2,000 minutes, $200 with 20,000; additional usage $0.006 a minute. No free tier, a 7-day trial. macOS (M4 or M2, 8 vCPU, 24 GB) only on Startup and Business. Organisations only.",
    plans: [
      { name: "Developer", usdPerMonth: 20, includedMinutes: 2000, os: ["linux", "windows"] },
      { name: "Startup", usdPerMonth: 200, includedMinutes: 20000, os: ["linux", "windows", "macos"] },
    ],
    planRequired: true,
    rates: [
      ...lin("linux", "x64", 0.006, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      ...lin("linux", "arm64", 0.006, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      ...lin("windows", "x64", 0.008, 2, [2, 4, 8, 16, 32, 64], [2, 4, 8, 16, 32, 64]),
      { os: "macos", arch: "arm64", vcpu: 8, pricePerMinute: 0.08 },
    ],
  },
  {
    provider: "warpbuild",
    source: "https://www.warpbuild.com/pricing",
    verifiedAt: "2026-10-16",
    notes: "Pay as you go. The 2 vCPU Windows size was removed on 2026-06-08. macOS memory is 14 GB at 6 vCPU and 28 GB at 12 from 2026-10-01. Linux and Windows can also run in the customer's own AWS, GCP or Azure account. Runs an affiliate programme; Buildhound has not joined it.",
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
    verifiedAt: "2026-10-16",
    notes: "$2.50 monthly credit. Standard tier; new accounts start on Premium, $0.002 at 2 vCPU x64, and fall back to Standard when it is busy. No macOS or Windows. Servers in Germany, with an optional US fleet on Standard.",
    creditUsdPerMonth: 2.5,
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
    verifiedAt: "2026-10-16",
    notes: "Compute is the customer's own AWS bill. Vendor spot examples, us-east-1, seven-day averages that drift. Licence €300 to €3,600 a year by jobs a month, free for non-commercial open source. No macOS. Low confidence until the account overrides it.",
    licenceEurPerYear: { min: 300, max: 3600 },
    rates: [
      { os: "linux", arch: "x64", vcpu: 2, pricePerMinute: 0.0009 },
      { os: "linux", arch: "x64", vcpu: 8, pricePerMinute: 0.0027 },
      { os: "linux", arch: "x64", vcpu: 32, pricePerMinute: 0.0078 },
    ],
  },
  {
    provider: "namespace",
    source: "https://namespace.so/pricing",
    verifiedAt: "2026-10-16",
    notes:
      "Pay-as-you-go prices. The Team ($100 a month, 100,000 unit minutes) and Business ($250, 250,000) plans prepay the same sizes at two thirds of these, for example $0.04 a minute for 4 vCPU macOS. macOS runs mostly on M5 Max, some on M4 Pro. Sizes are by vCPU at the smallest memory (Linux 2 vCPU is 4 GB; 8 GB is $0.006). Concurrency is capped by vCPU per plan.",
    plans: [
      { name: "Team", usdPerMonth: 100, includedMinutes: 100000, unit: "unit minutes", os: ["linux", "windows", "macos"] },
      { name: "Business", usdPerMonth: 250, includedMinutes: 250000, unit: "unit minutes", os: ["linux", "windows", "macos"] },
    ],
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
  verifiedAt: "2026-10-16",
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
    verifiedAt: "2026-10-16",
    unit: "runner",
    usdPerMonth: 149,
    concurrentJobs: 1,
    includedMinutes: 15000,
    hardware: "M4 Pro, 6 vCPU, 22 GB",
    notes: "A fresh VM per job, no per-minute charge, up to two hours a job. Above 15,000 minutes a runner in 30 days it starts a conversation, not a charge. XL is $299 for 12 vCPU and 44 GB. An invitation-only pilot on its own Macs in Menlo Park.",
  },
  {
    vendor: "macrun",
    name: "MacRun CI runner",
    source: "https://macrun.dev/pricing",
    verifiedAt: "2026-10-16",
    unit: "Mac",
    usdPerMonth: 139,
    concurrentJobs: null,
    includedMinutes: null,
    hardware: "M6, 16 GB, 256 GB",
    notes: "A dedicated rented Mac mini, unlimited minutes, builds one after another on the Mac as a self-hosted runner, wiped when you cancel. The first month is $69 at launch; the M4 is $119; annual billing is 10 months for 12.",
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

/**
 * Orchestrators for runners on the customer's own machines or cloud, priced by host or by repository rather than by
 * the minute; comparisons only, never a routing target. ushr's price for `hosts` machines is `ushrMonthlyUsd`.
 */
export const USHR = {
  source: "https://ushr.io/pricing",
  verifiedAt: "2026-10-16",
  freeHosts: 1,
  proUsdPerMonth: 49,
  proIncludedHosts: 3,
  extraHostUsd: 19,
  maxHosts: 100,
  notes: "A host is one enrolled agent. Free is one host and one GitHub account or organisation. macOS in Tart or Lume VMs, Linux in Docker or Podman containers. Apache-2.0, and self-hostable for free.",
} as const;

/** ushr's monthly price in USD for this many hosts, or null above its limit. */
export function ushrMonthlyUsd(hosts: number): number | null {
  if (hosts > USHR.maxHosts) return null;
  if (hosts <= USHR.freeHosts) return 0;
  return USHR.proUsdPerMonth + Math.max(0, hosts - USHR.proIncludedHosts) * USHR.extraHostUsd;
}

export const CIRUN = {
  source: "https://cirun.io/pricing",
  verifiedAt: "2026-10-16",
  /** Public repositories are free; private ones by the number of repositories, a month. */
  tiers: [
    { privateRepos: 3, usd: 29 },
    { privateRepos: 10, usd: 79 },
  ],
  notes: "A platform fee on top of the customer's own cloud bill (AWS, GCP, Azure, Oracle, OpenStack, DigitalOcean, Hetzner, Vast.ai), or its agent on the customer's machines. Enterprise is custom.",
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
