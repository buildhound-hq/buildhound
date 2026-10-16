import { describe, expect, it } from "vitest";
import { CliError } from "../output";
import { defaultLabel, familiesFor, labelsFor, type HostInfo } from "./host";

const host = (os: HostInfo["os"], arch: HostInfo["arch"]): HostInfo => ({ os, arch, cpu_cores: 8, memory_gb: 32, hostname: "box", has_battery: false });
const NEXT = "buildhound runner add --org acme --yes";

describe("runner add label families (RUNNERS.md, Labels; decided 2026-10-16 and 2026-10-17)", () => {
  it("a Mac serves macOS, plain Linux and arm64 Linux by default; its Linux guests are arm64, so never buildhound-linux-x64", () => {
    expect(defaultLabel({ os: "macos" })).toBe("macos,linux");
    expect(labelsFor(undefined, host("macos", "arm64"), NEXT)).toEqual(["buildhound-macos", "buildhound-linux", "buildhound-linux-arm64"]);
    // The CLI's own architecture does not decide a Mac's guests (an x64 Node under Rosetta, or a test host).
    expect(labelsFor(undefined, host("macos", "x64"), NEXT)).toEqual(["buildhound-macos", "buildhound-linux", "buildhound-linux-arm64"]);
    expect(labelsFor("linux", host("macos", "arm64"), NEXT)).toEqual(["buildhound-linux", "buildhound-linux-arm64"]);
  });

  it("an x86-64 Linux host serves buildhound-linux (any Linux) and buildhound-linux-x64 (x86-64 only)", () => {
    expect(defaultLabel({ os: "linux" })).toBe("linux");
    expect(labelsFor(undefined, host("linux", "x64"), NEXT)).toEqual(["buildhound-linux", "buildhound-linux-x64"]);
    expect(labelsFor("linux", host("linux", "x64"), NEXT)).toEqual(["buildhound-linux", "buildhound-linux-x64"]);
    expect(labelsFor("linux,linux", host("linux", "x64"), NEXT)).toEqual(["buildhound-linux", "buildhound-linux-x64"]);
  });

  it("an arm64 Linux host serves buildhound-linux (any Linux) and buildhound-linux-arm64 (arm64 only), never buildhound-linux-x64", () => {
    expect(labelsFor(undefined, host("linux", "arm64"), NEXT)).toEqual(["buildhound-linux", "buildhound-linux-arm64"]);
    for (const h of [host("linux", "arm64"), host("macos", "arm64"), host("macos", "x64")]) {
      expect(familiesFor("linux", h, NEXT)).not.toContain("buildhound-linux-x64");
      expect(familiesFor("linux", h, NEXT)).toContain("buildhound-linux-arm64");
    }
    // An x86-64 host never serves the arm64 family: a job pinned to arm64 never lands on it.
    expect(familiesFor("linux", host("linux", "x64"), NEXT)).not.toContain("buildhound-linux-arm64");
  });

  it("refuses macOS on a Linux host and an unknown label, with the command to run instead", () => {
    const err = (() => {
      try {
        labelsFor("macos", host("linux", "x64"), "buildhound runner add --org acme --label macos");
      } catch (e) {
        return e as CliError;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(CliError);
    expect(err!.next).toBe("buildhound runner add --org acme --label linux");
    expect(() => labelsFor("windows", host("linux", "x64"), NEXT)).toThrow(/--label must be macos or linux/);
  });
});
