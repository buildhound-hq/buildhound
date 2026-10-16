import { isScalar, isSeq, parseDocument } from "yaml";
import { monthlySaving } from "../cost/payback";
import type { History, JobRecord, RepositoryInfo } from "../model/types";
import { classifyWorkflowJobs } from "../security/classify-job";
import { BUILDHOUND_MACHINE_FEE_CENTS, routingExpression, setRunsOn, TRUSTED_EVENTS, upgradeRoutingExpressions } from "../rules/routing";
import type { RoutingUpgrade } from "../rules/routing";
import { applyEdit } from "../yaml";
import type { FileChange } from "./index";

/**
 * The routing pull request (`buildhound route --apply`, ROADMAP B13.3). Pure: given which jobs move to the
 * account's machines, it rewrites their `runs-on` to the routing expression, upgrades older expressions on a public
 * repository, and writes the pull request's body with the speed-up, the monthly saving, the calculation, the
 * assumption and the "stay" option. Which jobs move, and opening the pull request, is the caller's job
 * (apps/cli/src/commands/route-apply.ts). Files change only through `applyEdit` (CLAUDE.md rule 1).
 */

/** The one branch the routing pull request comes from. */
export const ROUTE_BRANCH = "buildhound/route";
/** Commit trailer that marks the routing commit as Buildhound's own, so a rerun updates its branch and never one a person changed. */
export const ROUTE_TRAILER = "Buildhound-Route";
/** Hidden marker in the body naming the jobs it routes. */
export const ROUTE_MARKER = "buildhound-route";
/** Runs on each side before a speed-up is claimed. */
export const MIN_SPEED_RUNS = 3;
const MAX_BODY = 60_000;

/**
 * The jobs of one workflow file that are secret-bearing (SECURITY.md, Trusted machines), each with the details that make
 * it so: secrets other than GITHUB_TOKEN, inherited secrets, an environment, `id-token: write` or a write token. The
 * same classifier the control plane runs before a no-secrets machine takes a job. An unknown default token counts as
 * write. Such a job is never routed to the plain variable (CLAUDE.md rule 19).
 */
export function secretBearingJobs(content: string, defaultTokenPermission?: "read" | "write"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let raw: unknown;
  try {
    raw = parseDocument(content).toJS();
  } catch {
    return out;
  }
  for (const c of classifyWorkflowJobs(raw, defaultTokenPermission ? { defaultTokenPermission } : {})) {
    if (c.secretBearing) out.set(c.jobId, c.reasons.map((r) => r.detail));
  }
  return out;
}

/** A job's `runs-on` as one plain label Buildhound can replace, or why it cannot. */
export type RoutableRunsOn = { label: string } | { reason: string };

/**
 * Reads the job's `runs-on` from the file itself: one plain label (a scalar, or a list of one) can be routed. An
 * expression (a matrix, an input), several labels, a runner group or a reusable workflow call is left to a person.
 */
export function routableRunsOn(content: string, jobId: string): RoutableRunsOn {
  const doc = parseDocument(content);
  const node: unknown = doc.getIn(["jobs", jobId, "runs-on"], true);
  if (node === undefined || node === null) {
    const uses = doc.getIn(["jobs", jobId, "uses"]);
    return { reason: typeof uses === "string" ? "it calls a reusable workflow, whose own jobs choose their runners" : "it has no runs-on" };
  }
  const items = isScalar(node) ? [node] : isSeq(node) ? node.items : null;
  if (!items) return { reason: "its runs-on names a runner group, so a person routes it by hand" };
  if (items.length !== 1 || !isScalar(items[0])) return { reason: "its runs-on lists several labels, so a person routes it by hand" };
  const value = items[0].value;
  if (typeof value !== "string" || !value.trim()) return { reason: "it has no runs-on label" };
  if (value.includes("${{")) return { reason: "its runs-on is an expression (a matrix or an input), so a person routes it by hand" };
  return { label: value.trim() };
}

export interface SpeedSample {
  runs: number;
  medianSeconds: number;
  /** Median wait from queued to started; null when GitHub did not report when the job was queued. */
  medianWaitSeconds: number | null;
}

export interface SpeedMeasure {
  hosted: SpeedSample | null;
  machine: SpeedSample | null;
  /** GitHub-hosted median over the machines' median, two decimals; null until each side has MIN_SPEED_RUNS runs. */
  speedUp: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function sample(jobs: JobRecord[]): SpeedSample | null {
  if (!jobs.length) return null;
  const secs = jobs.map((j) => Math.max(0, Math.round((j.completedAt!.getTime() - j.startedAt!.getTime()) / 1000)));
  const waits = jobs.filter((j) => j.queuedAt).map((j) => Math.max(0, Math.round((j.startedAt!.getTime() - j.queuedAt!.getTime()) / 1000)));
  const w = median(waits);
  return { runs: jobs.length, medianSeconds: Math.round(median(secs)!), medianWaitSeconds: w === null ? null : Math.round(w) };
}

/** True when a job ran on one of the account's machines: its labels name a Buildhound family. */
const onMachine = (j: JobRecord) => j.labels.some((l) => l.startsWith("buildhound-"));

/**
 * The measured speed-up of one job: the median of its successful runs on the account's machines against the median
 * on GitHub-hosted, from run history. Matched by workflow file and job name. Without history, null.
 */
export function measureSpeed(history: History | null, workflowPath: string, jobName: string): SpeedMeasure | null {
  if (!history) return null;
  const runs = new Set(history.runs.filter((r) => r.workflowPath === workflowPath).map((r) => r.id));
  const done = history.jobs.filter((j) => runs.has(j.runId) && (j.name === jobName || j.name.startsWith(`${jobName} (`)) && j.conclusion === "success" && j.startedAt && j.completedAt);
  const hosted = sample(done.filter((j) => !onMachine(j)));
  const machine = sample(done.filter(onMachine));
  const speedUp = hosted && machine && hosted.runs >= MIN_SPEED_RUNS && machine.runs >= MIN_SPEED_RUNS && machine.medianSeconds > 0 ? Math.round((hosted.medianSeconds / machine.medianSeconds) * 100) / 100 : null;
  return { hosted, machine, speedUp };
}

/** One job the pull request routes to the account's machines. */
export interface RoutingMove {
  workflow: string;
  jobId: string;
  /** The job's name as GitHub shows it (`name:`, else the id). */
  name: string;
  /** The label it runs on today, which stays as the fallback. */
  from: string;
  os: "macos" | "linux";
  /** The routing variable, `BUILDHOUND_MACOS` or `BUILDHOUND_LINUX`. */
  variable: string;
  minutesPerMonth: number;
  /** Today's GitHub-hosted cost a month; 0 on a public repository. */
  centsPerMonth: number;
  basis: "history" | "default";
  speed: SpeedMeasure | null;
  /** `buildhound route`'s ranking for this job by computed monthly cost, "stay" included (CLAUDE.md rule 15). */
  ranking: { stayCents: number; cheapest: { provider: string; label: string; cents: number } } | null;
}

/** A job the pull request leaves where it is, with the reason. */
export interface RoutingKept {
  workflow: string;
  jobId: string;
  label: string | null;
  reason: string;
}

export interface RoutingSaving {
  publicRepository: boolean;
  hostedCentsPerMonth: number;
  minutesPerMonth: number;
  machineFeeCents: number;
  /** Most of the moved macOS jobs at once; the machines needed follow from it, two macOS jobs at once per Mac. */
  macosPeakConcurrency: number;
  machinesNeeded: number;
  /** GitHub-hosted spend that moves, less the Team fee per machine needed; zero or below is no saving. */
  monthlySavingCents: number;
  /** What the pull request claims: never anything on a public repository, never below zero (ADR-025). */
  claimedCentsPerMonth: number;
}

export interface RoutingPlanInput {
  repository: RepositoryInfo;
  workflows: ReadonlyArray<{ path: string; content: string }>;
  moves: readonly RoutingMove[];
  kept: readonly RoutingKept[];
  /**
   * Most of the moved macOS jobs seen running at once in history; 1 without history. A Mac runs two macOS jobs at once
   * (Apple's limit); Linux jobs are not capped that way and share the same machines.
   */
  macosPeakConcurrency: number;
  historyDays: number | null;
}

export interface RoutingPullRequest {
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  trailer: string;
  files: FileChange[];
  /** The moves applied, each with the expression written. */
  routed: Array<RoutingMove & { to: string }>;
  upgrades: Array<{ workflow: string; jobs: Array<{ job: string; from: string; to: string | null }> }>;
  saving: RoutingSaving;
}

function lineCounts(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Write each move's routing expression into one workflow file and, on a public repository, upgrade every older
 * routing expression in it to the trusted-events form. Comments and formatting survive; a lost comment throws.
 */
export function applyRouting(path: string, content: string, moves: ReadonlyArray<{ jobId: string; to: string }>, publicRepo: boolean): { change: FileChange | null; upgrades: RoutingUpgrade[] } {
  let upgrades: RoutingUpgrade[] = [];
  const edit = applyEdit(path, content, (doc) => {
    for (const m of moves) setRunsOn(doc, m.jobId, m.to);
    upgrades = upgradeRoutingExpressions(doc, publicRepo);
  });
  if (edit.commentsAfter < edit.commentsBefore) throw new Error(`${path}: routing would drop comments (${edit.commentsBefore} before, ${edit.commentsAfter} after)`);
  if (edit.after === content) return { change: null, upgrades };
  return { change: { path, before: content, after: edit.after, diff: edit.diff, ...lineCounts(edit.diff) }, upgrades };
}

/** The monthly saving on machines the team already has, at the Team fee's monthly price (CLAUDE.md rule 9). */
export function routingSaving(moves: readonly RoutingMove[], macosPeakConcurrency: number, publicRepository: boolean): RoutingSaving {
  const hosted = publicRepository ? 0 : moves.reduce((a, m) => a + m.centsPerMonth, 0);
  const minutes = moves.reduce((a, m) => a + m.minutesPerMonth, 0);
  const s = monthlySaving({ hostedCentsPerMonth: hosted, machineFeeCents: BUILDHOUND_MACHINE_FEE_CENTS, peakConcurrency: macosPeakConcurrency, capacityPerMachine: 2 });
  return {
    publicRepository,
    hostedCentsPerMonth: hosted,
    minutesPerMonth: minutes,
    machineFeeCents: BUILDHOUND_MACHINE_FEE_CENTS,
    macosPeakConcurrency: Math.max(1, macosPeakConcurrency),
    machinesNeeded: s.machinesNeeded,
    monthlySavingCents: s.monthlySavingCents,
    claimedCentsPerMonth: publicRepository ? 0 : Math.max(0, s.monthlySavingCents),
  };
}

/**
 * Plan the routing pull request: the files with every move and upgrade applied, the title, the body and the commit.
 * `files` is empty when nothing would change (every job already routed, or nothing to route).
 */
export function planRoutingPullRequest(input: RoutingPlanInput): RoutingPullRequest {
  const publicRepo = !input.repository.private;
  const files: FileChange[] = [];
  const routed: RoutingPullRequest["routed"] = [];
  const upgrades: RoutingPullRequest["upgrades"] = [];
  for (const w of [...input.workflows].sort((a, b) => a.path.localeCompare(b.path))) {
    const mine = input.moves.filter((m) => m.workflow === w.path).map((m) => ({ ...m, to: routingExpression(m.variable, m.from, publicRepo) }));
    const r = applyRouting(w.path, w.content, mine, publicRepo);
    if (r.upgrades.length) upgrades.push({ workflow: w.path, jobs: r.upgrades.map((u) => ({ job: u.jobId, from: u.from, to: u.to })) });
    if (!r.change) continue;
    files.push(r.change);
    routed.push(...mine);
  }
  const saving = routingSaving(routed, input.macosPeakConcurrency, publicRepo);
  const n = routed.length;
  const upgraded = upgrades.reduce((a, u) => a + u.jobs.filter((j) => j.to).length, 0);
  const title = n
    ? `Route ${n === 1 ? "1 job" : `${n} jobs`} to your machines, with GitHub-hosted as the fallback`
    : "Keep jobs anyone on GitHub can start off your machines";
  const ids = routed.map((m) => m.jobId);
  const head = n ? `ci: route ${n === 1 ? "1 job" : `${n} jobs`} to your machines with Buildhound` : `ci: upgrade ${upgraded === 1 ? "1 routing expression" : `${upgraded} routing expressions`} with Buildhound`;
  const commitMessage = `${head}\n\nFrom npx buildhound route --apply.\n\n${ROUTE_TRAILER}: ${[...ids, ...(upgraded ? ["upgrades"] : [])].join(",")}`;
  const plan: RoutingPullRequest = { branch: ROUTE_BRANCH, title, body: "", commitMessage, trailer: ROUTE_TRAILER, files, routed, upgrades, saving };
  plan.body = routingPullRequestBody(plan, input);
  return plan;
}

const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const code = (s: string) => `\`${s.replace(/\|/g, "\\|")}\``;
const short = (p: string) => p.replace(/^\.github\/workflows\//, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 2 min 41 s; 45 s. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function speedCells(m: RoutingMove, days: number | null): [string, string, string] {
  const sp = m.speed;
  const hosted = sp?.hosted ? `${formatDuration(sp.hosted.medianSeconds)}, median of ${plural(sp.hosted.runs, "run")}` : days ? "no successful runs" : "no run history read";
  const machine = sp?.machine ? `${formatDuration(sp.machine.medianSeconds)}, median of ${plural(sp.machine.runs, "run")}` : "not run there yet";
  const factor = sp?.speedUp ? (sp.speedUp >= 1 ? `${sp.speedUp.toFixed(2)}x faster` : `${(1 / sp.speedUp).toFixed(2)}x slower`) : "not measured yet";
  return [hosted, machine, factor];
}

/**
 * The body: what moves, the measured speed-up, the monthly saving with its calculation, the ranking with "stay",
 * when it takes effect, what stays and why, the assumption (CLAUDE.md rule 14) and the diff.
 */
export function routingPullRequestBody(plan: Pick<RoutingPullRequest, "routed" | "upgrades" | "files" | "saving">, input: Pick<RoutingPlanInput, "repository" | "kept" | "historyDays">, detail: { diff?: boolean } = {}): string {
  const showDiff = detail.diff ?? true;
  const publicRepo = !input.repository.private;
  const days = input.historyDays;
  const out: string[] = [`<!-- ${ROUTE_MARKER}: ${plan.routed.map((m) => m.jobId).join(",")} -->`];
  const n = plan.routed.length;
  const variables = [...new Set(plan.routed.map((m) => m.variable))].sort();

  if (n) {
    out.push(`This pull request runs ${plural(n, "job")} on the machines you connected to Buildhound, with GitHub-hosted runners as the fallback. Only \`runs-on\` changes; comments and formatting are kept.`);
    out.push("", "| Workflow | Job | Today | After this pull request |", "|---|---|---|---|");
    for (const m of plan.routed) out.push(`| ${code(short(m.workflow))} | ${code(m.jobId)} | ${code(m.from)} | ${code(m.to)} |`);
  } else {
    out.push("This pull request changes no job's runner. It upgrades routing expressions Buildhound wrote earlier on this public repository, so fork pull requests and events anyone on GitHub can cause stay on GitHub-hosted. Comments and formatting are kept.");
  }

  if (n) {
    out.push("", "### Speed", "", "| Job | GitHub-hosted | Your machines | Speed-up |", "|---|---|---|---|");
    for (const m of plan.routed) out.push(`| ${code(m.jobId)} | ${speedCells(m, days).join(" | ")} |`);
    const measured = plan.routed.filter((m) => m.speed?.speedUp);
    const window = days ? `the last ${days} days` : "run history";
    out.push("", measured.length === n
      ? `Medians of successful runs in ${window}, on this repository's own jobs.`
      : `Medians of successful runs in ${window}. A speed-up is shown only once a job has at least ${MIN_SPEED_RUNS} successful runs on each side; until then it is not measured yet and none is claimed. Run \`npx buildhound route --apply\` again later to update this table.`);

    const s = plan.saving;
    out.push("", "### Monthly saving", "");
    if (publicRepo) {
      out.push("This repository is public, so GitHub-hosted runners cost it nothing and no saving is claimed. It routes for speed, on any plan.");
    } else {
      const fee = `Team, ${plural(s.machinesNeeded, "machine")} at ${dollars(s.machineFeeCents)}`;
      const rows: Array<[string, string]> = [
        ["GitHub-hosted for these jobs", `${dollars(s.hostedCentsPerMonth)} a month, ${s.minutesPerMonth} minutes`],
        [fee, `${dollars(-s.machineFeeCents * s.machinesNeeded)} a month`],
        [s.monthlySavingCents > 0 ? "Saving" : "Difference", `${dollars(s.monthlySavingCents)} a month`],
      ];
      const width = Math.max(...rows.map(([k]) => k.length)) + 3;
      out.push("```", ...rows.map(([k, v]) => `${k.padEnd(width)}${v}`), "```", "");
      out.push(s.monthlySavingCents > 0
        ? `About ${dollars(s.monthlySavingCents)} a month saved on machines you already have, after Team at ${dollars(s.machineFeeCents)} a machine a month (the monthly price; nothing to buy).`
        : `At this spend your machines would not save money: Team at ${dollars(s.machineFeeCents)} a machine a month costs more than these jobs do on GitHub-hosted. They add speed, not savings.`);
      const macs = plan.routed.some((m) => m.os === "macos");
      out.push("", `GitHub-hosted is ${days ? `priced from the last ${days} days of runs, scaled to 30 days` : "estimated from default minutes, with no run history"}, at GitHub's list price. On your machines a job costs nothing a minute; the plan is a flat fee per machine on the days it runs a job. ${macs ? `${plural(s.machinesNeeded, "machine")} for the ${plural(s.macosPeakConcurrency, "macOS job")} seen at once, two macOS jobs at once per Mac; Linux jobs share the same machines.` : "This counts one machine, since Linux jobs are not limited to two at once per machine the way macOS jobs are."}`);
    }

    const ranked = plan.routed.filter((m) => m.ranking);
    if (ranked.length) {
      out.push("", "### Every option, ranked by computed cost", "", "| Job | Stay on GitHub-hosted | Cheapest by computed cost |", "|---|---|---|");
      for (const m of ranked) {
        const c = m.ranking!.cheapest;
        const where = c.label === m.from ? "stay" : c.label === c.provider ? code(c.label) : `${code(c.label)} (${c.provider})`;
        out.push(`| ${code(m.jobId)} | ${dollars(m.ranking!.stayCents)} a month | ${where}, ${dollars(c.cents)} a month |`);
      }
      out.push("", "From `npx buildhound route`, which prices every candidate from published rates at today's minutes, with your machines at the Team fee per machine. Buildhound has no referral agreement with any runner vendor.");
    }
  }

  out.push("", "### To stay on GitHub-hosted", "", "Close this pull request. Nothing changes, and running `npx buildhound route --apply` again will not open it again.");

  out.push("", "### When it takes effect", "");
  if (n) {
    const vars = variables.map(code).join(" and ");
    out.push(`Merging changes nothing by itself. Each routed job reads the repository variable ${vars} and runs on its GitHub-hosted label while the variable is empty. Buildhound's control plane sets it once a connected machine serves this repository${publicRepo ? "" : " and the account has Personal or Team"}, and clears it when none is online, so new jobs route to the healthy side.`);
  }
  if (publicRepo) {
    out.push(...(n ? [""] : []), `On this public repository the expression sends a job to your machines only for ${TRUSTED_EVENTS.join(", ")} and pull requests from branches of this repository. Fork pull requests and events anyone on GitHub can cause stay on GitHub-hosted.`);
  }

  if (plan.upgrades.length) {
    out.push("", "### Routing expressions upgraded", "");
    for (const u of plan.upgrades) {
      for (const j of u.jobs) {
        out.push(j.to
          ? `- ${code(short(u.workflow))}, job ${code(j.job)}: an older expression let jobs anyone on GitHub can start reach your machines; it now takes the form above.`
          : `- ${code(short(u.workflow))}, job ${code(j.job)}: reads a Buildhound variable in a form Buildhound did not write, so it is left as it is. Check that it keeps fork pull requests on GitHub-hosted.`);
      }
    }
  }

  if (input.kept.length) {
    out.push("", "### Not routed", "");
    for (const k of input.kept) out.push(`- ${code(short(k.workflow))}, job ${code(k.jobId)}${k.label ? ` stays on ${code(k.label)}` : ""}: ${k.reason}.`.replace(/\.\.$/, "."));
  }

  if (n) {
    out.push("", "### Assumption", "", "This changes where the jobs run. Confirm before merging:");
    out.push("- each job runs the same on your machine as on GitHub-hosted. Buildhound's images mirror GitHub's runners, but a tool only GitHub's image has, or a service only reachable from GitHub's network, would make a job fail there.");
    if (plan.routed.some((m) => m.os === "linux")) out.push("- no Linux job needs an x86-64 kernel. On a Mac, `buildhound-linux` is an arm64 Ubuntu 24.04 VM that runs x86-64 binaries and Docker images through Rosetta; a job that needs x86-64 natively reads `BUILDHOUND_LINUX_X64` instead.");
    if (!publicRepo) out.push("- the saving uses today's GitHub-hosted minutes and assumes each job takes as long on your machine, since vendor claims are never used.");
  }

  out.push("", "### Change", "");
  for (const f of plan.files) out.push(`- ${code(f.path)}: ${plural(f.added, "line")} added, ${f.removed} removed.`);
  if (showDiff) {
    const diff = plan.files.map((f) => f.diff.trimEnd().split("\n").filter((l) => !/^=+$/.test(l)).join("\n"));
    out.push("", "<details><summary>Diff</summary>", "", "```diff", ...diff, "```", "", "</details>");
  }

  out.push("", "---", "", "Opened by [Buildhound](https://buildhound.sh) with `npx buildhound route --apply`. Review it like any other change; running the command again updates this pull request instead of opening another.");
  const body = out.join("\n");
  if (body.length > MAX_BODY) return showDiff ? routingPullRequestBody(plan, input, { diff: false }) : body.slice(0, MAX_BODY);
  return body;
}
