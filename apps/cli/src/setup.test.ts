import { beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SKILL_MD } from "./lib/skill";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

let home = "";

/** HOME and BUILDHOUND_HOME_DIR point at a temp dir so the real agent configs are never touched. */
async function cli(args: string[]) {
  const env = { ...process.env, PATH: emptyPath, HOME: home, BUILDHOUND_HOME_DIR: home, INIT_CWD: "" };
  try {
    const { stdout, stderr } = await run(process.execPath, [tsx, entry, ...args], { env, cwd: here });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

function singleJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  expect(lines, "exactly one line of JSON on stdout").toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

type Result = { home: string; installed: string[]; skipped: Array<{ target: string; reason: string }>; files: Array<{ target: string; path: string; status: string }>; next: string };

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "buildhound-setup-home-"));
});

describe("agentfirst: setup agent", () => {
  it("agentfirst: the skill stays under 60 lines, has frontmatter and no em dashes", () => {
    expect(SKILL_MD.split("\n").length).toBeLessThan(60);
    expect(SKILL_MD.startsWith("---\nname: buildhound\n")).toBe(true);
    expect(SKILL_MD).not.toContain(String.fromCharCode(0x2014));
    for (const must of ["needs_human", "needs_plan", "scan", "fork pull requests", "runner add"]) expect(SKILL_MD).toContain(must);
    expect(SKILL_MD).not.toContain("needs_team");
  });

  it("agentfirst: setup agent skips every agent when none is installed", async () => {
    const r = await cli(["setup", "agent"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as unknown as Result;
    expect(obj.installed).toEqual([]);
    expect(obj.skipped.map((s) => s.target)).toEqual(["claude-code", "cursor", "codex"]);
    expect(obj.next).toBeTruthy();
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("agentfirst: setup on its own runs setup agent", async () => {
    const short = await cli(["setup"]);
    const long = await cli(["setup", "agent"]);
    expect(short.code).toBe(0);
    expect(singleJson(short.stdout)).toEqual(singleJson(long.stdout));
  });

  it("agentfirst: setup agent writes the skill and MCP entries for detected agents, merging an existing mcp.json", async () => {
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other-mcp", args: [] } } }));
    writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://example.test/mcp" } } }));

    const r = await cli(["setup", "agent"]);
    expect(r.code).toBe(0);
    const obj = singleJson(r.stdout) as unknown as Result;
    expect(obj.installed).toEqual(["skill:claude-code", "mcp:claude-code", "skill:cursor", "mcp:cursor", "skill:codex"]);
    expect(obj.skipped.map((s) => s.target)).toEqual(["mcp:codex"]);
    expect(obj.files.every((f) => f.status === "written")).toBe(true);
    expect(obj.next).toBe("buildhound scan . --json");

    for (const dir of [".claude", ".cursor", ".codex"]) expect(readFileSync(path.join(home, dir, "skills", "buildhound", "SKILL.md"), "utf8")).toBe(SKILL_MD);

    const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")) as { theme: string; mcpServers: Record<string, Record<string, unknown>> };
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers.other).toEqual({ command: "other-mcp", args: [] });
    expect(claude.mcpServers.buildhound).toMatchObject({ "// buildhound": expect.any(String), command: "npx", args: ["-y", "@buildhound/mcp"] });

    const cursor = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers.other).toEqual({ url: "https://example.test/mcp" });
    expect(cursor.mcpServers.buildhound).toMatchObject({ command: "npx" });

    // Second run: nothing changes and nothing is duplicated.
    const again = singleJson((await cli(["setup", "agent"])).stdout) as unknown as Result;
    expect(again.installed).toEqual(obj.installed);
    expect(again.files.every((f) => f.status === "unchanged")).toBe(true);
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"))).toEqual(claude);
    expect(Object.keys(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers)).toEqual(["other", "buildhound"]);
  });

  it("agentfirst: setup agent never clobbers an mcp.json it cannot parse or a buildhound entry it did not write", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ not json");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { buildhound: { command: "my-own-build" } } }));
    const obj = singleJson((await cli(["setup", "agent"])).stdout) as unknown as Result;
    expect(obj.installed).toEqual(["skill:claude-code", "skill:cursor"]);
    expect(obj.skipped.map((s) => s.target)).toEqual(["mcp:claude-code", "mcp:cursor", "codex"]);
    expect(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { buildhound: { command: "my-own-build" } } });
  });

  it("agentfirst: setup agent refreshes a stale skill file", async () => {
    mkdirSync(path.join(home, ".codex", "skills", "buildhound"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "skills", "buildhound", "SKILL.md"), "old");
    const obj = singleJson((await cli(["setup", "agent"])).stdout) as unknown as Result;
    expect(obj.files).toEqual([{ target: "skill:codex", path: path.join(home, ".codex", "skills", "buildhound", "SKILL.md"), status: "written" }]);
    expect(readFileSync(path.join(home, ".codex", "skills", "buildhound", "SKILL.md"), "utf8")).toBe(SKILL_MD);
  });
});
