/**
 * Every way to run CI the cost model prices beside GitHub-hosted but never routes to, in one shape for
 * `buildhound rates` and the MCP `get_rates` tool: CI services and runner offers priced by the minute or in
 * monthly tiers (CI_OFFERS), macOS sold as a plan or a machine (FLAT_MAC_OFFERS), and orchestrators for runners
 * on the customer's own machines, priced by host or by repository (USHR, CIRUN).
 */
import { CI_OFFERS, CIRUN, FLAT_MAC_OFFERS, USHR, type CiOfferPrice } from "./vendors";

export interface OfferPrice {
  /** Null when the price is not for one OS, as with a price by host or by repository. */
  os: "macos" | "linux" | null;
  /** The machine, plan or count the price is for, as the vendor names it. */
  size: string;
  pricePerMinute: number | null;
  creditsPerMinute: number | null;
  usdPerMonth: number | null;
  /** What one `usdPerMonth` buys when it is not the whole plan: a runner, a Mac or a host. */
  per: string | null;
  /** The least a month costs to use this price at all: the cheapest plan that offers it. */
  floorUsdPerMonth: number | null;
  /** Monthly steps, each covering this many minutes of this size alone. */
  tiers: Array<{ minutes: number; usd: number }> | null;
}

export interface ComparisonOffer {
  vendor: string;
  name: string;
  kind: "ci_offer" | "flat_mac" | "orchestrator";
  source: string;
  verifiedAt: string;
  freeMinutesPerMonth: number | null;
  usdPerCredit: number | null;
  prices: OfferPrice[];
  notes: string;
}

const price = (p: Partial<OfferPrice> & Pick<OfferPrice, "os" | "size">): OfferPrice => ({
  os: p.os,
  size: p.size,
  pricePerMinute: p.pricePerMinute ?? null,
  creditsPerMinute: p.creditsPerMinute ?? null,
  usdPerMonth: p.usdPerMonth ?? null,
  per: p.per ?? null,
  floorUsdPerMonth: p.floorUsdPerMonth ?? null,
  tiers: p.tiers ?? null,
});

const ciPrice = (os: "macos" | "linux", p: CiOfferPrice): OfferPrice =>
  price({
    os,
    size: p.size,
    pricePerMinute: p.pricePerMinute,
    creditsPerMinute: p.creditsPerMinute ?? null,
    floorUsdPerMonth: p.floorUsdPerMonth ?? null,
    tiers: p.tiers ? p.tiers.map((t) => ({ minutes: t.minutes, usd: t.usd })) : null,
  });

export function comparisonOffers(): ComparisonOffer[] {
  const ci: ComparisonOffer[] = CI_OFFERS.map((o) => ({
    vendor: o.vendor,
    name: o.name,
    kind: "ci_offer",
    source: o.source,
    verifiedAt: o.verifiedAt,
    freeMinutesPerMonth: o.freeMinutesPerMonth ?? null,
    usdPerCredit: o.usdPerCredit ?? null,
    prices: [...(o.macos ? [ciPrice("macos", o.macos)] : []), ...(o.linux ? [ciPrice("linux", o.linux)] : [])],
    notes: o.notes,
  }));
  const flat: ComparisonOffer[] = FLAT_MAC_OFFERS.map((o) => ({
    vendor: o.vendor,
    name: o.name,
    kind: "flat_mac",
    source: o.source,
    verifiedAt: o.verifiedAt,
    freeMinutesPerMonth: null,
    usdPerCredit: null,
    prices: [price({ os: "macos", size: o.hardware, usdPerMonth: o.usdPerMonth, per: o.unit })],
    notes: o.notes,
  }));
  const ushr: ComparisonOffer = {
    vendor: "ushr",
    name: "ushr",
    kind: "orchestrator",
    source: USHR.source,
    verifiedAt: USHR.verifiedAt,
    freeMinutesPerMonth: null,
    usdPerCredit: null,
    prices: [
      price({ os: null, size: `Free, ${USHR.freeHosts} host`, usdPerMonth: 0 }),
      price({ os: null, size: `Pro, ${USHR.proIncludedHosts} hosts`, usdPerMonth: USHR.proUsdPerMonth }),
      price({ os: null, size: `Each host above ${USHR.proIncludedHosts}, up to ${USHR.maxHosts}`, usdPerMonth: USHR.extraHostUsd, per: "host" }),
    ],
    notes: USHR.notes,
  };
  const cirun: ComparisonOffer = {
    vendor: "cirun",
    name: "Cirun",
    kind: "orchestrator",
    source: CIRUN.source,
    verifiedAt: CIRUN.verifiedAt,
    freeMinutesPerMonth: null,
    usdPerCredit: null,
    prices: [price({ os: null, size: "Public repositories", usdPerMonth: 0 }), ...CIRUN.tiers.map((t) => price({ os: null, size: `Up to ${t.privateRepos} private repositories`, usdPerMonth: t.usd }))],
    notes: CIRUN.notes,
  };
  return [...ci, ...flat, ushr, cirun];
}
