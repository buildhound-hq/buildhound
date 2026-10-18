import { describe, expect, it } from "vitest";
import { buildTimeline, median, stepExcerpt, stepStatus, usualSeconds, type StoredStep } from "./timeline";

const step = (number: number, name: string, start: string, end: string | null, conclusion: string | null = "success", status = "completed"): StoredStep => ({ number, name, status, conclusion, started_at: start, completed_at: end });

describe("the job timeline (Job timeline board)", () => {
  it("names each step's status as the board draws it", () => {
    expect(stepStatus("completed", "success")).toBe("succeeded");
    expect(stepStatus("completed", "failure")).toBe("failed");
    expect(stepStatus("completed", "skipped")).toBe("skipped");
    expect(stepStatus("completed", "cancelled")).toBe("cancelled");
    expect(stepStatus("in_progress", null)).toBe("running");
    expect(stepStatus("queued", null)).toBe("queued");
  });

  it("takes a step's usual time as the median of its last successful runs, once three had it", () => {
    const run = (secs: number) => [step(1, "Run swift build", "2026-10-18T10:00:00Z", new Date(Date.parse("2026-10-18T10:00:00Z") + secs * 1000).toISOString()), step(2, "Run swift test", "2026-10-18T10:01:00Z", "2026-10-18T10:01:30Z", "failure")];
    expect(usualSeconds([run(20), run(22)]).size).toBe(0);
    const usual = usualSeconds([run(20), run(22), run(40), run(21)]);
    expect(usual.get("Run swift build")).toBe(22);
    // A step that never succeeded has no usual time.
    expect(usual.has("Run swift test")).toBe(false);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("puts Buildhound's phases on a machine before GitHub's steps, and says which phases are not reported yet", () => {
    const t = buildTimeline(
      { queued_at: "2026-10-18T10:00:00Z", acquired_at: "2026-10-18T10:03:05Z", started_at: "2026-10-18T10:03:07Z", machine: "Benys-Mac-mini" },
      [step(2, "Run swift build", "2026-10-18T10:03:20Z", "2026-10-18T10:03:55Z"), step(1, "Run actions/checkout@v4", "2026-10-18T10:03:08Z", "2026-10-18T10:03:20Z"), step(3, "Run swift test", "2026-10-18T10:03:55Z", "2026-10-18T10:04:22Z", "failure"), step(4, "Upload results", "2026-10-18T10:04:22Z", "2026-10-18T10:04:22Z", "skipped")],
      new Map([["Run swift build", 22]]),
      (n) => `/v1/accounts/acme/jobs/j/steps/${n}/log`,
    );
    expect(t.phases).toEqual([
      { key: "queued", title: "Queued", started_at: "2026-10-18T10:00:00Z", completed_at: "2026-10-18T10:03:05Z", seconds: 185 },
      { key: "picked_up", title: "Picked up by Benys-Mac-mini", started_at: "2026-10-18T10:03:05Z", completed_at: "2026-10-18T10:03:05Z", seconds: 0 },
      { key: "vm_started", title: "VM started", started_at: "2026-10-18T10:03:05Z", completed_at: "2026-10-18T10:03:07Z", seconds: 2, detail: "A clean copy of the image booted and its runner took the job" },
    ]);
    expect(t.steps.map((s) => [s.number, s.status, s.seconds, s.usual_seconds])).toEqual([
      [1, "succeeded", 12, null],
      [2, "succeeded", 35, 22],
      [3, "failed", 27, null],
      [4, "skipped", 0, null],
    ]);
    expect(t.steps[2]!.log_path).toBe("/v1/accounts/acme/jobs/j/steps/3/log");
    expect(t.not_reported).toEqual(["cache_restored", "vm_destroyed"]);
    // A job on GitHub-hosted has its queue and its steps, and nothing of Buildhound's.
    const hosted = buildTimeline({ queued_at: "2026-10-18T10:00:00Z", acquired_at: null, started_at: "2026-10-18T10:00:30Z", machine: null }, null, new Map(), () => "");
    expect(hosted).toEqual({ phases: [{ key: "queued", title: "Queued", started_at: "2026-10-18T10:00:00Z", completed_at: "2026-10-18T10:00:30Z", seconds: 30 }], steps: [], not_reported: [] });
  });

  it("cuts a step's last lines out of the job's log by their timestamps", () => {
    const log = [
      "﻿2026-10-18T10:03:54.1234567Z ##[group]Run swift build",
      "2026-10-18T10:03:55.0000000Z ##[group]Run swift test",
      "2026-10-18T10:04:10.5000000Z Test Suite 'LoginTests' failed",
      "  testRedirectAfterLogin: XCTAssertEqual failed",
      "2026-10-18T10:04:21.9000000Z Executed 48 tests, with 1 failure",
      "2026-10-18T10:04:30.0000000Z Post job cleanup.",
    ].join("\n");
    expect(stepExcerpt(log, "2026-10-18T10:03:55Z", "2026-10-18T10:04:22Z")).toEqual({
      lines: ["##[group]Run swift build", "##[group]Run swift test", "Test Suite 'LoginTests' failed", "  testRedirectAfterLogin: XCTAssertEqual failed", "Executed 48 tests, with 1 failure"],
      truncated: false,
    });
    expect(stepExcerpt(log, "2026-10-18T10:03:55Z", "2026-10-18T10:04:22Z", 2)).toEqual({ lines: ["  testRedirectAfterLogin: XCTAssertEqual failed", "Executed 48 tests, with 1 failure"], truncated: true });
    expect(stepExcerpt(log, null, null)).toEqual({ lines: [], truncated: false });
  });
});
