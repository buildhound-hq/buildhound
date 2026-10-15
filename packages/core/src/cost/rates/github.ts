/**
 * GitHub-hosted runner rates per minute in USD for private repositories.
 * Source: https://docs.github.com/en/billing/reference/actions-runner-pricing
 * Verified: 2026-10-06. Prices reflect the January 2026 price cut.
 * No price may live outside packages/core/cost/rates (CLAUDE.md rule 4).
 */
export interface Rate {
  runnerClass: string;
  os: "linux" | "windows" | "macos";
  vcpu: number;
  /** USD per minute */
  pricePerMinute: number;
  /** What one minute consumes from the plan's included minutes */
  multiplier: number;
  labels: readonly string[];
}

export const GITHUB_RATES_META = {
  provider: "github",
  effectiveFrom: "2026-01-01",
  source: "https://docs.github.com/en/billing/reference/actions-runner-pricing",
  verifiedAt: "2026-10-06",
} as const;

export const GITHUB_RATES: readonly Rate[] = [
  { runnerClass: "linux_1_slim", os: "linux", vcpu: 1, pricePerMinute: 0.002, multiplier: 1, labels: ["ubuntu-slim"] },
  { runnerClass: "linux_2", os: "linux", vcpu: 2, pricePerMinute: 0.006, multiplier: 1, labels: ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"] },
  { runnerClass: "linux_2_arm", os: "linux", vcpu: 2, pricePerMinute: 0.005, multiplier: 1, labels: ["ubuntu-24.04-arm", "ubuntu-22.04-arm"] },
  { runnerClass: "linux_4", os: "linux", vcpu: 4, pricePerMinute: 0.012, multiplier: 1, labels: [] },
  { runnerClass: "linux_8", os: "linux", vcpu: 8, pricePerMinute: 0.022, multiplier: 1, labels: [] },
  { runnerClass: "linux_16", os: "linux", vcpu: 16, pricePerMinute: 0.042, multiplier: 1, labels: [] },
  { runnerClass: "linux_32", os: "linux", vcpu: 32, pricePerMinute: 0.082, multiplier: 1, labels: [] },
  { runnerClass: "linux_64", os: "linux", vcpu: 64, pricePerMinute: 0.162, multiplier: 1, labels: [] },
  { runnerClass: "windows_2", os: "windows", vcpu: 2, pricePerMinute: 0.01, multiplier: 2, labels: ["windows-latest", "windows-2025", "windows-2022"] },
  { runnerClass: "windows_2_arm", os: "windows", vcpu: 2, pricePerMinute: 0.01, multiplier: 2, labels: ["windows-11-arm"] },
  { runnerClass: "macos_3", os: "macos", vcpu: 3, pricePerMinute: 0.062, multiplier: 10, labels: ["macos-latest", "macos-13", "macos-14", "macos-15", "macos-26"] },
  { runnerClass: "macos_12", os: "macos", vcpu: 12, pricePerMinute: 0.077, multiplier: 10, labels: ["macos-latest-large", "macos-14-large", "macos-15-large"] },
  { runnerClass: "macos_xl", os: "macos", vcpu: 5, pricePerMinute: 0.102, multiplier: 10, labels: ["macos-latest-xlarge", "macos-14-xlarge", "macos-15-xlarge", "macos-26-xlarge"] },
];

/**
 * Minutes a month each GitHub plan includes for GitHub-hosted runners, in private repositories only:
 * public repositories use standard runners free, and larger runners never draw from these. Without a
 * payment method on file, usage is blocked once they are used up. GitHub rounds each job up to the
 * whole minute (actions-runner-pricing).
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

export function githubRateForLabel(label: string): Rate | undefined {
  return GITHUB_RATES.find((r) => r.labels.includes(label));
}
