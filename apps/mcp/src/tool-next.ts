/**
 * The CLI's operations and the control plane write `next` as a terminal command (`buildhound runner status --org
 * acme`). An agent on this server calls tools, so a tool's error names the tool and its arguments instead
 * (`call runner_status with org: "acme"`). The ops stay one shape for both surfaces; this is the one place that maps
 * a command and its flags to a tool and its arguments.
 */

type Flag =
  | { arg: string; type: "string" | "array" | "number" | "on_off" }
  | { arg: string; value: unknown }
  | "drop";

interface Command {
  flags: Record<string, Flag>;
  /** The argument a bare word after the command fills, such as a job id or a search's words. */
  positional?: string;
  /** The tool for the flags given; null when no tool does what the command does. */
  tool: (given: Set<string>) => string | null;
}

const s = (arg: string): Flag => ({ arg, type: "string" });
const list = (arg: string): Flag => ({ arg, type: "array" });
const num = (arg: string): Flag => ({ arg, type: "number" });
const CONFIRM: Flag = { arg: "confirm", value: true };
const ORG = { org: s("org") };
const always = (tool: string) => () => tool;

const COMMANDS: Record<string, Command> = {
  "runner status": { flags: { ...ORG, machine: s("machine"), local: "drop" }, tool: always("runner_status") },
  "runner add": {
    flags: { ...ORG, label: s("label"), name: s("name"), capacity: num("capacity"), repositories: list("repositories"), check: { arg: "check", value: true }, yes: CONFIRM },
    tool: always("runner_add"),
  },
  "runner set": {
    flags: {
      ...ORG, machine: s("machine"), routing: s("routing"), pause: { arg: "paused", value: true }, resume: { arg: "paused", value: false }, performance: s("performance"), comfort: s("comfort"),
      "stay-awake": s("stay_awake"), "idle-only": { arg: "idle_only", type: "on_off" }, "plugged-in-only": { arg: "plugged_in_only", type: "on_off" },
      repositories: list("repositories"), "add-repository": list("add_repositories"), "remove-repository": list("remove_repositories"),
    },
    tool: always("runner_set"),
  },
  "runner remove": { flags: { ...ORG, machine: s("machine"), yes: CONFIRM }, tool: always("runner_remove") },
  "runner cleanup": { flags: { ...ORG, machine: s("machine"), yes: CONFIRM }, tool: always("runner_cleanup") },
  failover: { flags: { ...ORG }, tool: always("failover_state") },
  jobs: {
    flags: { ...ORG, repository: list("repository"), machine: list("machine"), status: list("status"), "ran-on": list("ran_on"), workflow: list("workflow"), os: list("os"), label: s("label"), result: s("result"), limit: num("limit"), before: s("before") },
    tool: always("jobs_list"),
  },
  job: { flags: { ...ORG }, positional: "id", tool: always("job_get") },
  status: { flags: { ...ORG }, tool: always("routing_status") },
  plan: { flags: { ...ORG }, tool: always("plan_get") },
  overview: { flags: { ...ORG, month: s("month") }, tool: always("overview_get") },
  savings: { flags: { ...ORG, months: num("months") }, tool: always("savings_get") },
  repos: { flags: { ...ORG }, tool: always("repos_list") },
  "audit-log": { flags: { ...ORG, action: list("action"), machine: list("machine"), actor: list("actor"), source: list("source"), fold: { arg: "fold", value: true }, before: s("before") }, tool: always("audit_log_list") },
  settings: { flags: { ...ORG, performance: s("performance") }, tool: (g) => (g.has("performance") ? "settings_set" : "settings_get") },
  search: { flags: { ...ORG, scope: s("scope"), limit: num("limit") }, positional: "q", tool: always("search") },
  "billing checkout": { flags: { ...ORG, plan: s("plan"), annual: { arg: "billing", value: "annual" }, monthly: { arg: "billing", value: "monthly" } }, tool: always("billing_checkout") },
  "billing period": { flags: { ...ORG, billing: s("billing"), yes: CONFIRM }, tool: always("billing_period") },
  doctor: { flags: { ...ORG }, tool: always("doctor") },
  "cache list": { flags: { ...ORG, machine: s("machine"), repository: s("repository") }, tool: always("cache_list") },
  "cache clear": { flags: { ...ORG, machine: s("machine"), repository: s("repository"), yes: CONFIRM }, tool: always("cache_clear") },
  "cache reset": { flags: { ...ORG, machine: s("machine"), yes: CONFIRM }, tool: always("cache_reset") },
  // --wait follows a build in the terminal; the tool answers at once, so calling it again follows the build.
  "image build": { flags: { check: { arg: "check", value: true }, rebuild: { arg: "rebuild", value: true }, wait: "drop", yes: CONFIRM }, tool: always("image_build") },
  route: {
    flags: { repo: s("repo"), providers: list("providers"), days: num("days"), apply: "drop", "dry-run": { arg: "dry_run", value: true }, yes: CONFIRM },
    positional: "path",
    tool: (g) => (g.has("apply") ? "route_apply" : g.has("yes") || g.has("dry-run") ? null : "route_jobs"),
  },
  // `scan --repo` reads run history, which only the CLI does; scan_repo reads the files under a path.
  scan: {
    flags: { fix: "drop", repo: s("repo"), rule: list("rules"), "one-pr": { arg: "one_pr", value: true }, "dry-run": { arg: "dry_run", value: true }, yes: CONFIRM },
    positional: "path",
    tool: (g) => (g.has("fix") ? "scan_fix" : g.has("repo") || g.has("yes") ? null : "scan_repo"),
  },
  run: { flags: { repo: s("repo"), workflow: s("workflow"), ref: s("ref"), yes: CONFIRM }, tool: (g) => (g.has("workflow") ? "workflow_run" : "workflows_list") },
  rerun: { flags: { ...ORG, job: s("id"), failed: { arg: "failed", value: true }, yes: CONFIRM }, tool: always("job_rerun") },
  "repo-icon": {
    flags: { repo: s("repo"), source: s("source"), file: s("file"), clear: "drop", yes: CONFIRM },
    tool: (g) => (g.has("clear") ? "repo_icon_clear" : g.has("source") || g.has("file") ? "repo_icon_set" : "repo_icon_get"),
  },
  rates: { flags: { provider: s("provider") }, tool: always("get_rates") },
  explain: { flags: {}, positional: "rule_id", tool: always("explain_rule") },
};
COMMANDS["audit"] = COMMANDS["audit-log"]!;
const NAMES = Object.keys(COMMANDS).sort((a, b) => b.split(" ").length - a.split(" ").length);
const GLOBAL: Record<string, Flag> = { json: "drop", token: "drop", "api-url": "drop" };

const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : String(v));

/** One command's words to a tool call, or null when a flag or the command has no tool. */
function toCall(words: string[]): { call: string; used: number } | null {
  const name = NAMES.find((n) => n.split(" ").every((w, i) => words[i] === w));
  if (!name) return null;
  const cmd = COMMANDS[name]!;
  const args: Record<string, unknown> = {};
  const given = new Set<string>();
  let i = name.split(" ").length;
  let positional = false;
  let stop = false;
  while (i < words.length && !stop) {
    let w = words[i]!;
    if (/[,;]$/.test(w)) { stop = true; w = w.slice(0, -1); }
    if (w.startsWith("--")) {
      const flagName = w.slice(2);
      const flag = cmd.flags[flagName] ?? GLOBAL[flagName];
      if (!flag) return null;
      given.add(flagName);
      i++;
      if (flag === "drop") {
        // A dropped flag that takes a value takes it with it: --token $(gh auth token), --api-url <url>.
        if (flagName === "token" && words[i] === "$(gh") i += 3;
        else if ((flagName === "token" || flagName === "api-url") && words[i] && !words[i]!.startsWith("--")) i++;
        continue;
      }
      if ("value" in flag) { args[flag.arg] = flag.value; continue; }
      if (stop || i >= words.length) return null;
      let v = words[i++]!;
      if (/[,;]$/.test(v)) { stop = true; v = v.slice(0, -1); }
      args[flag.arg] =
        flag.type === "array" ? (v === "all" ? [] : v.split(",")) : flag.type === "number" ? (Number.isFinite(Number(v)) ? Number(v) : v) : flag.type === "on_off" ? v === "on" : v;
      continue;
    }
    if (cmd.positional && !positional) {
      positional = true;
      args[cmd.positional] = w.replace(/^"|"$/g, "");
      i++;
      continue;
    }
    break;
  }
  const tool = cmd.tool(given);
  if (!tool) return null;
  const pairs = Object.entries(args).map(([k, v]) => `${k}: ${fmt(v)}`);
  return { call: `call ${tool}${pairs.length ? ` with ${pairs.join(", ")}` : ""}${stop ? "," : ""}`, used: i };
}

/** Whether a next is still a terminal command an agent cannot call as a tool. */
export function namesCli(next: string): boolean {
  return /(^|\s)--[a-z]|\bbuildhound [a-z]/.test(next);
}

/**
 * Each `buildhound ...` in next becomes the tool call that does the same. A command a person runs (`a person runs
 * buildhound ...`, `ask a maintainer to run npx buildhound ...`, `sudo ...`, `the laptop's owner runs this in a terminal
 * on it: buildhound ...`) stays as written: it happens in their terminal. Returns null when a command has no tool, so
 * the caller falls back to the tool's own next.
 */
export function translateNext(next: string): string | null {
  if (/\bruns this in a terminal\b/.test(next)) return next;
  const words = next.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const at = words[i] === "npx" && words[i + 1] === "buildhound" ? i + 1 : words[i] === "buildhound" ? i : -1;
    if (at < 0) { out.push(words[i]!); continue; }
    const before = out[out.length - 1];
    if (before === "runs" || (before === "run" && out[out.length - 2] === "to") || /sudo/.test(next)) return next;
    const r = toCall(words.slice(at + 1));
    if (!r) return null;
    // "run buildhound x again" reads "call x again"; the call says the verb.
    if (before === "run") out.pop();
    out.push(r.call);
    i = at + r.used;
  }
  const text = out.join(" ").replace(/,$/, "");
  return namesCli(text) ? null : text;
}

/** A flag in a CLI message becomes the tool argument it maps to: `--add-repository` reads `add_repositories`. */
const ARG_FOR_FLAG = new Map<string, string>();
for (const cmd of Object.values(COMMANDS)) {
  for (const [flag, f] of Object.entries(cmd.flags)) {
    if (f === "drop" || ARG_FOR_FLAG.has(flag)) continue;
    ARG_FOR_FLAG.set(flag, "value" in f ? `${f.arg}: ${fmt(f.value)}` : f.arg);
  }
}

/** The message with each flag a tool takes written as its argument; flags no tool takes stay as they are. */
export function translateMessage(message: string): string {
  return message.replace(/--([a-z][a-z-]*)/g, (m, flag: string) => ARG_FOR_FLAG.get(flag) ?? m);
}
