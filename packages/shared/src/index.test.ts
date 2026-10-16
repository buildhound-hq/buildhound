import { describe, expect, it } from "vitest";
import { ErrorEnvelope, HeartbeatResponse, HostState, NeedsHuman, Plan, exclusiveScaleSets, familyLabel, hostedFallbackForLabel, isExclusiveLabel, isTrustedTwin, runsExclusive, labelFamily, labelFitsHost, trustedTwin, variableNameForLabel } from "./index";

describe("shared schemas", () => {
  it("accepts a well-formed error envelope", () => {
    const r = ErrorEnvelope.safeParse({
      error: { code: "AUTH_REQUIRED", message: "not logged in", next: "buildhound login" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects an error without a next command", () => {
    const r = ErrorEnvelope.safeParse({ error: { code: "X", message: "y" } });
    expect(r.success).toBe(false);
  });
  it("needs_human carries a url and a next command", () => {
    const r = NeedsHuman.safeParse({
      status: "needs_human",
      reason: "github_app_not_installed",
      url: "https://github.com/apps/buildhound-ci/installations/new",
      next: "buildhound runner add --org acme --label macos",
    });
    expect(r.success).toBe(true);
  });
  it("plans are personal, team, enterprise, none", () => {
    expect(Plan.options).toEqual(["personal", "team", "enterprise", "none"]);
  });
});

describe("Linux label families (RUNNERS.md, Labels; decided 2026-10-16)", () => {
  it("every Linux family falls back to and is priced at ubuntu-latest, macOS at macos-latest", () => {
    for (const label of ["buildhound-linux", "buildhound-linux-x64", "buildhound-linux-exclusive", "buildhound-linux-x64-trusted"]) expect(hostedFallbackForLabel(label)).toBe("ubuntu-latest");
    expect(hostedFallbackForLabel("buildhound-macos")).toBe("macos-latest");
  });
  it("names one routing variable per family, so pinning x86-64 reads its own variable", () => {
    expect(variableNameForLabel("buildhound-linux")).toBe("BUILDHOUND_LINUX");
    expect(variableNameForLabel("buildhound-linux-x64")).toBe("BUILDHOUND_LINUX_X64");
  });
  it("buildhound-linux fits every machine; buildhound-linux-x64 only an x86-64 Linux host", () => {
    for (const host of [{ os: "linux", arch: "x64" }, { os: "linux", arch: "arm64" }, { os: "macos", arch: "arm64" }]) expect(labelFitsHost("buildhound-linux", host)).toBe(true);
    expect(labelFitsHost("buildhound-linux-x64", { os: "linux", arch: "x64" })).toBe(true);
    expect(labelFitsHost("buildhound-linux-x64-exclusive", { os: "linux", arch: "x64" })).toBe(true);
    for (const host of [{ os: "linux", arch: "arm64" }, { os: "macos", arch: "arm64" }, { os: "macos", arch: "x64" }]) {
      expect(labelFitsHost("buildhound-linux-x64", host)).toBe(false);
      expect(labelFitsHost("buildhound-linux-x64-exclusive", host)).toBe(false);
    }
  });
});

describe("trusted twins (ADR-023; SECURITY.md, Trusted machines)", () => {
  it("names each family's twin and its own routing variable", () => {
    expect(trustedTwin("buildhound-macos")).toBe("buildhound-macos-trusted");
    expect(trustedTwin("buildhound-macos-trusted")).toBe("buildhound-macos-trusted");
    expect(variableNameForLabel(trustedTwin("buildhound-macos"))).toBe("BUILDHOUND_MACOS_TRUSTED");
    expect(variableNameForLabel(trustedTwin("buildhound-linux"))).toBe("BUILDHOUND_LINUX_TRUSTED");
    expect(labelFamily("buildhound-linux-x64-trusted")).toBe("buildhound-linux-x64");
    expect(labelFamily("buildhound-linux")).toBe("buildhound-linux");
    expect(isTrustedTwin("buildhound-linux")).toBe(false);
  });
  it("never lets a machine register a twin: only trust adds it", () => {
    for (const label of ["buildhound-macos-trusted", "buildhound-linux-trusted", "buildhound-linux-x64-trusted"]) expect(labelFitsHost(label, { os: "linux", arch: "x64" })).toBe(false);
  });
});

describe("exclusive label families (RUNNERS.md, Exclusive jobs; B09)", () => {
  it("prices an exclusive job at its family's hosted rate, so no new rate exists (rule 4)", () => {
    expect(hostedFallbackForLabel("buildhound-macos-exclusive")).toBe("macos-latest");
    expect(hostedFallbackForLabel("buildhound-linux-exclusive")).toBe("ubuntu-latest");
  });
  it("tells an exclusive family from the families, their trusted twins and a machine's own name", () => {
    expect(isExclusiveLabel("buildhound-macos-exclusive")).toBe(true);
    expect(isExclusiveLabel("buildhound-linux-x64-exclusive")).toBe(true);
    for (const l of ["buildhound-macos", "buildhound-macos-trusted", "buildhound-macos-exclusive-trusted", "buildhound-macos-exclusive-mini", "mini-exclusive"]) expect(isExclusiveLabel(l)).toBe(false);
  });
  it("groups exclusive and trusted jobs under their family", () => {
    expect(familyLabel("buildhound-macos-exclusive")).toBe("buildhound-macos");
    expect(familyLabel("buildhound-linux-exclusive-trusted")).toBe("buildhound-linux");
    expect(familyLabel("buildhound-linux-x64")).toBe("buildhound-linux-x64");
  });
  it("derives one exclusive scale set per family, named so it pins the machine", () => {
    const sets = [
      { label: "buildhound-macos", name: "buildhound-macos-mini", runner_group: "Default" },
      { label: "buildhound-linux", name: "buildhound-linux-mini", runner_group: "Default" },
    ];
    expect(exclusiveScaleSets(sets)).toEqual([
      { label: "buildhound-macos-exclusive", name: "buildhound-macos-exclusive-mini", runner_group: "Default" },
      { label: "buildhound-linux-exclusive", name: "buildhound-linux-exclusive-mini", runner_group: "Default" },
    ]);
    // Never a twin of a twin, never twice.
    expect(exclusiveScaleSets([...sets, ...exclusiveScaleSets(sets)])).toEqual([]);
  });
  it("tells a job that asks to run alone, by family or by one machine, which routing leaves as written", () => {
    expect(runsExclusive(["buildhound-macos-exclusive"])).toBe(true);
    expect(runsExclusive(["buildhound-linux-exclusive-mini-01"])).toBe(true);
    expect(runsExclusive(["buildhound-macos-exclusive-trusted"])).toBe(true);
    expect(runsExclusive(["buildhound-macos", "macos-latest", "${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}"])).toBe(false);
  });
  it("keeps the exclusive x86-64 label to x86-64 Linux hosts", () => {
    expect(labelFitsHost("buildhound-linux-x64-exclusive", { os: "macos", arch: "arm64" })).toBe(false);
    expect(labelFitsHost("buildhound-linux-exclusive", { os: "macos", arch: "arm64" })).toBe(true);
  });
  it("carries the machine's exclusive state and the labels it finishes up for", () => {
    expect(HostState.parse({ exclusive: "finishing_up" }).exclusive).toBe("finishing_up");
    expect(HostState.safeParse({ exclusive: "maybe" }).success).toBe(false);
    const r = HeartbeatResponse.parse({ status: "online", min_agent_version: "0.1.0", failover: {}, removed: false, routing: "primary", standby: [], machines: [], exclusive_waiting: ["buildhound-macos-exclusive"] });
    expect(r.exclusive_waiting).toEqual(["buildhound-macos-exclusive"]);
  });
});
