import { Command } from "commander";
import { comparisonOffers, GITHUB_RATES, GITHUB_RATES_META, VENDOR_TABLES, XCODE_CLOUD, type ComparisonOffer } from "@buildhound/core";
import { EXIT, Provider } from "@buildhound/shared";
import { loadConfig } from "../lib/config";
import { CliError, emit } from "../output";
import { color, next, table } from "../lib/style";

export interface RateRow {
  os: string;
  arch: string | null;
  vcpu: number;
  pricePerMinute: number;
  multiplier: number | null;
  labels: string[] | null;
  runnerClass: string | null;
  derived: boolean;
}

export interface RateTable {
  provider: string;
  source: string;
  verifiedAt: string;
  effectiveFrom: string | null;
  notes: string;
  rates: RateRow[];
  tiers: Array<{ hours: number; usd: number }> | null;
}

export interface RatesResult {
  tables: RateTable[];
  /** CI services, flat macOS plans and orchestrators, priced for comparison and never a routing target. */
  offers: ComparisonOffer[];
  overrides: Record<string, number>;
  next: string;
}

export function allTables(): RateTable[] {
  const github: RateTable = {
    provider: GITHUB_RATES_META.provider,
    source: GITHUB_RATES_META.source,
    verifiedAt: GITHUB_RATES_META.verifiedAt,
    effectiveFrom: GITHUB_RATES_META.effectiveFrom,
    notes: "USD per minute on private repositories; free on public repositories. Multiplier is the included minutes one minute draws: GitHub counts them in Linux 2-core minutes at list price, and larger runners draw none.",
    rates: GITHUB_RATES.map((r) => ({ os: r.os, arch: r.runnerClass.endsWith("_arm") || r.os === "macos" ? "arm64" : "x64", vcpu: r.vcpu, pricePerMinute: r.pricePerMinute, multiplier: Number(r.multiplier.toFixed(4)), labels: [...r.labels], runnerClass: r.runnerClass, derived: false })),
    tiers: null,
  };
  const vendors: RateTable[] = VENDOR_TABLES.map((t) => ({
    provider: t.provider,
    source: t.source,
    verifiedAt: t.verifiedAt,
    effectiveFrom: null,
    notes: t.notes,
    rates: t.rates.map((r) => ({ os: r.os, arch: r.arch, vcpu: r.vcpu, pricePerMinute: r.pricePerMinute, multiplier: null, labels: null, runnerClass: null, derived: Boolean(r.derived) })),
    tiers: null,
  }));
  const xcode: RateTable = {
    provider: "xcode_cloud",
    source: XCODE_CLOUD.source,
    verifiedAt: XCODE_CLOUD.verifiedAt,
    effectiveFrom: null,
    notes: "Not a GitHub Actions runner; shown as a comparison for macOS jobs only. Marginal price is the 100-hour tier.",
    rates: [{ os: "macos", arch: "arm64", vcpu: 0, pricePerMinute: XCODE_CLOUD.pricePerMinute, multiplier: null, labels: null, runnerClass: null, derived: true }],
    tiers: XCODE_CLOUD.tiers.map((t) => ({ hours: t.hours, usd: t.usd })),
  };
  return [github, ...vendors, xcode];
}

export function runRates(opts: { provider?: string | undefined }, cwd = process.cwd()): RatesResult {
  const next = "buildhound scan .";
  const all = comparisonOffers();
  const known = [...new Set([...Provider.options, "xcode_cloud", ...all.map((o) => o.vendor)])];
  if (opts.provider && !known.includes(opts.provider)) throw new CliError("UNKNOWN_PROVIDER", `unknown provider "${opts.provider}"; known providers are ${known.join(", ")}`, "buildhound rates", EXIT.usage);
  const tables = allTables().filter((t) => !opts.provider || t.provider === opts.provider);
  const offers = all.filter((o) => !opts.provider || o.vendor === opts.provider);
  if (!tables.length && !offers.length) throw new CliError("NO_RATE_TABLE", `no rate table for ${opts.provider}; it is priced from account overrides only`, "buildhound rates", EXIT.usage);
  const config = loadConfig(cwd);
  return { tables, offers, overrides: config.overrides, next };
}

export function prettyRates(r: RatesResult): string {
  const out: string[] = [];
  for (const t of r.tables) {
    out.push(color.bold(t.provider), color.dim(`Verified ${t.verifiedAt}, ${t.source}`));
    if (t.notes) out.push(t.notes);
    const multiplier = t.rates.some((x) => x.multiplier !== null);
    const labels = t.rates.some((x) => x.labels?.length);
    const head = ["RUNNER", "OS", "ARCH", "VCPU", "$/MIN", ...(multiplier ? ["MULTIPLIER"] : []), ...(labels ? ["LABELS"] : []), "NOTE"];
    const rows = t.rates.map((x) => [
      x.runnerClass ?? "",
      x.os,
      x.arch ?? "",
      x.vcpu ? String(x.vcpu) : "",
      `$${x.pricePerMinute.toFixed(4)}`,
      ...(multiplier ? [x.multiplier === null ? "" : `x${Number(x.multiplier.toFixed(2))}`] : []),
      ...(labels ? [x.labels?.join(", ") ?? ""] : []),
      x.derived ? "derived" : "",
    ]);
    const used = head.map((_, i) => rows.some((row) => row[i] !== ""));
    const keep = <T,>(xs: T[]) => xs.filter((_, i) => used[i]);
    const rightCols = keep(head).flatMap((h, i) => (h === "VCPU" || h === "$/MIN" || h === "MULTIPLIER" ? [i] : []));
    out.push("", ...table(keep(head), rows.map(keep), { right: rightCols }));
    if (t.tiers) out.push("", ...table(["HOURS", "PRICE"], t.tiers.map((x) => [String(x.hours), `$${x.usd}`]), { right: [0, 1] }));
    out.push("");
  }
  if (r.offers.length) out.push(color.bold("Compared only, never a routing target"), "");
  for (const o of r.offers) out.push(...prettyOffer(o));
  const overrides = Object.entries(r.overrides);
  if (overrides.length) out.push("Your overrides from buildhound.toml", "", ...table(["RUNNER", "$/MIN"], overrides.map(([k, v]) => [k, `$${v.toFixed(4)}`]), { right: [1] }), "");
  out.push(next(r.next));
  return out.join("\n");
}

const usd = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2)}`;

function prettyOffer(o: ComparisonOffer): string[] {
  const out = [color.bold(o.vendor), color.dim(`Verified ${o.verifiedAt}, ${o.source}`), o.notes];
  const head = ["SIZE", "OS", "$/MIN", "CREDITS/MIN", "$/MONTH", "FROM"];
  const rows = o.prices.map((p) => [
    p.size,
    p.os ?? "",
    p.pricePerMinute === null ? "" : `$${p.pricePerMinute.toFixed(4)}`,
    p.creditsPerMinute === null ? "" : String(p.creditsPerMinute),
    p.usdPerMonth === null ? "" : p.per ? `${usd(p.usdPerMonth)} a ${p.per}` : usd(p.usdPerMonth),
    p.floorUsdPerMonth === null ? "" : `${usd(p.floorUsdPerMonth)} a month`,
  ]);
  const used = head.map((_, i) => rows.some((row) => row[i] !== ""));
  const keep = <T,>(xs: T[]) => xs.filter((_, i) => used[i]);
  const rightCols = keep(head).flatMap((h, i) => (h === "$/MIN" || h === "CREDITS/MIN" ? [i] : []));
  out.push("", ...table(keep(head), rows.map(keep), { right: rightCols }));
  const tiered = o.prices.filter((p) => p.tiers);
  if (tiered.length) out.push("", ...table(["OS", "MINUTES", "PRICE"], tiered.flatMap((p) => p.tiers!.map((t) => [p.os ?? "", t.minutes.toLocaleString("en-US"), usd(t.usd)])), { right: [1, 2] }));
  out.push("");
  return out;
}

export function ratesCommand(): Command {
  return new Command("rates")
    .description("Print the rate tables the cost model uses, and the offers it compares, with source and verified date")
    .option("--provider <name>", "only this provider")
    .option("--json", "JSON output")
    .action((opts: { provider?: string; json?: boolean }) => {
      emit(runRates(opts), opts, prettyRates);
    });
}
