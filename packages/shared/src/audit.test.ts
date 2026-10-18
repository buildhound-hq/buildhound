import { describe, expect, it } from "vitest";
import { AUDIT_GROUPS, auditCsv, auditGroup, describeAudit, foldAudit } from "./audit";

describe("audit events in words (Audit board)", () => {
  it("names what changed on a machine, with each value before and after", () => {
    const d = describeAudit({ action: "machine.settings.changed", target: "Benys-Mac-mini", detail: { from: { paused: false, idle_only: true, performance: "balanced", plugged_in_only: false }, to: { paused: false, idle_only: false, performance: "max", plugged_in_only: false } } });
    expect(d.summary).toBe("changed only when not in use on Benys-Mac-mini");
    expect(d.changes).toEqual([
      { field: "Only when not in use", from: "On", to: "Off" },
      { field: "Performance", from: "Balanced", to: "Max" },
    ]);
    expect(describeAudit({ action: "machine.settings.changed", target: "mini", detail: { from: { performance: "balanced" }, to: { performance: "max" } } }).summary).toBe("changed performance on mini");
    expect(describeAudit({ action: "machine.settings.changed", target: "mini", detail: { from: { paused: false }, to: { paused: true } } }).summary).toBe("paused mini");
    expect(describeAudit({ action: "machine.repositories.changed", target: "mini", detail: { from: { all: false, repositories: ["BenyD/buildhound"] }, to: { all: false, repositories: ["BenyD/buildhound", "BenyD/lensdrop"] } } })).toEqual({ summary: "changed repositories on mini", changes: [{ field: "Serves", from: "buildhound", to: "buildhound, lensdrop" }] });
    expect(describeAudit({ action: "machine.trust.changed", target: "mini", detail: { from: "burst", to: "trusted" } })).toEqual({ summary: "trusted mini", changes: [{ field: "Trust", from: "No secrets", to: "Trusted" }] });
    expect(describeAudit({ action: "machine.routing.changed", target: "mini", detail: { from: "primary", to: "backup" } }).summary).toBe("set mini to backup");
    expect(describeAudit({ action: "machine.connected", target: "Benys-MacBook-Pro", detail: { role: "admin" } }).summary).toBe("connected Benys-MacBook-Pro");
  });

  it("says fallback in words, with the old value when it was recorded and without it for older events", () => {
    expect(describeAudit({ action: "fallback.changed", target: "buildhound-macos", detail: { from: "forced_machine", to: "auto", mode: "auto" } })).toEqual({ summary: "turned fallback on for macOS", changes: [{ field: "Fall back to GitHub-hosted", from: "Off", to: "On" }] });
    expect(describeAudit({ action: "fallback.changed", target: "buildhound-linux", detail: { mode: "forced_machine" } })).toEqual({ summary: "turned fallback off for Linux", changes: [{ field: "Fall back to GitHub-hosted", from: null, to: "Off" }] });
    expect(describeAudit({ action: "something.new", target: "x", detail: {} }).summary).toBe("something new x");
    expect(describeAudit({ action: "trust_banner.dismissed", target: "acme", detail: { count: 12 } }).summary).toBe("hid the banner about 12 jobs with secrets on GitHub-hosted for everyone");
    expect(describeAudit({ action: "github.disconnected", target: "BenyD", detail: {} }).summary).toBe("disconnected their GitHub sign-in");
  });

  it("groups actions for the Action filter", () => {
    expect(auditGroup("machine.settings.changed")).toBe("settings");
    expect(auditGroup("machine.connected")).toBe("machine_added");
    expect(auditGroup("job.rerun")).toBe("other");
    expect(Object.keys(AUDIT_GROUPS)).toEqual(["settings", "repositories", "trust", "routing", "fallback", "machine_added", "machine_removed", "billing"]);
  });

  it("folds the same change by the same person and source within a minute across machines", () => {
    const ev = (id: string, target: string, at: string, action = "machine.repositories.changed", source = "cli") => ({ id, actor: "BenyD", action, target, source, created_at: at, summary: `changed repositories on ${target}` });
    const folded = foldAudit([ev("3", "mini", "2026-10-18T16:07:50Z"), ev("2", "mbp", "2026-10-18T16:07:10Z"), ev("1", "box", "2026-10-18T16:05:00Z"), ev("0", "mini", "2026-10-18T16:04:50Z", "machine.repositories.changed", "dashboard")]);
    expect(folded.map((e) => [e.id, e.summary, e.targets ?? null])).toEqual([
      ["3", "changed repositories on 2 machines", ["mini", "mbp"]],
      ["1", "changed repositories on box", null],
      ["0", "changed repositories on mini", null],
    ]);
    // The same machine twice is two entries, not one with a repeated target.
    expect(foldAudit([ev("b", "mini", "2026-10-18T16:07:50Z"), ev("a", "mini", "2026-10-18T16:07:40Z")])).toHaveLength(2);
  });

  it("exports CSV with quoting and no spreadsheet formulas", () => {
    const csv = auditCsv([{ created_at: "2026-10-18T16:07:50.000Z", actor: "BenyD", action: "machine.settings.changed", summary: "changed performance on mini, the one", target: "=mini", source: "cli", changes: [{ field: "Performance", from: "Balanced", to: "Max" }] }]);
    expect(csv).toBe('time,person,action,summary,target,source,changes\r\n2026-10-18T16:07:50.000Z,BenyD,machine.settings.changed,"BenyD changed performance on mini, the one",\'=mini,cli,Performance: Balanced to Max\r\n');
  });
});
