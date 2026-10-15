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

const building = { status: "building" as const, steps: 9, step: "xcode", step_number: 5, title: "Copying Xcode 27.0", percent: 68, seconds_left: 120, total_seconds_left: 900, next_step: "Installing tools", next: "buildhound image build --wait --json" };

describe("mcp image_build", () => {
  it("agentfirst: image_build passes check, rebuild and confirm through to the CLI's operation and returns its JSON", async () => {
    const calls: unknown[] = [];
    const client = await connect({ image: async (opts) => (calls.push(opts), building) });
    const tool = (await client.listTools()).tools.find((t) => t.name === "image_build")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(["check", "confirm", "rebuild"]);
    const r = await client.callTool({ name: "image_build", arguments: { confirm: true } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual(building);
    await client.callTool({ name: "image_build", arguments: { check: true } });
    expect(calls).toEqual([{ check: undefined, rebuild: undefined, yes: true }, { check: true, rebuild: undefined, yes: false }]);
  });

  it("agentfirst: starting without confirm answers CONFIRM_REQUIRED with a next for the coding agent", async () => {
    const client = await connect({ image: async () => { throw Object.assign(new Error("Build? Pass --yes to confirm."), { code: "CONFIRM_REQUIRED", next: "buildhound image build --yes" }); } });
    const r = await client.callTool({ name: "image_build", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error).toMatchObject({ code: "CONFIRM_REQUIRED", next: expect.stringContaining("confirm: true") });
  });

  it("agentfirst: other errors keep their code and next; without the operation it says so", async () => {
    const client = await connect({ image: async () => { throw Object.assign(new Error("not connected"), { code: "NOT_CONNECTED", next: "buildhound runner add --org <login> --yes" }); } });
    expect(JSON.parse(text(await client.callTool({ name: "image_build", arguments: { check: true } }))).error).toMatchObject({ code: "NOT_CONNECTED", next: "buildhound runner add --org <login> --yes" });
    const bare = await (await connect()).callTool({ name: "image_build", arguments: {} });
    expect(JSON.parse(text(bare)).error).toMatchObject({ code: "NOT_AVAILABLE", next: expect.any(String) });
  });
});
