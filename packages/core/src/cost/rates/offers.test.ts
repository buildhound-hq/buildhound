import { describe, expect, it } from "vitest";
import { comparisonOffers } from "./offers";
import { CI_OFFERS, CIRUN, FLAT_MAC_OFFERS, USHR } from "./vendors";

describe("comparisonOffers", () => {
  const offers = comparisonOffers();

  it("lists every CI offer, flat macOS plan and orchestrator once, with its source and date", () => {
    expect(offers.map((o) => o.vendor)).toEqual([...CI_OFFERS.map((o) => o.vendor), ...FLAT_MAC_OFFERS.map((o) => o.vendor), "ushr", "cirun"]);
    for (const o of offers) {
      expect(o.source).toMatch(/^https:\/\//);
      expect(o.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.prices.length).toBeGreaterThan(0);
    }
  });

  it("prices every CI offer above zero a minute, in the core's numbers", () => {
    for (const o of offers.filter((x) => x.kind === "ci_offer")) {
      for (const p of o.prices) expect(p.pricePerMinute, `${o.vendor} ${p.os}`).toBeGreaterThan(0);
    }
    const circle = offers.find((o) => o.vendor === "circleci")!;
    expect(circle.prices.find((p) => p.os === "macos")).toMatchObject({ creditsPerMinute: 200, floorUsdPerMonth: 15 });
    expect(offers.find((o) => o.vendor === "bitrise_build_hub")!.prices[0]!.tiers).toEqual(CI_OFFERS.find((o) => o.vendor === "bitrise_build_hub")!.macos!.tiers);
  });

  it("gives flat plans and orchestrators by the month, with what one price buys", () => {
    expect(offers.find((o) => o.vendor === "manzanita")!.prices).toEqual([expect.objectContaining({ os: "macos", usdPerMonth: FLAT_MAC_OFFERS[0]!.usdPerMonth, per: "runner", pricePerMinute: null })]);
    expect(offers.find((o) => o.vendor === "ushr")!.prices.map((p) => [p.usdPerMonth, p.per])).toEqual([[0, null], [USHR.proUsdPerMonth, null], [USHR.extraHostUsd, "host"]]);
    expect(offers.find((o) => o.vendor === "cirun")!.prices.map((p) => p.usdPerMonth)).toEqual([0, ...CIRUN.tiers.map((t) => t.usd)]);
  });
});
