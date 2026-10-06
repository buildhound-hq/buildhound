import { Command } from "commander";
import { GITHUB_RATES, GITHUB_RATES_META, VENDOR_TABLES, XCODE_CLOUD } from "@buildhound/core";
import { EXIT, Provider } from "@buildhound/shared";
import { loadConfig } from "../lib/config";
import { CliError, emit } from "../output";

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
  overrides: Record<string, number>;
  next: string;
}

export function allTables(): RateTable[] {
  const github: RateTable = {
    provider: GITHUB_RATES_META.provider,
    source: GITHUB_RATES_META.source,
    verifiedAt: GITHUB_RATES_META.verifiedAt,
    effectiveFrom: GITHUB_RATES_META.effectiveFrom,
    notes: "USD per minute on private repositories; free on public repositories. Multiplier is what one minute consumes from included minutes.",
    rates: GITHUB_RATES.map((r) => ({ os: r.os, arch: r.runnerClass.endsWith("_arm") || r.os === "macos" ? "arm64" : "x64", vcpu: r.vcpu, pricePerMinute: r.pricePerMinute, multiplier: r.multiplier, labels: [...r.labels], runnerClass: r.runnerClass, derived: false })),
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
  const known = [...Provider.options, "xcode_cloud"];
  if (opts.provider && !known.includes(opts.provider)) throw new CliError("UNKNOWN_PROVIDER", `unknown provider "${opts.provider}"; known providers are ${known.join(", ")}`, "buildhound rates", EXIT.usage);
  const tables = allTables().filter((t) => !opts.provider || t.provider === opts.provider);
  if (!tables.length) throw new CliError("NO_RATE_TABLE", `no rate table for ${opts.provider}; it is priced from account overrides only`, "buildhound rates", EXIT.usage);
  const config = loadConfig(cwd);
  return { tables, overrides: config.overrides, next };
}

export function prettyRates(r: RatesResult): string {
  const out: string[] = [];
  for (const t of r.tables) {
    out.push(`${t.provider} (verified ${t.verifiedAt}, ${t.source})`);
    if (t.notes) out.push(`  ${t.notes}`);
    for (const row of t.rates) {
      const name = row.runnerClass ?? `${row.os}_${row.arch ?? ""}_${row.vcpu}`;
      out.push(`  ${name.padEnd(18)} $${row.pricePerMinute.toFixed(4)}/min${row.multiplier !== null ? `  x${row.multiplier}` : ""}${row.derived ? "  (derived)" : ""}${row.labels?.length ? `  ${row.labels.join(", ")}` : ""}`);
    }
    if (t.tiers) for (const tier of t.tiers) out.push(`  ${String(tier.hours).padStart(6)} hours  $${tier.usd}`);
    out.push("");
  }
  const overrides = Object.entries(r.overrides);
  if (overrides.length) out.push("Account overrides from buildhound.toml:", ...overrides.map(([k, v]) => `  ${k.padEnd(30)} $${v.toFixed(4)}/min`), "");
  out.push(`next: ${r.next}`);
  return out.join("\n");
}

export function ratesCommand(): Command {
  return new Command("rates")
    .description("Print the rate tables the cost model uses, with source and verified date")
    .option("--provider <name>", "only this provider")
    .option("--json", "JSON output")
    .action((opts: { provider?: string; json?: boolean }) => {
      emit(runRates(opts), opts, prettyRates);
    });
}
