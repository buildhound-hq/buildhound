import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");

/**
 * `buildhound doctor` as a coding agent runs it: stdout piped (no TTY), no GitHub token, an empty PATH, no
 * Buildhound agent on the machine, and every network address pointing at a closed local port, so nothing
 * leaves the machine and the run is the same everywhere.
 */
async function doctor(args: string[] = []) {
  const closed = "http://127.0.0.1:9";
  const env = {
    ...process.env,
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    PATH: mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-")),
    BUILDHOUND_AGENT_HOME: mkdtempSync(path.join(tmpdir(), "buildhound-doctor-home-")),
    BUILDHOUND_API_URL: closed,
    BUILDHOUND_DOWNLOADS_URL: closed,
    GITHUB_API_URL: closed,
    BUILDHOUND_HAS_BATTERY: "0",
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [tsx, entry, "doctor", ...args], { env, cwd: here });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

type Result = { ok: boolean; owner: string | null; machine: string; checks: Array<{ id: string; status: string; title: string; detail?: string; fix?: string }>; summary: Record<string, number>; next: string };

describe("agentfirst: doctor", () => {
  it("agentfirst: doctor without a TTY prints one JSON object with every check, and exits 1 because something failed", async () => {
    const r = await doctor();
    const lines = r.stdout.trim().split("\n");
    expect(lines, "exactly one line of JSON on stdout").toHaveLength(1);
    const obj = JSON.parse(lines[0]!) as Result;
    expect(r.code).toBe(1);
    expect(obj.ok).toBe(false);
    expect(obj.next).toBeTruthy();
    expect(obj.owner).toBeNull();
    const ids = obj.checks.map((c) => c.id);
    expect(ids).toEqual(["node", "github", "api", "account", "agent", "machine", "repositories", "images", "power", "memory", "disk", "simulators", "docker", "vms", "filevault", "downloads", "github_api", "routing"]);
    for (const c of obj.checks) {
      expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
      if (c.status === "warn" || c.status === "fail") expect(c.fix, c.id).toBeTruthy();
    }
    const by = Object.fromEntries(obj.checks.map((c) => [c.id, c]));
    expect(by.github!.status).toBe("fail");
    expect(by.api!.status).toBe("fail");
    // No Buildhound agent here: one clear line with the command, and the checks that need it skip instead of failing.
    expect(by.agent).toMatchObject({ status: "skip", fix: expect.stringContaining("npx buildhound runner add --org <login>") });
    for (const id of ["machine", "repositories", "images", "account", "routing", "power", "docker"]) expect(by[id]!.status, id).toBe("skip");
    expect(obj.summary.fail).toBe(obj.checks.filter((c) => c.status === "fail").length);
    // Nothing for agents on stderr: no spinner, no prompt.
    expect(r.stderr).toBe("");
  });

  it("agentfirst: doctor --json does the same, and a usage error is the JSON envelope with next", async () => {
    const r = await doctor(["--json"]);
    expect((JSON.parse(r.stdout.trim()) as Result).checks.length).toBe(18);
    const bad = await doctor(["--nope"]);
    expect(bad.code).toBe(2);
    const env = JSON.parse(bad.stdout.trim()) as { error: { code: string; next: string } };
    expect(env.error).toMatchObject({ code: "USAGE", next: "buildhound doctor --help" });
  });
});
