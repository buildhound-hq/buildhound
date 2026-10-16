/**
 * R14 runner-routing (RULES.md, ADR-012). For every job with meaningful spend, compare the current
 * provider with every configured provider at the same OS and vCPU count, on measured durations where
 * the account already runs comparable jobs on that provider and on unchanged durations otherwise.
 * Ranking is by computed cost only; "stay" is always a candidate (CLAUDE.md rule 15).
 *
 * Minutes: COST_MODEL.md says routing savings are computed on the minutes left after open R01 to R13
 * findings for the same job. In v1 the runner evaluates R14 last (ALL_RULES order) and this rule
 * accepts the full observed minutes; subtracting other findings' minutes arrives with the findings store.
 *
 * Changes behaviour (CLAUDE.md rule 14): the PR body asks the reviewer to confirm the provider is installed.
 *
 * Secret-bearing jobs (CLAUDE.md rule 19, SECURITY.md Trusted machines): when the top candidate is a connected machine
 * and the job uses secrets other than GITHUB_TOKEN, inherited secrets, an environment, `id-token: write` or a write
 * token, the finding is still reported with its evidence but carries no diff. The classifier is the one `buildhound
 * route` and the control plane use (`secretBearingJobs`); an unknown repository default token counts as write.
 */
import type { Document } from "yaml";
import { classify, type RateConfidence } from "../cost/classify";
import type { History, JobRecord, NormalisedJob } from "../model/types";
import { secretBearingJobs } from "../security/classify-job";
import { ruleById } from "./registry";
import { buildhoundLabelExpression, routingCandidates, setRunsOn, TRUSTED_EVENTS, type RoutingCandidate } from "./routing";
import type { Detection, Rule, RuleContext } from "./types";

/** GitHub-hosted classes that are not larger runners. macOS standard is 3 vCPU, so this is by class, not count. */
const GITHUB_STANDARD_CLASSES = new Set(["linux_1_slim", "linux_2", "linux_2_arm", "windows_2", "windows_2_arm", "macos_3"]);

/** Registries any provider's network can reach. Anything else may be pinned to GitHub's network. */
const KNOWN_REGISTRIES = new Set(["docker.io", "index.docker.io", "registry.hub.docker.com", "ghcr.io", "mcr.microsoft.com", "public.ecr.aws", "quay.io", "gcr.io"]);

const RATE_CONFIDENCE: Record<RateConfidence, number> = { high: 0.9, medium: 0.7, low: 0.4 };
const DURATION_CONFIDENCE = { measured: 0.9, unchanged: 0.5 } as const;

const PROVIDER_NAMES: Record<string, string> = { github: "GitHub", blacksmith: "Blacksmith", depot: "Depot", warpbuild: "WarpBuild", ubicloud: "Ubicloud", jog: "Jog", runs_on: "RunsOn", namespace: "Namespace", buildhound: "Buildhound" };

type RawJob = { "runs-on"?: unknown; container?: unknown; services?: unknown };

function rawJob(doc: Document, jobId: string): RawJob {
  const js = doc.toJS({ mapAsMap: false }) as { jobs?: Record<string, RawJob> };
  return js.jobs?.[jobId] ?? {};
}

function imageOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && typeof (v as { image?: unknown }).image === "string") return (v as { image: string }).image;
  return null;
}

/** True when every container and service image comes from a registry a third-party runner can pull from. */
function imagesReachable(raw: RawJob): boolean {
  const images: Array<string | null> = [];
  if (raw.container !== undefined) images.push(imageOf(raw.container));
  if (typeof raw.services === "object" && raw.services !== null) for (const s of Object.values(raw.services as Record<string, unknown>)) images.push(imageOf(s));
  for (const image of images) {
    if (!image || image.includes("${{")) return false;
    const first = image.split("/")[0]!;
    const hasHost = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
    if (!hasHost) continue; // Docker Hub short form
    if (!KNOWN_REGISTRIES.has(first.split(":")[0]!)) return false;
  }
  return true;
}

function matchingJobs(history: History, job: NormalisedJob): JobRecord[] {
  const name = job.name ?? job.id;
  return history.jobs.filter((j) => (j.name === name || j.name.startsWith(name + " (")) && j.startedAt && j.completedAt);
}

const durationSeconds = (j: JobRecord): number => Math.max(0, Math.floor((j.completedAt!.getTime() - j.startedAt!.getTime()) / 1000));
const rawMinutes = (j: JobRecord): number => Math.max(1, Math.ceil(durationSeconds(j) / 60));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Largest number of these jobs running at the same moment. */
function peakConcurrency(jobs: JobRecord[]): number {
  const events = jobs.flatMap((j) => [
    { t: j.startedAt!.getTime(), d: 1 },
    { t: j.completedAt!.getTime(), d: -1 },
  ]).sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return Math.max(1, peak);
}

const staysOn = (provider: string): string => (provider === "github" ? "GitHub-hosted" : (PROVIDER_NAMES[provider] ?? provider));

/** Why a secret-bearing job gets no routing fix; also the reason `scan --fix` lists it without a pull request. */
export function secretsStayReason(currentProvider: string): string {
  return `uses secrets: stays on ${staysOn(currentProvider)} until Trusted routing (B13.3)`;
}

/** The line every connected-machine fix carries in its PR body (CLAUDE.md rule 14). */
export const SECRETS_LEFT_NOTE =
  "Jobs that can reach secrets (secrets other than GITHUB_TOKEN, inherited secrets, an environment, id-token: write or a write token, and a job with no permissions block when the repository's default token could not be read) were left on their runners until Trusted routing (B13.3).";

export const R14: Rule = {
  meta: ruleById("R14")!,
  detect(ctx: RuleContext): Detection[] {
    const history = ctx.history;
    if (!history) return [];
    const routing = ctx.config.routing;
    const scale = 30 / Math.max(1, history.days);
    const out: Detection[] = [];
    let secrets: Map<string, string[]> | null = null;
    for (const job of ctx.workflow.model.jobs) {
      if (!job.runsOn.length) continue;
      const raw = rawJob(ctx.workflow.doc, job.id);
      if (JSON.stringify(raw["runs-on"] ?? null).includes("${{")) continue;
      const current = classify(job.runsOn);
      if (current.provider === "github" && !ctx.repository.private) continue;
      if (current.provider === "github" && !GITHUB_STANDARD_CLASSES.has(current.runnerClass)) continue;
      if ((job.usesContainer || job.usesServices) && !imagesReachable(raw)) continue;

      const all = matchingJobs(history, job);
      const onCurrent = all.filter((j) => classify(j.labels).provider === current.provider);
      if (!onCurrent.length) continue;
      const minutesPerMonth = Math.round(onCurrent.reduce((a, j) => a + rawMinutes(j), 0) * scale);
      const currentMedian = median(onCurrent.map(durationSeconds))!;
      const measured: Record<string, number> = {};
      for (const provider of routing.providers) {
        if (provider === current.provider) continue;
        const m = median(all.filter((j) => classify(j.labels).provider === provider).map(durationSeconds));
        if (m !== null && currentMedian > 0) measured[provider] = Number((m / currentMedian).toFixed(3));
      }

      const result = routingCandidates({
        jobId: job.id,
        labels: job.runsOn,
        minutesPerMonth,
        peakConcurrency: peakConcurrency(onCurrent),
        measuredDurationFactors: measured,
        config: routing,
        repositoryPrivate: ctx.repository.private,
      });
      const currentTotal = result.current.centsPerMonth + result.current.monthlyFixedCents;
      if (currentTotal < routing.minJobCentsPerMonth) continue;

      // macOS: a list price alone never wins; the candidate needs a measured duration factor.
      const eligible = result.candidates.filter((c) => !c.stay && (current.os !== "macos" || c.durationSource === "measured"));
      const top: RoutingCandidate | undefined = eligible[0];
      if (!top || top.savingCents <= 0) continue;
      const savingPercent = (top.savingCents / currentTotal) * 100;
      if (savingPercent < routing.minSavingPercent) continue;

      const hostedDefault = job.runsOn[0]!;
      const newLabel = top.provider === "buildhound" ? buildhoundLabelExpression(current.os, hostedDefault, !ctx.repository.private) : top.label;
      const providerName = PROVIDER_NAMES[top.provider] ?? top.provider;
      const confidence = Math.min(RATE_CONFIDENCE[top.rateConfidence], DURATION_CONFIDENCE[top.durationSource]);
      // A connected machine takes a secret-bearing job only once a person marked it Trusted: no diff (rule 19).
      secrets ??= top.provider === "buildhound" ? secretBearingJobs(ctx.workflow.content, ctx.repository.defaultTokenPermission) : null;
      const secretDetails = top.provider === "buildhound" ? secrets?.get(job.id) : undefined;
      const stays = secretDetails?.length ? secretsStayReason(current.provider) : null;
      out.push({
        jobId: job.id,
        evidence: {
          current: result.current,
          runsPerMonth: Math.round(onCurrent.length * scale),
          peakConcurrency: peakConcurrency(onCurrent),
          candidates: result.candidates,
          recommended: top.provider,
          recommendedLabel: newLabel,
          savingPercent: Math.round(savingPercent),
          installed: top.installed,
          referralAgreement: false,
          minutesBasis: "full observed minutes; minutes other open findings would remove are not yet subtracted",
          ...(result.xcodeCloud ? { xcodeCloud: result.xcodeCloud } : {}),
          ...(stays ? { secretBearing: secretDetails, notRouted: stays, unresolvedNote: `This job uses secrets, so it stays on ${staysOn(current.provider)} until Trusted routing (B13.3): ${secretDetails!.join("; ")}.` } : {}),
        },
        estimate: { minutesPerMonth, centsPerMonth: top.savingCents, confidence },
        summary: `Job "${job.id}" would cost about $${(top.savingCents / 100).toFixed(2)} a month less on ${providerName} (${Math.round(savingPercent)}% saving on ${job.runsOn.join(", ")})${stays ? `, but it uses secrets, so it stays on ${staysOn(current.provider)} until Trusted routing (B13.3)` : ""}`,
        confirmBeforeMerging: stays
          ? `Confirm before merging: no diff is offered. This job can reach secrets or write to the repository (${secretDetails!.join("; ")}), so only a machine a person marked Trusted may run it, and it stays on ${staysOn(current.provider)} until Trusted routing (B13.3).`
          : top.provider === "buildhound"
            ? `Confirm before merging: the Buildhound GitHub App is installed on this organisation, a machine is connected, and its image has the tools this job uses. The hosted default stays in the label so jobs route back when no machine is online.${ctx.repository.private ? "" : ` On this public repository only ${TRUSTED_EVENTS.join(", ")} and same-repository pull_request jobs use the machine; fork pull requests and events any GitHub user can cause stay on GitHub-hosted.`} ${SECRETS_LEFT_NOTE}`
            : `Confirm before merging: ${providerName}'s GitHub App is installed on this organisation and its image has the tools this job uses.`,
        fix: stays ? null : (doc) => setRunsOn(doc, job.id, newLabel),
      });
    }
    return out;
  },
};
