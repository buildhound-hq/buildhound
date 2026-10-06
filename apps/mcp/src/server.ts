import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GITHUB_RATES, GITHUB_RATES_META, RULES, ruleById } from "@buildhound/core";

/** Tools are few, namespaced and annotated (AGENT_FIRST.md rules 6 and 7). Read tools carry readOnlyHint. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "buildhound", version: "0.0.1" });

  server.registerTool(
    "explain_rule",
    {
      description: "Call to learn what a Buildhound rule detects and how its fix looks. Returns the rule's id, slug, title, severity and whether its fix can change behaviour. Errors: RULE_NOT_FOUND.",
      inputSchema: { rule_id: z.string().describe("Rule id such as R03") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ rule_id }) => {
      const rule = ruleById(rule_id);
      if (!rule) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "RULE_NOT_FOUND", message: `no rule ${rule_id}`, next: "list_rules" } }) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(rule) }] };
    },
  );

  server.registerTool(
    "list_rules",
    { description: "Call to list every Buildhound rule id with its title and severity.", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false } },
    async () => ({ content: [{ type: "text", text: JSON.stringify(RULES.map(({ id, title, severity }) => ({ id, title, severity }))) }] }),
  );

  server.registerTool(
    "get_rates",
    {
      description: "Call to get the per-minute rate tables the cost model uses, each with a source URL and verified date. Returns concise rows by default.",
      inputSchema: { provider: z.string().optional().describe("Filter to one provider, e.g. github") },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ provider }) => {
      const tables = [{ ...GITHUB_RATES_META, rates: GITHUB_RATES }].filter((t) => !provider || t.provider === provider);
      return { content: [{ type: "text", text: JSON.stringify(tables) }] };
    },
  );

  return server;
}
