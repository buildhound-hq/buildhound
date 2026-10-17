import { describe, expect, it } from "vitest";
import { GITHUB_LABELS_META, GITHUB_MACOS_CONCURRENCY_META, GITHUB_RATES_META } from "./github";
import { MAX_PAGE_PRICES, pagePrices, pageText, rateSources } from "./sources";
import { CI_OFFERS, CIRUN, FLAT_MAC_OFFERS, USHR, VENDOR_TABLES, XCODE_CLOUD } from "./vendors";

describe("rateSources", () => {
  const sources = rateSources();
  const urls = sources.map((s) => s.url);

  it("lists every pricing page once, over https, with a verified date", () => {
    expect(new Set(urls).size).toBe(urls.length);
    for (const s of sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.tables.length).toBeGreaterThan(0);
    }
  });

  it("covers every table and offer that has a price, and nothing else", () => {
    const priced = [
      GITHUB_RATES_META.source,
      ...VENDOR_TABLES.filter((t) => t.provider !== "buildhound").map((t) => t.source),
      XCODE_CLOUD.source,
      ...FLAT_MAC_OFFERS.map((o) => o.source),
      ...CI_OFFERS.map((o) => o.source),
      USHR.source,
      CIRUN.source,
    ];
    for (const url of priced) expect(urls).toContain(url);
    expect(urls).not.toContain("https://buildhound.sh/pricing");
    expect(urls).not.toContain(GITHUB_MACOS_CONCURRENCY_META.source);
    expect(urls).not.toContain(GITHUB_LABELS_META.source);
  });

  it("names the tables a page prices", () => {
    expect(sources.find((s) => s.url === "https://bitrise.io/pricing")?.tables).toEqual(["bitrise_build_hub"]);
    expect(sources.find((s) => s.url === GITHUB_RATES_META.source)?.tables).toEqual(["github"]);
  });
});

describe("pagePrices", () => {
  it("reads amounts React splits with comments, and ignores scripts, styles and markup", () => {
    const html = `<html><head><style>.a:after{content:"$9.99"}</style><script>self.__next_f.push([1,"$1a:$L2 $0.10"])</script></head>
      <body><h2>Linux</h2><p>$<!-- -->0.004<!-- --> per minute</p><td>&#36;0.008</td><td>US$&nbsp;49.99</td>
      <noscript>$5</noscript><span data-price="$7">2,000 minutes</span><p>200 credits a minute</p><p>€1,000 a year</p></body></html>`;
    expect(pagePrices(html)).toEqual(["$0.004", "$0.008", "2,000 minutes", "200 credits", "us$49.99", "€1,000"]);
  });

  it("gives the same list for the same prices in a different layout or order", () => {
    const a = `<div class="x1"><b>$0.016</b> and <b>$0.008</b></div><footer>Updated 2026-10-17 at 12:00</footer>`;
    const b = `<ul><li>$0.008</li><li>$0.016</li><li>$0.008</li></ul><footer>Updated 2026-10-24 at 09:31</footer>`;
    expect(pagePrices(a)).toEqual(pagePrices(b));
  });

  it("is empty for a page its scripts draw", () => {
    expect(pagePrices(`<div id="root"></div><script src="/app.js"></script><script>window.prices={"linux":"$0.004"}</script>`)).toEqual([]);
  });

  it("keeps a bounded number of amounts", () => {
    const many = Array.from({ length: MAX_PAGE_PRICES + 50 }, (_, i) => `<p>$${i}.50</p>`).join("");
    expect(pagePrices(many)).toHaveLength(MAX_PAGE_PRICES);
  });

  it("decodes entities and collapses spaces in the page's text", () => {
    expect(pageText("<p>Fish&amp;chips&#x2C;&nbsp; <i>now</i>\n\n&unknown; </p>")).toBe("Fish&chips, now &unknown;");
  });
});
