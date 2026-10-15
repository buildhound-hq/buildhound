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

const result = {
  ok: false,
  owner: "acme",
  machine: "studio",
  checks: [
    { id: "node", status: "ok" as const, title: "Node 22.14.0" },
    { id: "simulators", status: "warn" as const, title: "3 simulators running", fix: "If you are not using them: xcrun simctl shutdown all" },
    { id: "api", status: "fail" as const, title: "Cannot reach the Buildhound API", fix: "Check the network" },
  ],
  summary: { ok: 1, warn: 1, fail: 1, skip: 0 },
  next: "Check the network",
};

describe("mcp doctor", () => {
  it("agentfirst: doctor is read only and returns the CLI's JSON, a failed check included, as a result rather than an error", async () => {
    const calls: unknown[] = [];
    const client = await connect({ doctor: async (opts) => (calls.push(opts), result) });
    const tool = (await client.listTools()).tools.find((t) => t.name === "doctor")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["org"]);
    const r = await client.callTool({ name: "doctor", arguments: { org: "acme" } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual(result);
    expect(calls).toEqual([{ org: "acme" }]);
    await client.callTool({ name: "doctor", arguments: {} });
    expect(calls.at(-1)).toEqual({ org: undefined });
  });

  it("agentfirst: doctor without the CLI's operations, or when it throws, answers with an error that carries next", async () => {
    const bare = await (await connect()).callTool({ name: "doctor", arguments: {} });
    expect(bare.isError).toBe(true);
    expect(JSON.parse(text(bare)).error).toMatchObject({ code: "NOT_AVAILABLE", next: expect.any(String) });
    const broken = await (await connect({ doctor: async () => { throw new Error("boom"); } })).callTool({ name: "doctor", arguments: {} });
    expect(JSON.parse(text(broken)).error).toMatchObject({ code: "INTERNAL", message: "boom", next: expect.stringContaining("doctor") });
  });
});
