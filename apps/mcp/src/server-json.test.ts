import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* apps/mcp/server.json is what the MCP registry lists (docs/CLI_AND_MCP.md, The MCP registry). The registry refuses a
 * publish whose name differs from the npm package's mcpName, and a description over 100 characters. */
const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const server = read("server.json");
const pkg = read("package.json");

describe("registry metadata", () => {
  it("names the server as the npm package does, under the buildhound.sh domain", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^sh\.buildhound\/[a-zA-Z0-9._-]+$/);
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it("lists the version the package carries, so a release updates both", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("keeps to the registry's limits", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  });
});
