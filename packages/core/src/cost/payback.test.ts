import { describe, expect, it } from "vitest";
import { machineDaysCents, machineSaving, monthlySaving, payback } from "./payback";
import { classify } from "./classify";
import { vendorRate, XCODE_CLOUD } from "./rates/vendors";

describe("monthlySaving", () => {
  it("is the hosted spend less the plan's monthly fee, with no hardware", () => {
    expect(monthlySaving({ hostedCentsPerMonth: 7500, machineFeeCents: 1000 })).toEqual({ monthlySavingCents: 6500, machinesNeeded: 1 });
    expect(monthlySaving({ hostedCentsPerMonth: 62000, machineFeeCents: 2400 }).monthlySavingCents).toBe(59600);
  });
  it("charges the fee per machine the peak needs, two macOS jobs to a machine", () => {
    expect(monthlySaving({ hostedCentsPerMonth: 10000, machineFeeCents: 2400, peakConcurrency: 4 })).toEqual({ monthlySavingCents: 10000 - 4800, machinesNeeded: 2 });
    expect(monthlySaving({ hostedCentsPerMonth: 10000, machineFeeCents: 2400, peakConcurrency: 3, capacityPerMachine: 1 }).machinesNeeded).toBe(3);
  });
  it("goes to zero or below when the plan costs more than the spend, and is free on Free", () => {
    expect(monthlySaving({ hostedCentsPerMonth: 600, machineFeeCents: 1000 }).monthlySavingCents).toBe(-400);
    expect(monthlySaving({ hostedCentsPerMonth: 0, machineFeeCents: 0 }).monthlySavingCents).toBe(0);
  });
  it("is the same saving the deprecated payback reports", () => {
    const i = { hostedCentsPerMonth: 46000, machineFeeCents: 1000, peakConcurrency: 3 };
    expect(payback(i)).toMatchObject(monthlySaving(i));
  });
});

describe("machineSaving", () => {
  it("charges a machine only for the UTC days it ran a job, never a full month for one job", () => {
    // A temporary machine that ran one job on one day of October on Personal: $10 over 31 days.
    expect(machineSaving({ hostedCents: 1, machineDays: 1, periodDays: 31, machineFeeCents: 1000 })).toEqual({ planCents: 32, savedCents: -31 });
    expect(machineDaysCents(1, 31, 2400)).toBe(77);
  });
  it("is the full monthly price for a machine that ran jobs every day", () => {
    expect(machineSaving({ hostedCents: 2123, machineDays: 30, periodDays: 30, machineFeeCents: 1000 })).toEqual({ planCents: 1000, savedCents: 1123 });
    expect(machineDaysCents(31, 31, 2400)).toBe(2400);
    expect(machineDaysCents(40, 31, 2400)).toBe(2400);
  });
  it("is part of the month so far for a machine that ran some days", () => {
    expect(machineSaving({ hostedCents: 2629, machineDays: 12, periodDays: 31, machineFeeCents: 2400 })).toEqual({ planCents: 929, savedCents: 1700 });
  });
  it("costs nothing on Free, with no days or in an empty period", () => {
    expect(machineDaysCents(5, 31, 0)).toBe(0);
    expect(machineDaysCents(0, 31, 2400)).toBe(0);
    expect(machineDaysCents(3, 0, 2400)).toBe(0);
  });
});

describe("payback (deprecated, compatibility fields only)", () => {
  it("a $620 macOS bill pays off a Mac mini in month two on Team", () => {
    const p = payback({ hostedCentsPerMonth: 62000, machineFeeCents: 2000 });
    expect(p.machinesNeeded).toBe(1);
    expect(p.monthlySavingCents).toBe(60000);
    expect(p.paybackMonths).toBe(2);
  });
  it("needs two Macs for four concurrent jobs and never divides by zero", () => {
    expect(payback({ hostedCentsPerMonth: 1000, machineFeeCents: 2000, peakConcurrency: 4 }).machinesNeeded).toBe(2);
    expect(payback({ hostedCentsPerMonth: 1000, machineFeeCents: 2000 }).paybackMonths).toBeNull();
  });
});

describe("vendor pricing", () => {
  it("prices listed vendor labels from their tables", () => {
    expect(classify(["blacksmith-2vcpu-ubuntu-2404"]).pricePerMinute).toBe(0.004);
    expect(classify(["blacksmith-8vcpu-ubuntu-2404"]).rateConfidence).toBe("medium");
    expect(classify(["depot-ubuntu-24.04-4"]).pricePerMinute).toBe(0.012);
    expect(classify(["warp-ubuntu-latest-arm64-4x"]).pricePerMinute).toBe(0.006);
    expect(classify(["ubicloud-standard-2"]).pricePerMinute).toBe(0.00125);
    expect(classify(["jog"])).toMatchObject({ provider: "jog", os: "linux", arch: "x64", vcpu: 2, pricePerMinute: 0.0012, rateConfidence: "high" });
    expect(classify(["jog-4vcpu"])).toMatchObject({ vcpu: 4, pricePerMinute: 0.0024, rateConfidence: "high" });
    expect(classify(["jog-8vcpu"])).toMatchObject({ vcpu: 8, pricePerMinute: 0.0044, rateConfidence: "high" });
    expect(classify(["jogger"]).provider).toBe("unknown");
    expect(classify(["runs-on=abc/cpu=8/ram=32"]).rateConfidence).toBe("low");
    expect(classify(["namespace-profile-big"]).rateConfidence).toBe("low");
    expect(classify(["buildhound-macos"]).pricePerMinute).toBe(0);
    expect(classify(["depot-windows-2025"]).vcpu).toBe(2);
    expect(classify(["depot-windows-2025-8"]).pricePerMinute).toBe(0.032);
  });
  it("account overrides win", () => {
    expect(classify(["self-hosted"], { self_hosted: 0.002 }).pricePerMinute).toBe(0.002);
    expect(classify(["namespace-profile-big"], { "namespace:namespace-profile-big": 0.05 }).rateConfidence).toBe("high");
  });
  it("vendor tables carry a source and a verified date, and Xcode Cloud is under a cent a minute", () => {
    expect(vendorRate("depot", "macos", "arm64", 6)?.pricePerMinute).toBe(0.08);
    expect(XCODE_CLOUD.pricePerMinute).toBeLessThan(0.01);
  });
});
