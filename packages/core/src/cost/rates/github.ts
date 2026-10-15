/**
 * GitHub-hosted runner rates per minute in USD for private repositories.
 * Source: https://docs.github.com/en/billing/reference/actions-runner-pricing
 * Verified: 2026-10-15. Prices reflect the January 2026 price cut.
 * No price may live outside packages/core/cost/rates (CLAUDE.md rule 4).
 */
export interface Rate {
  runnerClass: string;
  os: "linux" | "windows" | "macos";
  vcpu: number;
  /** USD per minute */
  pricePerMinute: number;
  /**
   * Included minutes one minute on this runner draws, which is not a whole number: GitHub draws the included
   * allowance at list price, counted in Linux 2-core minutes (see GITHUB_INCLUDED_DRAW_META). 0 for larger runners,
   * which can never use included minutes and are always billed.
   */
  multiplier: number;
  labels: readonly string[];
}

export const GITHUB_RATES_META = {
  provider: "github",
  effectiveFrom: "2026-01-01",
  source: "https://docs.github.com/en/billing/reference/actions-runner-pricing",
  verifiedAt: "2026-10-15",
} as const;

/**
 * How a minute on each runner counts against the plan's included minutes (verified 2026-10-15, ADR-034).
 *
 * - Until 2025-12-16 GitHub's Actions billing page had a "Minute multipliers" table: Linux 1, Windows 2, macOS 10.
 *   github/docs commit ce33310 (2025-12-16, "Feature branch for self-hosted runner billing part 1") replaced it with "Baseline minute costs", one price per runner,
 *   and /billing/reference/actions-minute-multipliers now redirects to the runner pricing page. At the 2025 prices
 *   ($0.008, $0.016, $0.08) those multipliers were exactly the price ratios.
 * - GitHub's changelog FAQ of 2025-12-16 says included usage is consumed "based on list price the same way that Linux,
 *   Windows, and MacOS standard runners work today", that "The free usage minute quotas will remain the same", and
 *   that Free and Pro's included minutes are "over 33 hours of included GitHub compute" (2,000 minutes, Linux).
 * - The billing docs record included usage as a dollar discount (`discount_amount` in billing reports) and say the
 *   dashboard's spend "already reflects any applicable minute costs".
 * - No GitHub page says a macOS or Windows minute counts as one included minute; the 1:1 reading comes only from
 *   third-party guides that read the missing table as no weighting.
 *
 * So the allowance is a list-price amount counted in Linux 2-core minutes, and one minute draws
 * pricePerMinute / GITHUB_INCLUDED_MINUTE_PRICE included minutes: macOS about 10.3, Windows about 1.7, Linux arm64
 * about 0.83, ubuntu-slim about 0.33. GitHub publishes no worked example at the 2026 prices, so the exact ratio is the
 * one inference here (the old table's flat 10 would be 3% lower for macOS); the account's billing usage report
 * settles it per account (COST_MODEL.md, Reconciliation). Larger runners never draw included minutes.
 */
export const GITHUB_INCLUDED_DRAW_META = {
  provider: "github",
  source: "https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/",
  alsoSee: [
    "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
    "https://docs.github.com/en/billing/reference/actions-runner-pricing",
    "https://docs.github.com/en/billing/reference/billing-reports",
    "https://github.com/github/docs/commit/ce33310edb3d6ad3a43437b877a6f191c9349f0c",
  ],
  verifiedAt: "2026-10-15",
} as const;

/** USD list price of one included minute: GitHub's Linux 2-core standard runner (`ubuntu-latest`). */
export const GITHUB_INCLUDED_MINUTE_PRICE = 0.006;

type RateInput = Omit<Rate, "multiplier">;
/** A standard runner: draws included minutes at its list price. */
const standard = (r: RateInput): Rate => ({ ...r, multiplier: r.pricePerMinute / GITHUB_INCLUDED_MINUTE_PRICE });
/** A larger runner: "Included minutes cannot be used for larger runners" (actions-runner-pricing). */
const larger = (r: RateInput): Rate => ({ ...r, multiplier: 0 });

export const GITHUB_RATES: readonly Rate[] = [
  standard({ runnerClass: "linux_1_slim", os: "linux", vcpu: 1, pricePerMinute: 0.002, labels: ["ubuntu-slim"] }),
  standard({ runnerClass: "linux_2", os: "linux", vcpu: 2, pricePerMinute: 0.006, labels: ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"] }),
  standard({ runnerClass: "linux_2_arm", os: "linux", vcpu: 2, pricePerMinute: 0.005, labels: ["ubuntu-24.04-arm", "ubuntu-22.04-arm"] }),
  larger({ runnerClass: "linux_4", os: "linux", vcpu: 4, pricePerMinute: 0.012, labels: [] }),
  larger({ runnerClass: "linux_8", os: "linux", vcpu: 8, pricePerMinute: 0.022, labels: [] }),
  larger({ runnerClass: "linux_16", os: "linux", vcpu: 16, pricePerMinute: 0.042, labels: [] }),
  larger({ runnerClass: "linux_32", os: "linux", vcpu: 32, pricePerMinute: 0.082, labels: [] }),
  larger({ runnerClass: "linux_64", os: "linux", vcpu: 64, pricePerMinute: 0.162, labels: [] }),
  standard({ runnerClass: "windows_2", os: "windows", vcpu: 2, pricePerMinute: 0.01, labels: ["windows-latest", "windows-2025", "windows-2022"] }),
  standard({ runnerClass: "windows_2_arm", os: "windows", vcpu: 2, pricePerMinute: 0.01, labels: ["windows-11-arm"] }),
  standard({ runnerClass: "macos_3", os: "macos", vcpu: 3, pricePerMinute: 0.062, labels: ["macos-latest", "macos-13", "macos-14", "macos-15", "macos-26"] }),
  larger({ runnerClass: "macos_12", os: "macos", vcpu: 12, pricePerMinute: 0.077, labels: ["macos-latest-large", "macos-14-large", "macos-15-large"] }),
  larger({ runnerClass: "macos_xl", os: "macos", vcpu: 5, pricePerMinute: 0.102, labels: ["macos-latest-xlarge", "macos-14-xlarge", "macos-15-xlarge", "macos-26-xlarge"] }),
];

/**
 * Minutes a month each GitHub plan includes for GitHub-hosted runners, in private repositories only:
 * public repositories use standard runners free, and larger runners never draw from these. Without a
 * payment method on file, usage is blocked once they are used up. GitHub rounds each job up to the
 * whole minute (actions-runner-pricing). The minutes are Linux 2-core minutes: a macOS or Windows minute
 * draws its Rate.multiplier of them (GITHUB_INCLUDED_DRAW_META).
 */
export const GITHUB_INCLUDED_MINUTES_META = {
  provider: "github",
  source: "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
  verifiedAt: "2026-10-15",
} as const;

export const GITHUB_INCLUDED_MINUTES = {
  free: 2000,
  pro: 3000,
  freeForOrganizations: 2000,
  team: 3000,
  enterpriseCloud: 50000,
} as const satisfies Record<string, number>;

/**
 * Whole included minutes `rawMinutes` on `rate` draw from the plan, rounded to the nearest minute: 10 minutes of
 * `macos-latest` draw 103, of `windows-latest` 17, of `ubuntu-latest` 10. Larger runners draw 0.
 */
/** How many standard hosted macOS jobs GitHub runs at a time on each plan; the rest queue (Actions limits). Not a price, kept here with its source like one. */
export const GITHUB_MACOS_CONCURRENCY_META = {
  provider: "github",
  source: "https://docs.github.com/en/actions/reference/limits",
  verifiedAt: "2026-10-15",
} as const;

export const GITHUB_MACOS_CONCURRENCY = { free: 5, pro: 5, team: 5, enterprise: 50 } as const satisfies Record<string, number>;

export function githubIncludedMinutesDrawn(rawMinutes: number, rate: Pick<Rate, "multiplier">): number {
  return Math.round(rawMinutes * rate.multiplier);
}

export function githubRateForLabel(label: string): Rate | undefined {
  return GITHUB_RATES.find((r) => r.labels.includes(label));
}
