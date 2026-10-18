#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { actionRefResolver, findToken, runAudit, runBillingCheckout, runBillingPeriod, runCacheClear, runCacheList, runCacheReset, runDoctor, runImageBuild, runFailover, runJob, runJobs, runOverview, runPlan, runRepoIcon, runRepos, runRerun, runRun, runRoute, runRouteApply, runRunnerAdd, runRunnerRemove, runRunnerSet, runRunnerStatus, runSavings, runScanFix, runSettings } from "buildhound/ops";
import { createServer } from "./server";

async function readWorkflows(root: string) {
  const dir = join(root, ".github", "workflows");
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)); } catch { return []; }
  return Promise.all(names.map(async (n) => ({ path: `.github/workflows/${n}`, content: await readFile(join(dir, n), "utf8") })));
}

const runners = { status: runRunnerStatus, add: runRunnerAdd, set: runRunnerSet, remove: runRunnerRemove, failover: runFailover, route: runRoute };
// The control plane records where an admin change came from (audit log): this server's calls say mcp.
process.env.BUILDHOUND_SOURCE = "mcp";
const reads = { jobs: runJobs, job: runJob, overview: runOverview, savings: runSavings, repos: runRepos, plan: runPlan, audit: runAudit, settings: runSettings };
// R17 pins action tags to the commits GitHub returns for them, with the user's GitHub login when there is one.
const resolveActionRefs = (files: Array<{ path: string; content: string }>) => actionRefResolver(files, { token: findToken(undefined) });
const server = createServer({ readWorkflows, resolveActionRefs, runners, reads, billing: runBillingCheckout, billingPeriod: runBillingPeriod, doctor: runDoctor, caches: { list: runCacheList, clear: runCacheClear, reset: runCacheReset }, image: runImageBuild, runs: { run: runRun, rerun: runRerun }, fix: runScanFix, routeApply: runRouteApply, repoIcon: runRepoIcon });
await server.connect(new StdioServerTransport());
