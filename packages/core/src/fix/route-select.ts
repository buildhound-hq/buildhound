import { classify } from "../cost/classify";
import type { RateOverrides } from "../cost/classify";
import type { History } from "../model/types";
import type { AuditedWorkflow } from "../rules/audit";
import { buildhoundFamily, parseRoutingExpression } from "../rules/routing";
import { secretBearingJobs } from "../security/classify-job";
import { measureSpeed, routableRunsOn } from "./route";
import type { RoutingKept, RoutingMove } from "./route";

/**
 * Which jobs the routing pull request moves (ROADMAP B13.3), shared by `buildhound route --apply` and the control plane's
 * `POST /v1/accounts/:owner/repositories/:name/route`, which the dashboard's Repositories page calls, so both open the
 * same pull request. Pure: the caller reads the workflows, audits them and opens the pull request.
 *
 * Every job a connected machine can run moves to its family's routing variable, with its GitHub-hosted label as the
 * fallback. A job that can reach secrets reads the family's trusted variable, which only machines a person marked
 * Trusted serve (ADR-023, CLAUDE.md rule 19); one already on the plain variable moves to the trusted one.
 */

/** A label for an exclusive job (`buildhound-macos-exclusive`), which never falls back; the same test as `runsExclusive` in packages/shared. */
const EXCLUSIVE = /^buildhound-[a-z0-9-]+-exclusive(-[a-z0-9-]+)?$/i;

export interface RoutingSelectionInput {
  /** The audit's workflows (`auditWorkflows`), for each job's model and estimate. */
  audited: readonly AuditedWorkflow[];
  /** The files as read, by path; `runs-on` is read from the file itself. */
  workflows: ReadonlyArray<{ path: string; content: string }>;
  repositoryPrivate: boolean;
  history: History | null;
  /** The repository's default GITHUB_TOKEN permission; undefined counts as write. */
  defaultTokenPermission?: "read" | "write" | undefined;
  overrides?: RateOverrides;
  /** False when `buildhound.toml` turns routing off: every job stays, with that reason. */
  routingEnabled?: boolean;
  /** `buildhound route`'s ranking for a job, "stay" included (CLAUDE.md rule 15); null or absent leaves it out of the body. */
  rank?: (job: { jobId: string; name: string; label: string; minutesPerMonth: number }) => RoutingMove["ranking"];
}

export interface RoutingSelection {
  moves: RoutingMove[];
  kept: RoutingKept[];
  /** Jobs already on a routing expression that stays as it is. */
  already: Array<{ workflow: string; job: string; variable: string }>;
  /** Some job moves to a trusted variable. */
  secretRouted: boolean;
  /** Some job moves to BUILDHOUND_LINUX_ARM64. */
  arm64Routed: boolean;
}

/** The routing variable for a family: `buildhound-linux-arm64` reads BUILDHOUND_LINUX_ARM64, its trusted twin adds _TRUSTED. */
const variableOf = (family: string, trusted: boolean) => `${family.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}${trusted ? "_TRUSTED" : ""}`;

export function selectRoutingMoves(i: RoutingSelectionInput): RoutingSelection {
  const overrides = i.overrides ?? {};
  const routingEnabled = i.routingEnabled ?? true;
  const publicRepo = !i.repositoryPrivate;
  const moves: RoutingMove[] = [];
  const kept: RoutingKept[] = [];
  const already: RoutingSelection["already"] = [];
  let secretRouted = false;
  let arm64Routed = false;
  for (const w of i.audited) {
    const content = i.workflows.find((f) => f.path === w.path)?.content ?? "";
    const secrets = secretBearingJobs(content, i.defaultTokenPermission);
    for (const job of w.model.jobs) {
      const routed = job.runsOn.length === 1 ? parseRoutingExpression(job.runsOn[0]!) : null;
      const reasons = secrets.get(job.id);
      const est = w.estimate.jobs.find((j) => j.jobId === job.id);
      const name = job.name ?? job.id;
      if (routed) {
        // Routed earlier on the plain variable but able to reach secrets: it moves to the trusted one, so a machine marked
        // No secrets is never offered it and it no longer waits there to be declined.
        const family = classify([routed.hostedDefault], overrides).os;
        if (reasons?.length && !routed.variable.endsWith("_TRUSTED") && (family === "macos" || family === "linux") && routingEnabled) {
          secretRouted = true;
          moves.push({
            workflow: w.path,
            jobId: job.id,
            name,
            from: routed.hostedDefault,
            today: job.runsOn[0]!,
            os: family,
            variable: `${routed.variable}_TRUSTED`,
            secrets: reasons,
            minutesPerMonth: est?.minutesPerMonth ?? 0,
            centsPerMonth: publicRepo ? 0 : (est?.centsPerMonth ?? 0),
            basis: est?.basis ?? "default",
            speed: measureSpeed(i.history, w.path, name),
            ranking: null,
          });
          continue;
        }
        already.push({ workflow: w.path, job: job.id, variable: routed.variable });
        continue;
      }
      const r = routableRunsOn(content, job.id);
      if ("reason" in r) {
        kept.push({ workflow: w.path, jobId: job.id, label: null, reason: r.reason });
        continue;
      }
      const c = classify([r.label], overrides);
      const stay = (reason: string) => kept.push({ workflow: w.path, jobId: job.id, label: r.label, reason });
      if (EXCLUSIVE.test(r.label)) { stay("it runs alone on one of your machines (an -exclusive label), which never falls back to GitHub-hosted"); continue; }
      if (c.provider === "buildhound") { stay("it already runs only on your machines, without fallback"); continue; }
      if (c.provider === "self_hosted") { stay("it runs on a self-hosted runner"); continue; }
      if (c.provider === "unknown") { stay("Buildhound does not recognise its label"); continue; }
      if (c.os !== "macos" && c.os !== "linux") { stay(`it runs on ${c.os === "windows" ? "Windows" : "an operating system"}, which no connected machine runs`); continue; }
      if (!routingEnabled) { stay("routing is turned off in buildhound.toml"); continue; }
      if (reasons?.length) secretRouted = true;
      const minutes = est?.minutesPerMonth ?? 0;
      // A Linux job on an arm64 runner (GitHub's ubuntu-24.04-arm, a vendor's arm label) is pinned to arm64 machines through
      // BUILDHOUND_LINUX_ARM64, so an x86-64 host never takes it; every other Linux job takes any Linux machine (RUNNERS.md, Labels).
      const family = buildhoundFamily(c.os, c.arch);
      if (family === "buildhound-linux-arm64") arm64Routed = true;
      moves.push({
        workflow: w.path,
        jobId: job.id,
        name,
        from: r.label,
        os: c.os,
        // A job that can reach secrets reads the family's trusted variable, which only Trusted machines serve (rule 19).
        variable: variableOf(family, Boolean(reasons?.length)),
        ...(reasons?.length ? { secrets: reasons } : {}),
        minutesPerMonth: minutes,
        centsPerMonth: publicRepo ? 0 : (est?.centsPerMonth ?? 0),
        basis: est?.basis ?? "default",
        speed: measureSpeed(i.history, w.path, name),
        ranking: i.rank?.({ jobId: job.id, name, label: r.label, minutesPerMonth: minutes }) ?? null,
      });
    }
  }
  return { moves, kept, already, secretRouted, arm64Routed };
}
