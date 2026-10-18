import { Command } from "commander";
import { EXIT, SearchScope, type SearchResponse, type SearchResult } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { ago, color, count, next, resultSymbol } from "../lib/style";

// `buildhound search <words>`: the dashboard's global search (the canvas's Search board) over machines, repositories and
// jobs, read only. The same JSON as the MCP tool `search`.

export interface SearchOptions {
  org?: string | undefined;
  scope?: string | undefined;
  limit?: string | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export type SearchResultSet = SearchResponse & { next: string };

export async function runSearch(words: string, opts: SearchOptions): Promise<SearchResultSet> {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user to search", `buildhound search "${words}" --org <login>`, EXIT.usage);
  const scope = SearchScope.safeParse(opts.scope ?? "all");
  if (!scope.success) throw new CliError("USAGE", `--scope must be all, jobs, machines, repositories or settings, got ${opts.scope}`, `buildhound search "${words}" --org ${opts.org} --scope all`, EXIT.usage);
  const retry = `buildhound search "${words}" --org ${opts.org}`;
  const api = ApiClient.forCommand(opts, retry);
  const q = new URLSearchParams({ q: words, scope: scope.data, ...(opts.limit ? { limit: opts.limit } : {}) });
  const body = await api.expect<SearchResponse>("GET", `/v1/accounts/${encodeURIComponent(opts.org)}/search?${q.toString()}`, undefined, retry);
  // The first job opens with `buildhound job`; a machine's state with runner status; else look wider in jobs.
  const job = body.groups.jobs[0];
  const machine = body.groups.machines[0];
  const nextCmd = job ? `buildhound job ${job.id} --org ${body.owner}` : machine ? `buildhound runner status --org ${body.owner}` : `buildhound jobs --org ${body.owner}`;
  return { ...body, next: nextCmd };
}

const line = (r: SearchResult) => `${r.kind === "job" ? resultSymbol(r.status) : " "} ${r.title}  ${color.dim(r.subtitle)}${r.kind === "job" && r.at ? color.dim(`  ${ago(r.at)}`) : ""}`;

export function prettySearch(r: SearchResultSet): string {
  if (r.total === 0) return [`Nothing matches "${r.q}" in ${r.owner}`, "", next(r.next)].join("\n");
  const lines = [`${count(r.total, "result")} for "${r.q}" in ${r.owner}`];
  for (const [name, list] of [["Machines", r.groups.machines], ["Repositories", r.groups.repositories], ["Jobs", r.groups.jobs]] as const) {
    if (list.length) lines.push("", name, ...list.map(line));
  }
  lines.push("", next(r.next));
  return lines.join("\n");
}

export function searchCommand(): Command {
  return new Command("search")
    .description("Search an account's machines, repositories and jobs, as the dashboard's search does; read only")
    .argument("<words>", "what to look for: a machine, a repository, or a job, workflow, branch, commit message or run number")
    .option("--org <login>", "GitHub organisation or user")
    .option("--scope <scope>", "all (default), jobs, machines or repositories")
    .option("--limit <n>", "results per group, up to 20 (default 5)")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (words: string, opts: SearchOptions) => {
      emit(await runSearch(words, opts), opts, prettySearch);
    });
}
