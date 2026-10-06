import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { EXIT } from "@buildhound/shared";
import { SKILL_MD } from "../lib/skill";
import { CliError, emit } from "../output";

export interface SetupAgentOptions {
  json?: boolean | undefined;
}

export interface SetupAgentResult {
  home: string;
  installed: string[];
  skipped: Array<{ target: string; reason: string }>;
  files: Array<{ target: string; path: string; status: "written" | "unchanged" }>;
  next: string;
}

/** The user's home for agent config: BUILDHOUND_HOME_DIR in tests so nothing touches the real one. */
export const setupHome = (): string => process.env.BUILDHOUND_HOME_DIR || homedir();

export const MCP_MARKER = "// buildhound";
/** `buildhound-mcp` is the bin of @buildhound/mcp; npx resolves it without a global install. */
export const MCP_ENTRY = { [MCP_MARKER]: "installed by buildhound setup agent; remove this entry to disconnect", command: "npx", args: ["-y", "@buildhound/mcp"] };

interface AgentTarget {
  id: "claude-code" | "cursor" | "codex";
  dir: string;
  skill: string;
  mcp: string | null;
}

export function agentTargets(home: string): AgentTarget[] {
  return [
    { id: "claude-code", dir: path.join(home, ".claude"), skill: path.join(home, ".claude", "skills", "buildhound", "SKILL.md"), mcp: path.join(home, ".claude.json") },
    { id: "cursor", dir: path.join(home, ".cursor"), skill: path.join(home, ".cursor", "skills", "buildhound", "SKILL.md"), mcp: path.join(home, ".cursor", "mcp.json") },
    { id: "codex", dir: path.join(home, ".codex"), skill: path.join(home, ".codex", "skills", "buildhound", "SKILL.md"), mcp: null },
  ];
}

function writeIfChanged(file: string, content: string): "written" | "unchanged" {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === content) return "unchanged";
  writeFileSync(file, content);
  return "written";
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge `mcpServers.buildhound` into a JSON config, keeping every other key. An unparseable file is left alone. */
export function mergeMcpConfig(file: string): { status: "written" | "unchanged"; error?: undefined } | { status: "skipped"; error: string } {
  let doc: Obj = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!isObj(parsed)) return { status: "skipped", error: `${file} is not a JSON object` };
        doc = parsed;
      } catch (e) {
        return { status: "skipped", error: `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  const servers = isObj(doc.mcpServers) ? doc.mcpServers : {};
  const current = servers.buildhound;
  if (isObj(current) && JSON.stringify(current) === JSON.stringify(MCP_ENTRY)) return { status: "unchanged" };
  if (isObj(current) && !(MCP_MARKER in current)) return { status: "skipped", error: `${file} already has an mcpServers.buildhound entry that buildhound did not write` };
  doc.mcpServers = { ...servers, buildhound: MCP_ENTRY };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { status: "written" };
}

export function runSetupAgent(): SetupAgentResult {
  const home = setupHome();
  if (!existsSync(home)) throw new CliError("PATH_NOT_FOUND", `home directory ${home} does not exist`, "buildhound setup agent", EXIT.usage);
  const installed: string[] = [];
  const skipped: SetupAgentResult["skipped"] = [];
  const files: SetupAgentResult["files"] = [];
  let found = 0;
  for (const t of agentTargets(home)) {
    if (!existsSync(t.dir)) {
      skipped.push({ target: t.id, reason: `${t.dir} not found` });
      continue;
    }
    found++;
    const skillStatus = writeIfChanged(t.skill, SKILL_MD);
    files.push({ target: `skill:${t.id}`, path: t.skill, status: skillStatus });
    installed.push(`skill:${t.id}`);
    if (!t.mcp) {
      skipped.push({ target: `mcp:${t.id}`, reason: "MCP config format not managed; add `npx -y @buildhound/mcp` as an stdio server by hand" });
      continue;
    }
    const m = mergeMcpConfig(t.mcp);
    if (m.status === "skipped") skipped.push({ target: `mcp:${t.id}`, reason: m.error });
    else {
      files.push({ target: `mcp:${t.id}`, path: t.mcp, status: m.status });
      installed.push(`mcp:${t.id}`);
    }
  }
  return { home, installed, skipped, files, next: found ? "buildhound scan . --json" : "install Claude Code, Cursor or Codex, then buildhound setup agent" };
}

export function prettySetupAgent(r: SetupAgentResult): string {
  const lines = [`buildhound setup agent in ${r.home}`];
  for (const f of r.files) lines.push(`  ${f.status.padEnd(9)} ${f.target.padEnd(18)} ${f.path}`);
  for (const s of r.skipped) lines.push(`  skipped   ${s.target.padEnd(18)} ${s.reason}`);
  lines.push("", `next: ${r.next}`);
  return lines.join("\n");
}

export function setupAgentCommand(): Command {
  return new Command("agent")
    .description("Install the Buildhound skill and MCP server entry for Claude Code, Cursor and Codex when they are present")
    .option("--json", "JSON output")
    .action((opts: SetupAgentOptions) => {
      emit(runSetupAgent(), opts, prettySetupAgent);
    });
}

export function setupCommand(): Command {
  return new Command("setup").description("Set up coding agents to drive Buildhound").addCommand(setupAgentCommand());
}
