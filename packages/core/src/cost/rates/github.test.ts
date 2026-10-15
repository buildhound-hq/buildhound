import { describe, expect, it } from "vitest";
import {
  GITHUB_INCLUDED_DRAW_META,
  GITHUB_INCLUDED_MINUTE_PRICE,
  GITHUB_INCLUDED_MINUTES,
  GITHUB_INCLUDED_MINUTES_META,
  GITHUB_RATES,
  GITHUB_RATES_META,
  githubIncludedMinutesDrawn,
  githubRateForLabel,
} from "./github";

const rate = (label: string) => githubRateForLabel(label)!;
const byClass = (runnerClass: string) => GITHUB_RATES.find((r) => r.runnerClass === runnerClass)!;

describe("GitHub rates", () => {
  it("carries a source and a verified date for rates, included minutes and how they are drawn (rule 4)", () => {
    for (const meta of [GITHUB_RATES_META, GITHUB_INCLUDED_MINUTES_META, GITHUB_INCLUDED_DRAW_META]) {
      expect(meta.source).toMatch(/^https:\/\/(docs\.github\.com|github\.blog)\//);
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

describe("included minutes drawn", () => {
  it("counts the allowance in Linux 2-core minutes", () => {
    expect(GITHUB_INCLUDED_MINUTE_PRICE).toBe(rate("ubuntu-latest").pricePerMinute);
    expect(rate("ubuntu-latest").multiplier).toBe(1);
  });

  it("draws standard runners at list price, not GitHub's retired 2x and 10x table", () => {
    expect(rate("macos-latest").multiplier).toBeCloseTo(0.062 / 0.006, 10);
    expect(rate("windows-latest").multiplier).toBeCloseTo(0.01 / 0.006, 10);
    expect(rate("ubuntu-24.04-arm").multiplier).toBeCloseTo(0.005 / 0.006, 10);
    expect(rate("ubuntu-slim").multiplier).toBeCloseTo(0.002 / 0.006, 10);
  });

  it("never lets a larger runner draw included minutes", () => {
    for (const c of ["linux_4", "linux_8", "linux_16", "linux_32", "linux_64", "macos_12", "macos_xl"]) expect(byClass(c).multiplier).toBe(0);
    expect(rate("macos-latest-xlarge").multiplier).toBe(0);
  });

  it("rounds the draw to whole minutes", () => {
    expect(githubIncludedMinutesDrawn(10, rate("macos-latest"))).toBe(103);
    expect(githubIncludedMinutesDrawn(24, rate("macos-latest"))).toBe(248);
    expect(githubIncludedMinutesDrawn(10, rate("windows-latest"))).toBe(17);
    expect(githubIncludedMinutesDrawn(4, rate("ubuntu-latest"))).toBe(4);
    expect(githubIncludedMinutesDrawn(30, rate("macos-latest-large"))).toBe(0);
  });

  it("covers 193 macOS minutes with GitHub Free's 2,000 included minutes", () => {
    const macos = rate("macos-latest");
    expect(Math.floor(GITHUB_INCLUDED_MINUTES.free / macos.multiplier)).toBe(193);
    expect(githubIncludedMinutesDrawn(194, macos)).toBe(2005);
  });
});
