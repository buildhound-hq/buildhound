#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runFailover, runRoute, runRunnerAdd, runRunnerRemove, runRunnerSet, runRunnerStatus } from "buildhound/ops";
import { createServer } from "./server";

async function readWorkflows(root: string) {
  const dir = join(root, ".github", "workflows");
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)); } catch { return []; }
  return Promise.all(names.map(async (n) => ({ path: `.github/workflows/${n}`, content: await readFile(join(dir, n), "utf8") })));
}

const runners = { status: runRunnerStatus, add: runRunnerAdd, set: runRunnerSet, remove: runRunnerRemove, failover: runFailover, route: runRoute };
const server = createServer({ readWorkflows, runners });
await server.connect(new StdioServerTransport());
