import { describe, expect, it } from "vitest";
import { GITHUB_INCLUDED_MINUTES, GITHUB_INCLUDED_MINUTES_META, GITHUB_RATES, GITHUB_RATES_META } from "./github";

describe("GitHub rates", () => {
  it("carries a source and a verified date for rates and included minutes (rule 4)", () => {
    for (const meta of [GITHUB_RATES_META, GITHUB_INCLUDED_MINUTES_META]) {
      expect(meta.source).toMatch(/^https:\/\/docs\.github\.com\//);
      expect(meta.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("includes whole minutes per plan, more on paid plans", () => {
    expect(Object.values(GITHUB_INCLUDED_MINUTES).every((m) => Number.isInteger(m) && m > 0)).toBe(true);
    expect(GITHUB_INCLUDED_MINUTES.free).toBeLessThan(GITHUB_INCLUDED_MINUTES.team);
    expect(GITHUB_INCLUDED_MINUTES.team).toBeLessThan(GITHUB_INCLUDED_MINUTES.enterpriseCloud);
  });

  it("labels each standard runner once", () => {
    const labels = GITHUB_RATES.flatMap((r) => r.labels);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
