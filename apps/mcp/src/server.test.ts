import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server";

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("mcp server", () => {
  it("agentfirst: lists read-only annotated tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["explain_rule", "get_rates", "list_rules"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
  it("agentfirst: explain_rule returns JSON text and an error envelope with next on unknown ids", async () => {
    const client = await connect();
    const ok = await client.callTool({ name: "explain_rule", arguments: { rule_id: "R03" } });
    const text = (ok.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).slug).toBe("cancel-in-progress");
    const bad = await client.callTool({ name: "explain_rule", arguments: { rule_id: "R99" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as Array<{ text: string }>)[0]!.text).error.next).toBe("list_rules");
  });
});
