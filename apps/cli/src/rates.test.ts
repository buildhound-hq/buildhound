import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allTables, prettyRates, runRates } from "./commands/rates";
import { stripAnsi } from "./lib/style";

describe("rates", () => {
  const github = allTables().find((t) => t.provider === "github")!;
  const row = (runnerClass: string) => github.rates.find((r) => r.runnerClass === runnerClass)!;

  it("gives the included minutes one minute draws, at list price, and none for larger runners", () => {
    expect(row("linux_2").multiplier).toBe(1);
    expect(row("macos_3").multiplier).toBe(10.3333);
    expect(row("windows_2").multiplier).toBe(1.6667);
    expect(row("macos_xl").multiplier).toBe(0);
  });

  it("prints the multiplier to two decimals", () => {
    const out = stripAnsi(prettyRates({ tables: [github], offers: [], overrides: {}, next: "buildhound scan ." }));
    const line = (label: string) => out.split("\n").find((l) => l.includes(label)) ?? "";
    expect(line("macos-latest,")).toContain("x10.33");
    expect(line("windows-latest")).toContain("x1.67");
    expect(line("ubuntu-latest")).toMatch(/x1\b/);
  });

  it("adds the offers it compares, and filters them by vendor", () => {
    const dir = mkdtempSync(join(tmpdir(), "bh-rates-"));
    const all = runRates({}, dir);
    expect(all.offers.map((o) => o.vendor)).toEqual(expect.arrayContaining(["codemagic", "circleci", "buildkite", "bitrise_build_hub", "codebuild", "manzanita", "macrun", "ushr", "cirun"]));
    const one = runRates({ provider: "manzanita" }, dir);
    expect(one.tables).toEqual([]);
    expect(one.offers.map((o) => o.vendor)).toEqual(["manzanita"]);
    expect(runRates({ provider: "ubicloud" }, dir).offers).toEqual([]);
    expect(() => runRates({ provider: "nope" }, dir)).toThrow(/codemagic/);
  });

  it("prints an offer's prices by the minute, in credits and by the month", () => {
    const dir = mkdtempSync(join(tmpdir(), "bh-rates-"));
    const out = (provider: string) => stripAnsi(prettyRates(runRates({ provider }, dir)));
    expect(out("circleci")).toMatch(/M4 Pro Medium, 6 CPU, 28 GB\s+macos\s+\$0\.1200\s+200\s+\$15 a month/);
    expect(out("manzanita")).toMatch(/M4 Pro, 6 vCPU, 22 GB\s+macos\s+\$149 a runner/);
    expect(out("bitrise_build_hub")).toMatch(/linux\s+64,800\s+\$810/);
    expect(out("cirun")).toContain("Compared only, never a routing target");
  });
});
