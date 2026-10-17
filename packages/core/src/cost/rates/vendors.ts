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
  vendor: "manzanita" | "macrun";
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
];

/** One OS's price in a CI offer: by the minute at a named size, or in monthly tiers covering a number of minutes. */
export interface CiOfferPrice {
  /** The machine the price is for, as the vendor names it. */
  size: string;
  /** USD a minute at that size; for a tiered offer, the per-minute price its tiers are worked out from. */
  pricePerMinute: number;
  /** Credits a minute, for a vendor that bills in credits. */
  creditsPerMinute?: number;
  /** Monthly steps, each covering this many minutes of this size alone, ascending. */
  tiers?: { minutes: number; usd: number }[];
  /** The least a month of this OS costs: the cheapest plan that offers it. */
  floorUsdPerMonth?: number;
}

/**
 * Other ways to run CI, priced from each vendor's public page and compared beside GitHub-hosted, never a routing target:
 * CI services with their own configuration (Codemagic, CircleCI, Buildkite) and GitHub Actions runners sold another way
 * (Bitrise Build Hub in monthly tiers, AWS CodeBuild by the build minute in the customer's AWS account). An OS a vendor
 * sells no per-minute price for is absent.
 */
export interface CiOffer {
  vendor: "codemagic" | "circleci" | "buildkite" | "bitrise_build_hub" | "codebuild";
  name: string;
  source: string;
  verifiedAt: string;
  macos?: CiOfferPrice;
  linux?: CiOfferPrice;
  /** USD for one credit, for a vendor that bills in credits. */
  usdPerCredit?: number;
  /** Free minutes a month, at the size and OS the notes name. */
  freeMinutesPerMonth?: number;
  notes: string;
}

/* Bitrise Build Hub's tiers: each covers its fee at the FAQ's per-minute price for one size alone. */
const bitriseTiers = (perMinute: number) => [15, 45, 90, 180, 210, 300, 600, 810].map((usd) => ({ minutes: Math.round(usd / perMinute), usd }));
/* CircleCI on Performance: $15 for every 25,000 credits. */
const CIRCLECI_USD_PER_CREDIT = 15 / 25000;

export const CI_OFFERS: readonly CiOffer[] = [
  {
    vendor: "codemagic",
    name: "Codemagic",
    source: "https://codemagic.io/pricing/",
    verifiedAt: "2026-10-17",
    macos: { size: "Mac mini M2", pricePerMinute: 0.095 },
    linux: { size: "Linux X2", pricePerMinute: 0.045 },
    freeMinutesPerMonth: 500,
    notes: "Pay as you go: Mac mini M2 $0.095 a minute, Mac mini M4 $0.114, Linux X2 and Windows $0.045; 500 free Mac mini M2 minutes a month on the free plan; extra concurrency $49 each, up to 3. Fixed plans a year with unlimited minutes: M2 $3,990 with 3 concurrent builds, M4 $5,400, M4 Max $9,000. M4 Pro and M4 Max by the minute are Enterprise only, from $12,000 a year. Builds run from codemagic.yaml, not GitHub Actions. The pricing page gives no CPU or memory sizes.",
  },
  {
    vendor: "circleci",
    name: "CircleCI",
    source: "https://circleci.com/pricing/price-list/",
    verifiedAt: "2026-10-17",
    usdPerCredit: CIRCLECI_USD_PER_CREDIT,
    macos: { size: "M4 Pro Medium, 6 CPU, 28 GB", creditsPerMinute: 200, pricePerMinute: 200 * CIRCLECI_USD_PER_CREDIT, floorUsdPerMonth: 15 },
    linux: { size: "Docker Medium, 2 CPU, 4 GB", creditsPerMinute: 10, pricePerMinute: 10 * CIRCLECI_USD_PER_CREDIT },
    notes: "Credits a minute from the price list: M4 Pro Medium 200, M4 Pro Large 400 (12 CPU, 56 GB), Linux Docker Medium 10, Large 20, Windows Medium 40. $15 for every 25,000 credits on Performance, which starts at $15 a month (circleci.com/pricing); 30,000 free credits a month on Free and Performance. macOS on Performance and Scale only. Jobs run from .circleci/config.yml, not GitHub Actions.",
  },
  {
    vendor: "buildkite",
    name: "Buildkite",
    source: "https://buildkite.com/pricing",
    verifiedAt: "2026-10-17",
    macos: { size: "hosted M4 Medium, 6 vCPU", pricePerMinute: 0.12, floorUsdPerMonth: 30 },
    linux: { size: "hosted Small, 2 vCPU", pricePerMinute: 0.008, floorUsdPerMonth: 30 },
    notes: "Hosted agents on Pro: $0.004 a Linux vCPU minute (Small 2 vCPU $0.008, Medium 4 $0.016, Large 8 $0.032) and $0.02 a Mac vCPU minute (M4 Medium 6 vCPU $0.12, M4 Large 12 $0.24). Pro is $30 per active user a month with 4,000 Linux vCPU minutes; Free includes 2,000. Self-hosted agents: up to 10 at once on Free, 10 included on Pro then $3.50 an agent a month, unlimited on Enterprise. Pipelines run from Buildkite's own pipeline files, not GitHub Actions.",
  },
  {
    vendor: "bitrise_build_hub",
    name: "Bitrise Build Hub",
    source: "https://bitrise.io/pricing",
    verifiedAt: "2026-10-17",
    macos: { size: "M4 Large, 5 CPU, 14 GB", pricePerMinute: 0.03, tiers: bitriseTiers(0.03) },
    linux: { size: "Linux Medium, 4 vCPU, 16 GB", pricePerMinute: 0.0125, tiers: bitriseTiers(0.0125) },
    notes: "Hosted runners for GitHub Actions in monthly tiers: Basic $15, $45, $90 and $180 (macOS M4 Large, Linux up to Large), Pro $210, $300, $600 and $810 (adds M4 X Large and Linux X Large); 10% off annually; Enterprise custom. Each tier is a budget of minutes shared by macOS and Linux: Basic covers up to 6,000 M4 Large or 14,400 Linux Medium minutes, Pro up to 27,000 or 64,800. The FAQ prices M4 Large at $0.03 a minute and Linux Medium at $0.0125; the minutes of each lower tier are worked out from those. Runs-on labels are set on a machine pool in Bitrise.",
  },
  {
    vendor: "codebuild",
    name: "AWS CodeBuild",
    source: "https://aws.amazon.com/codebuild/pricing/",
    verifiedAt: "2026-10-17",
    linux: { size: "Linux Small, 2 vCPU, 4 GiB", pricePerMinute: 0.005 },
    freeMinutesPerMonth: 100,
    notes: "On-demand EC2 build.general1.small at $0.005 a build minute, the pricing page's own example; larger sizes cost more. 100 free build minutes a month on general1.small or arm1.small. Runs GitHub Actions jobs as CodeBuild-hosted runners, one ephemeral build per job, with runs-on: codebuild-<project>-${{ github.run_id }}-${{ github.run_attempt }} (the CodeBuild user guide). macOS only on reserved capacity fleets of M2 Macs (8 or 12 vCPU) with a 24-hour minimum charge, so no per-minute macOS price. Sizes from the build environment compute types page.",
  },
];

export function ciOffer(vendor: CiOffer["vendor"]): CiOffer {
  return CI_OFFERS.find((o) => o.vendor === vendor)!;
}

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
