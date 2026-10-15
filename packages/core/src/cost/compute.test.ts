import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import { computeJobCost } from "./compute";
import { githubRateForLabel } from "./rates/github";

const t = (s: string) => new Date(s);

describe("computeJobCost", () => {
  it("rounds up to the minute and charges a minimum of one minute", () => {
    const c = computeJobCost({ startedAt: t("2026-01-01T00:00:00Z"), completedAt: t("2026-01-01T00:00:05Z") }, 0.006, 1);
    expect(c.rawMinutes).toBe(1);
    expect(c.billableCents).toBe(1); // 0.006 × 100 = 0.6 cents, rounds to 1
  });
  it("draws included minutes at list price for macOS but charges the list price in cents", () => {
    const macos = githubRateForLabel("macos-latest")!;
    const c = computeJobCost({ startedAt: t("2026-01-01T00:00:00Z"), completedAt: t("2026-01-01T00:10:00Z") }, macos.pricePerMinute, macos.multiplier);
    expect(c.rawMinutes).toBe(10);
    expect(c.billableMinutes).toBe(103); // 10 × $0.062 / $0.006, rounded
    expect(c.billableCents).toBe(62);
  });
  it("keeps billable minutes whole for fractional draws", () => {
    const windows = githubRateForLabel("windows-latest")!;
    const c = computeJobCost({ startedAt: t("2026-01-01T00:00:00Z"), completedAt: t("2026-01-01T00:10:00Z") }, windows.pricePerMinute, windows.multiplier);
    expect(c.billableMinutes).toBe(17);
    expect(Number.isInteger(c.billableMinutes)).toBe(true);
  });
  it("spans midnight UTC without losing minutes", () => {
    const c = computeJobCost({ startedAt: t("2026-01-01T23:59:30Z"), completedAt: t("2026-01-02T00:00:31Z") }, 0.006, 1);
    expect(c.durationSeconds).toBe(61);
    expect(c.rawMinutes).toBe(2);
  });
  it("a job that never started costs nothing", () => {
    expect(computeJobCost({ startedAt: null, completedAt: null }, 0.062, 10).billableCents).toBe(0);
  });
});

describe("classify", () => {
  it("prices ubuntu-latest from the GitHub table", () => {
    const c = classify(["ubuntu-latest"]);
    expect(c.provider).toBe("github");
    expect(c.pricePerMinute).toBe(0.006);
    expect(c.rateConfidence).toBe("high");
  });
  it("recognises a Blacksmith label even when self-hosted is also present", () => {
    const c = classify(["self-hosted", "blacksmith-4vcpu-ubuntu-2404"]);
    expect(c.provider).toBe("blacksmith");
    expect(c.vcpu).toBe(4);
    expect(c.os).toBe("linux");
  });
  it("recognises Buildhound labels", () => {
    expect(classify(["buildhound-macos"]).provider).toBe("buildhound");
    expect(classify(["buildhound-macos"]).os).toBe("macos");
  });
  it("never prices an unknown label at zero", () => {
    const c = classify(["my-custom-runner"]);
    expect(c.provider).toBe("unknown");
    expect(c.pricePerMinute).toBeGreaterThan(0);
    expect(c.rateConfidence).toBe("low");
  });
});
