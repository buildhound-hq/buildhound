import { describe, expect, it } from "vitest";
import { CI_OFFERS, CIRUN, USHR, VENDOR_TABLES, ciOffer, ushrMonthlyUsd, vendorRate } from "./vendors";

describe("vendor tables", () => {
  it("prices ushr by host: one free, three for the Pro price, then each extra host", () => {
    expect(ushrMonthlyUsd(1)).toBe(0);
    expect(ushrMonthlyUsd(3)).toBe(USHR.proUsdPerMonth);
    expect(ushrMonthlyUsd(5)).toBe(USHR.proUsdPerMonth + 2 * USHR.extraHostUsd);
    expect(ushrMonthlyUsd(USHR.maxHosts + 1)).toBeNull();
  });

  it("lists Depot's macOS runner at its real size and every plan with the runners it offers", () => {
    expect(vendorRate("depot", "macos", "arm64", 3)).toMatchObject({ vcpu: 8, pricePerMinute: 0.08 });
    const depot = VENDOR_TABLES.find((t) => t.provider === "depot")!;
    expect(depot.plans?.find((p) => p.os.includes("macos"))?.usdPerMonth).toBe(200);
  });

  it("gives every table and offer a source and a verified date", () => {
    for (const t of [...VENDOR_TABLES, USHR, CIRUN, ...CI_OFFERS]) {
      expect(t.source).toMatch(/^https:\/\//);
      expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("prices CircleCI from its credits, and Bitrise's tiers by its own per-minute prices, ascending", () => {
    const circle = ciOffer("circleci");
    expect(circle.macos!.pricePerMinute).toBeCloseTo(circle.macos!.creditsPerMinute! * circle.usdPerCredit!, 10);
    expect(circle.macos!.pricePerMinute).toBeCloseTo(0.12, 10);
    const bitrise = ciOffer("bitrise_build_hub");
    for (const os of ["macos", "linux"] as const) {
      const tiers = bitrise[os]!.tiers!;
      expect(tiers.map((t) => t.minutes)).toEqual([...tiers.map((t) => t.minutes)].sort((a, b) => a - b));
    }
    expect(bitrise.macos!.tiers!.find((t) => t.usd === 180)!.minutes).toBe(6000);
    expect(bitrise.linux!.tiers!.find((t) => t.usd === 810)!.minutes).toBe(64800);
    expect(ciOffer("codebuild").macos).toBeUndefined();
  });
});
