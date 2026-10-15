import { describe, expect, it } from "vitest";
import { allTables, prettyRates } from "./commands/rates";
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
    const out = stripAnsi(prettyRates({ tables: [github], overrides: {}, next: "buildhound scan ." }));
    const line = (label: string) => out.split("\n").find((l) => l.includes(label)) ?? "";
    expect(line("macos-latest,")).toContain("x10.33");
    expect(line("windows-latest")).toContain("x1.67");
    expect(line("ubuntu-latest")).toMatch(/x1\b/);
  });
});
