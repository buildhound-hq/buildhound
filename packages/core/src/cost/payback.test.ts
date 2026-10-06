import { describe, expect, it } from "vitest";
import { payback } from "./payback";
import { classify } from "./classify";
import { vendorRate, XCODE_CLOUD } from "./rates/vendors";

describe("payback", () => {
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
    expect(classify(["runs-on=abc/cpu=8/ram=32"]).rateConfidence).toBe("low");
    expect(classify(["namespace-profile-big"]).rateConfidence).toBe("low");
    expect(classify(["buildhound-macos"]).pricePerMinute).toBe(0);
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
