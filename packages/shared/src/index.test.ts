import { describe, expect, it } from "vitest";
import { ErrorEnvelope, NeedsHuman, Plan, hostedFallbackForLabel, isTrustedTwin, labelFamily, labelFitsHost, trustedTwin, variableNameForLabel } from "./index";

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
