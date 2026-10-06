import { Command } from "commander";
import { GITHUB_RATES, GITHUB_RATES_META } from "@buildhound/core";
import { emit } from "../output";

export function ratesCommand(): Command {
  return new Command("rates")
    .description("Print the rate tables the cost model uses, with source and verified date")
    .option("--provider <name>", "only this provider")
    .option("--json", "JSON output")
    .action((opts: { provider?: string; json?: boolean }) => {
      const tables = [{ ...GITHUB_RATES_META, rates: GITHUB_RATES }].filter((t) => !opts.provider || t.provider === opts.provider);
      emit({ tables, next: "buildhound scan --repo <owner/name>" }, opts, (v: { tables: typeof tables }) =>
        v.tables.map((t) => `${t.provider} (verified ${t.verifiedAt})\n` + t.rates.map((r) => `  ${r.runnerClass.padEnd(14)} $${r.pricePerMinute.toFixed(3)}/min  x${r.multiplier}`).join("\n")).join("\n"),
      );
    });
}
