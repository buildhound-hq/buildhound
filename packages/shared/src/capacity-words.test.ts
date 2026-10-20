import { describe, expect, it } from "vitest";
import { capacityNext, capacitySentence, capacityShort, runsAtOnce, slotsWords, waitWords } from "./capacity-words";

const line = (over: Partial<Parameters<typeof capacitySentence>[0]> = {}) => ({ label: "buildhound-macos", slots: 1, machines: [{ id: "m1", name: "Benys-Mac-mini", slots: 1 }], peak_demand: 5, saturated_minutes: 40, wait_seconds_from_saturation: 2280, ...over });

describe("the capacity line's words (THROUGHPUT.md)", () => {
  it("says the wait, the slots and the machines in one sentence", () => {
    expect(capacitySentence(line())).toBe("macOS jobs waited 38 min this week for one slot on Benys-Mac-mini");
    expect(capacitySentence(line({ label: "buildhound-linux-arm64", slots: 4, machines: [{ id: "a", name: "mini", slots: 3 }, { id: "b", name: "book", slots: 1 }], wait_seconds_from_saturation: 4000 }))).toBe("Linux arm64 jobs waited 1 h 7 min this week for four slots on mini and book");
    expect(slotsWords({ slots: 12, machines: [{ id: "a", name: "a", slots: 4 }, { id: "b", name: "b", slots: 4 }, { id: "c", name: "c", slots: 4 }] })).toBe("12 slots on 3 machines");
    expect(slotsWords({ slots: 0, machines: [] })).toBe("no slots");
    expect(waitWords(45)).toBe("45 s");
    expect(waitWords(7200)).toBe("2 h");
  });

  it("is short past ten minutes, and names the fix by the fallback's state", () => {
    expect(capacityShort(line({ wait_seconds_from_saturation: 600 }))).toBe(false);
    expect(capacityShort(line({ wait_seconds_from_saturation: 601 }))).toBe(true);
    expect(capacityNext(line(), "acme", false)).toBe("buildhound runner add --org acme --label macos --yes");
    expect(capacityNext(line({ label: "buildhound-linux-arm64" }), "acme", false)).toBe("buildhound runner add --org acme --label linux-arm64 --yes");
    expect(capacityNext(line(), "acme", true)).toBe("buildhound failover --org acme --label buildhound-macos --fallback on");
  });

  it("says what a machine runs at once from its label slots, Linux once for every Linux family", () => {
    expect(runsAtOnce({ "buildhound-macos": { capacity: 1 }, "buildhound-linux": { capacity: 3 }, "buildhound-linux-arm64": { capacity: 3 }, "buildhound-macos-exclusive": { capacity: 1 } })).toBe("Runs 1 macOS and 3 Linux jobs at once");
    expect(runsAtOnce({ "buildhound-linux": { capacity: 1 } })).toBe("Runs 1 Linux job at once");
    expect(runsAtOnce({})).toBeNull();
  });
});
