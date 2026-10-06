import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerDeps } from "./server";

async function connect(deps?: ServerDeps) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

const macosYml = `on: push\njobs:\n  build:\n    runs-on: macos-latest\n    steps:\n      - run: pnpm lint\n`;

describe("mcp server", () => {
  it("agentfirst: every tool is annotated and read-only in M1", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["estimate_workflow_cost", "explain_rule", "get_rates", "list_rules", "scan_repo"]);
    for (const t of tools) { expect(t.annotations?.readOnlyHint).toBe(true); expect(t.description!.startsWith("Call to")).toBe(true); }
  });
  it("agentfirst: explain_rule returns JSON and an error envelope with next on unknown ids", async () => {
    const client = await connect();
    expect(JSON.parse(text(await client.callTool({ name: "explain_rule", arguments: { rule_id: "R03" } }))).slug).toBe("cancel-in-progress");
    const bad = await client.callTool({ name: "explain_rule", arguments: { rule_id: "R99" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad)).error.next).toBe("list_rules");
  });
  it("get_rates returns GitHub, every vendor and Xcode Cloud with sources", async () => {
    const client = await connect();
    const r = JSON.parse(text(await client.callTool({ name: "get_rates", arguments: {} })));
    expect(r.tables.map((t: { provider: string }) => t.provider)).toContain("ubicloud");
    expect(r.xcode_cloud.pricePerMinute).toBeLessThan(0.01);
    for (const t of r.tables) { expect(t.source).toMatch(/^https:/); expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });
  it("estimate_workflow_cost prices a macOS job with the 10x rate and honours runs_per_month", async () => {
    const client = await connect();
    const r = JSON.parse(text(await client.callTool({ name: "estimate_workflow_cost", arguments: { workflow_yaml: macosYml, runs_per_month: 100 } })));
    expect(r.runs_per_month).toBe(100);
    expect(r.cents_per_month).toBe(Math.round(100 * 8 * 0.062 * 100));
    const bad = await client.callTool({ name: "estimate_workflow_cost", arguments: { workflow_yaml: "on: [\n" } });
    expect(bad.isError).toBe(true);
  });
  it("scan_repo runs the rules over injected files and returns totals and next", async () => {
    const client = await connect({ readWorkflows: async (p) => (p === "." ? [{ path: ".github/workflows/ci.yml", content: macosYml }] : []) });
    const r = JSON.parse(text(await client.callTool({ name: "scan_repo", arguments: { path: "." } })));
    expect(r.workflows).toEqual([".github/workflows/ci.yml"]);
    expect(Array.isArray(r.findings)).toBe(true);
    expect(r.totals.cents_per_month).toBeGreaterThanOrEqual(0);
    expect(r.next).toBeTruthy();
    const none = await client.callTool({ name: "scan_repo", arguments: { path: "/nowhere" } });
    expect(JSON.parse(text(none)).error.code).toBe("NO_WORKFLOWS");
  });
});
