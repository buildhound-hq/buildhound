import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "./style";
import { appUrl, ensureEncryption, interactiveTrust, parseFdesetupStatus, parseLsblkTypes, pollUntil, readEncryption, RECOVERY_KEY_WARNING, trustNeedsHuman, type TrustIO } from "./trust-step";

/** A terminal with scripted answers; `sudo fdesetup enable` is never the real one. */
function fakeIO(opts: { answers?: boolean[]; encryption?: Array<boolean | null>; exit?: number; reported?: boolean } = {}) {
  const answers = [...(opts.answers ?? [])];
  const encryption = [...(opts.encryption ?? [false])];
  const log: string[] = [];
  const io: TrustIO & { log: string[]; runs: string[][]; questions: string[] } = {
    log,
    runs: [],
    questions: [],
    async ask(q) {
      io.questions.push(q);
      log.push(`? ${q}`);
      return answers.shift() ?? false;
    },
    say: (line) => log.push(stripAnsi(line)),
    async runInteractive(file, args) {
      io.runs.push([file, ...args]);
      log.push(`$ ${file} ${args.join(" ")}`);
      return opts.exit ?? 0;
    },
    encryption: async () => (encryption.length > 1 ? encryption.shift()! : encryption[0]!),
    waitForReport: async () => opts.reported ?? true,
  };
  return io;
}

const mac = { owner: "acme", machine: "Benys-MacBook-Pro", os: "macos" };

describe("the trust step at a terminal (D-TrustOnboard)", () => {
  it("with FileVault on, asks once, No by default, and marks the machine through the person-confirmed path on yes", async () => {
    const io = fakeIO({ encryption: [true], answers: [true] });
    let marked = 0;
    expect(await interactiveTrust(mac, io, async () => void marked++)).toBe("trusted");
    expect(io.questions).toEqual(["Run jobs with secrets on this Mac?"]);
    expect(marked).toBe(1);
    expect(io.runs).toEqual([]);

    const no = fakeIO({ encryption: [true], answers: [] });
    expect(await interactiveTrust(mac, no, async () => void marked++)).toBe("declined");
    expect(marked).toBe(1);
    expect(no.log.at(-1)).toBe("  Mark it Trusted any time with buildhound runner set --machine Benys-MacBook-Pro --org acme --trusted on");
  });

  it("with FileVault off, says why in one line and turns nothing on unless the person says yes", async () => {
    const io = fakeIO({ encryption: [false], answers: [] });
    expect(await interactiveTrust(mac, io, async () => {})).toBe("encryption_off");
    expect(io.log).toContain("  FileVault is off on this Mac.");
    expect(io.log).toContain("  Only needed for jobs that use secrets: deploys, signing, publishing. Without it, those jobs stay on GitHub-hosted.");
    expect(io.questions).toEqual(["Turn on FileVault now? This runs sudo fdesetup enable in this terminal."]);
    expect(io.runs).toEqual([]);
  });

  it("on yes, warns about the recovery key first, runs sudo fdesetup enable in the person's terminal, waits for the report, then asks about trust", async () => {
    const io = fakeIO({ encryption: [false, true], answers: [true, true] });
    let marked = false;
    expect(await interactiveTrust(mac, io, async () => void (marked = true))).toBe("trusted");
    expect(io.runs).toEqual([["/usr/bin/sudo", "/usr/bin/fdesetup", "enable"]]);
    const warning = io.log.indexOf(`  ${RECOVERY_KEY_WARNING}`);
    const run = io.log.findIndex((l) => l.startsWith("$ /usr/bin/sudo"));
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(run);
    expect(io.log).toContain("✓ FileVault is on");
    expect(io.log).toContain("✓ Buildhound sees FileVault on");
    expect(io.questions.at(-1)).toBe("Run jobs with secrets on this Mac?");
    expect(marked).toBe(true);
  });

  it("stops when fdesetup fails or the agent has not reported it, and never asks about trust", async () => {
    const failed = fakeIO({ encryption: [false], answers: [true, true], exit: 1 });
    expect(await interactiveTrust(mac, failed, async () => {})).toBe("encryption_off");
    expect(failed.log).toContain("X FileVault was not turned on.");
    expect(failed.questions).toHaveLength(1);
    const silent = fakeIO({ encryption: [false, true], answers: [true, true], reported: false });
    expect(await interactiveTrust(mac, silent, async () => {})).toBe("encryption_off");
    expect(silent.log.at(-1)).toBe("  Not reported yet. Once it is, run buildhound runner set --machine Benys-MacBook-Pro --org acme --trusted on");
  });

  it("on Linux never offers to encrypt: LUKS is set at install, so it points to the docs", async () => {
    const io = fakeIO({ encryption: [false], answers: [true, true] });
    expect(await ensureEncryption({ ...mac, os: "linux", machine: "box" }, io)).toBe(false);
    expect(io.questions).toEqual([]);
    expect(io.runs).toEqual([]);
    expect(io.log).toContain("  A Linux disk is encrypted with LUKS when it is installed: https://buildhound.sh/docs/security#trust");
  });
});

describe("the trust step for a coding agent", () => {
  it("answers needs_human with the dashboard URL, what blocks it, and the steps for a person", () => {
    expect(trustNeedsHuman({ ...mac, encrypted: false, apiUrl: "https://api.buildhound.sh" })).toEqual({
      status: "needs_human",
      reason: "trust_needs_person",
      url: "https://app.buildhound.sh/acme/fleet/Benys-MacBook-Pro?trust=1",
      blocked_by: "filevault_off",
      next: "only jobs that use secrets need this: a person runs sudo fdesetup enable in a terminal on Benys-MacBook-Pro and saves the recovery key it prints, then runs buildhound runner set --machine Benys-MacBook-Pro --org acme --trusted on there, or opens the url",
    });
    expect(trustNeedsHuman({ ...mac, encrypted: true, apiUrl: "https://api.buildhound.sh" })).toEqual({
      status: "needs_human",
      reason: "trust_needs_person",
      url: "https://app.buildhound.sh/acme/fleet/Benys-MacBook-Pro?trust=1",
      next: "a person runs buildhound runner set --machine Benys-MacBook-Pro --org acme --trusted on in a terminal, or opens the url",
    });
    expect(trustNeedsHuman({ ...mac, os: "linux", encrypted: false, apiUrl: "https://api.buildhound.sh" })).toMatchObject({ blocked_by: "disk_encryption_off" });
  });

  it("finds the dashboard beside the API", () => {
    expect(appUrl("https://api.buildhound.sh")).toBe("https://app.buildhound.sh");
    expect(appUrl("https://api.staging.example.com")).toBe("https://app.staging.example.com");
    expect(appUrl("http://127.0.0.1:3001")).toBe("http://localhost:3000");
    expect(appUrl("https://cp.example.com")).toBe("https://app.buildhound.sh");
  });
});

describe("reading disk encryption", () => {
  afterEach(() => {
    delete process.env.BUILDHOUND_TEST_DISK_ENCRYPTED;
  });

  it("reads fdesetup status on a Mac and LUKS under the root file system on Linux", async () => {
    expect(parseFdesetupStatus("FileVault is On.")).toBe(true);
    expect(parseFdesetupStatus("FileVault is On.\nEncryption in progress: Percent completed = 12.3")).toBe(true);
    expect(parseFdesetupStatus("FileVault is Off.")).toBe(false);
    expect(parseFdesetupStatus(null)).toBeNull();
    expect(parseLsblkTypes("lvm\ncrypt\npart\ndisk")).toBe(true);
    expect(parseLsblkTypes("part\ndisk")).toBe(false);
    const calls: string[] = [];
    const exec = async (bin: string, args: string[]) => {
      calls.push(`${bin} ${args.join(" ")}`);
      return bin === "findmnt" ? "/dev/mapper/root" : bin === "lsblk" ? "crypt\npart\ndisk" : "FileVault is Off.";
    };
    expect(await readEncryption("linux", exec)).toBe(true);
    expect(calls).toEqual(["findmnt -no SOURCE /", "lsblk -s -rno TYPE /dev/mapper/root"]);
    expect(await readEncryption("macos", exec)).toBe(false);
    expect(calls.at(-1)).toBe("fdesetup status");
    process.env.BUILDHOUND_TEST_DISK_ENCRYPTED = "on";
    expect(await readEncryption("macos", exec)).toBe(true);
  });

  it("polls until the control plane reports it, or gives up", async () => {
    let n = 0;
    expect(await pollUntil(async () => ++n === 3, 60_000, 5_000, async () => {})).toBe(true);
    expect(n).toBe(3);
    expect(await pollUntil(async () => false, 10_000, 5_000, async () => {})).toBe(false);
  });
});
