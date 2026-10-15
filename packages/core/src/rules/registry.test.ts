import { describe, expect, it } from "vitest";
import { RULES, ruleById } from "./registry";

describe("rule registry", () => {
  it("has nineteen rules with unique ids and slugs", () => {
    expect(RULES).toHaveLength(19);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(19);
    expect(new Set(RULES.map((r) => r.slug)).size).toBe(19);
  });
  it("ids are R01 style", () => {
    for (const r of RULES) expect(r.id).toMatch(/^R\d{2}$/);
  });
  it("the behaviour-changing rules are R02, R04, R10, R13, R14, R15, R16, R18, R19", () => {
    expect(RULES.filter((r) => r.changesBehaviour).map((r) => r.id)).toEqual(["R02", "R04", "R10", "R13", "R14", "R15", "R16", "R18", "R19"]);
  });
  it("looks up a rule by id", () => {
    expect(ruleById("R03")?.slug).toBe("cancel-in-progress");
    expect(ruleById("R99")).toBeUndefined();
  });
});
