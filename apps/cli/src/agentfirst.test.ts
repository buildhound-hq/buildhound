import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const tsx = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", ".bin", "tsx");

async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await run(tsx, [entry, ...args], { env: { ...process.env, GITHUB_TOKEN: "" } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("agentfirst contract", () => {
  it("agentfirst: scan with no TTY prints exactly one JSON object with a next field", async () => {
    const r = await cli(["scan", "."]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.next).toBeTruthy();
    expect(obj.rules).toHaveLength(14);
  });
  it("agentfirst: errors carry code, message and next, and exit non-zero", async () => {
    const r = await cli(["scan", ".", "--repo", "acme/app"]);
    expect(r.code).toBe(3);
    const obj = JSON.parse(r.stdout.trim());
    expect(obj.error.code).toBe("TOKEN_REQUIRED");
    expect(obj.error.next).toContain("--token");
    expect(r.stdout).not.toMatch(/at .*\.ts:\d+/); // never a stack trace
  });
  it("agentfirst: rates prints the verified date", async () => {
    const r = await cli(["rates", "--json"]);
    const obj = JSON.parse(r.stdout.trim());
    expect(obj.tables[0].verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
