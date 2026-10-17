/**
 * The pricing pages every rate in this folder was read from, and the prices on such a page, for the API's weekly
 * price watch (COST_MODEL.md, "Price watch"). The watch reads each page, compares the prices with last week's and
 * raises an internal alert when they differ; a person then checks the page and changes a rate by a reviewed
 * commit. Nothing here changes a rate. Pure: the API fetches the pages.
 */
import { GITHUB_INCLUDED_DRAW_META, GITHUB_INCLUDED_MINUTES_META, GITHUB_RATES_META } from "./github";
import { CI_OFFERS, CIRUN, FLAT_MAC_OFFERS, USHR, VENDOR_TABLES, XCODE_CLOUD } from "./vendors";

export interface RateSource {
  url: string;
  /** The tables and offers priced from this page: a provider or vendor id. */
  tables: string[];
  /** The oldest verified date among them. */
  verifiedAt: string;
}

/**
 * One entry per pricing page, in table order. Leaves out Buildhound's own pricing page, and GitHub's limits and
 * labels pages, which hold no price.
 */
export function rateSources(): RateSource[] {
  const cited: Array<{ table: string; source: string; verifiedAt: string }> = [
    { table: "github", ...GITHUB_RATES_META },
    { table: "github", ...GITHUB_INCLUDED_DRAW_META },
    { table: "github", ...GITHUB_INCLUDED_MINUTES_META },
    ...VENDOR_TABLES.filter((t) => t.provider !== "buildhound").map((t) => ({ table: t.provider, source: t.source, verifiedAt: t.verifiedAt })),
    { table: "xcode_cloud", ...XCODE_CLOUD },
    ...FLAT_MAC_OFFERS.map((o) => ({ table: o.vendor, source: o.source, verifiedAt: o.verifiedAt })),
    ...CI_OFFERS.map((o) => ({ table: o.vendor, source: o.source, verifiedAt: o.verifiedAt })),
    { table: "ushr", ...USHR },
    { table: "cirun", ...CIRUN },
  ];
  const byUrl = new Map<string, RateSource>();
  for (const c of cited) {
    const seen = byUrl.get(c.source);
    if (!seen) byUrl.set(c.source, { url: c.source, tables: [c.table], verifiedAt: c.verifiedAt });
    else {
      if (!seen.tables.includes(c.table)) seen.tables.push(c.table);
      if (c.verifiedAt < seen.verifiedAt) seen.verifiedAt = c.verifiedAt;
    }
  }
  return [...byUrl.values()];
}

const NAMED: Record<string, string> = { amp: "&", nbsp: " ", dollar: "$", euro: "€", pound: "£", lt: "<", gt: ">", quot: '"', apos: "'", comma: "," };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** A page's visible text: no scripts, styles, comments or tags, entities decoded, spaces collapsed. */
export function pageText(html: string): string {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(visible).replace(/\s+/g, " ").trim();
}

/*
 * A money amount ($0.004, US$49, €1,000, 49.99 USD) or an amount of credits or minutes (200 credits, 2,000 minutes).
 * The sign and the number may be split by spaces, as React leaves them once its comments are gone.
 */
const AMOUNT = /(?:US\s?\$|\$|€|£)\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s?[km]\b)?|\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?(?:USD|EUR|€|credits?|minutes?|mins?)\b/gi;

/** At most this many amounts are kept for a page; a page with more is still compared on these. */
export const MAX_PAGE_PRICES = 300;

/**
 * The distinct amounts on a pricing page, normalised and sorted: what the price watch compares week to week.
 * Text that changes on every visit (dates, counters, scripts) is not an amount, so an unchanged page gives the
 * same list. Empty when the page shows no amount, as a page drawn by its scripts does.
 */
export function pagePrices(html: string): string[] {
  const found = new Set<string>();
  for (const m of pageText(html).matchAll(AMOUNT)) {
    found.add(m[0].replace(/\s+/g, " ").replace(/^(US\s?\$|\$|€|£) /i, "$1").replace(/^US \$/i, "US$").toLowerCase());
  }
  return [...found].sort().slice(0, MAX_PAGE_PRICES);
}
