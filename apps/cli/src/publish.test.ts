import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CLI 0.1.6 and 0.1.7 and MCP 0.1.5 and 0.1.6 went to npm with no dist/ at all, and CLI 0.1.5 with a stale
// one, because publishing packed whatever dist/ held. Both packages now build in prepack, which npm and pnpm
// run before every pack and publish, so a release always carries the code it names.
const pkg = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
  version: string;
  scripts?: Record<string, string>;
  files?: string[];
  bin?: Record<string, string>;
};

describe("published packages", () => {
  for (const [name, path] of [["buildhound", "../package.json"], ["@buildhound/mcp", "../../mcp/package.json"]] as const) {
    it(`${name} builds before it is packed and ships its build`, () => {
      const p = pkg(path);
      expect(p.scripts?.prepack).toBe("tsup");
      expect(p.files).toContain("dist");
      for (const target of Object.values(p.bin ?? {})) expect(target).toMatch(/^\.\/dist\//);
    });
  }

  it("the MCP registry entry names the MCP package's version", () => {
    const server = JSON.parse(readFileSync(new URL("../../mcp/server.json", import.meta.url), "utf8")) as { version: string };
    expect(server.version).toBe(pkg("../../mcp/package.json").version);
  });
});
