import { z } from "zod";

// The website's scan of a public repository (B13.8; ARCHITECTURE.md, Public scanner). No account, no token:
// the report is free and whole, findings and diffs included (CLAUDE.md rule 12). Money in integer cents,
// minutes as integers after rounding.

/** POST /v1/scan/public: `owner/name` or a GitHub URL of a public repository. */
export const PublicScanRequest = z.object({ repo: z.string().min(1).max(300) });
export type PublicScanRequest = z.infer<typeof PublicScanRequest>;

const Cents = z.number().int();
const Minutes = z.number().int();

export const PublicReportFinding = z.object({
  rule_id: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  workflow_path: z.string(),
  job_name: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
  /** What fixing it saves a month, at this repository's rates, and how sure the rule is (0 to 1). */
  estimate: z.object({ minutes_per_month: Minutes, cents_per_month: Cents, confidence: z.number().min(0).max(1) }),
  /** The assumption a behaviour-changing fix rests on (CLAUDE.md rule 14). */
  confirm_before_merging: z.string().nullable(),
  /** Unified diff of the fix; null when no automatic fix exists, or in a `partial` report when the scan's limit came first. */
  diff: z.string().nullable(),
});
export type PublicReportFinding = z.infer<typeof PublicReportFinding>;

export const PublicReportJob = z.object({
  id: z.string(),
  name: z.string().nullable(),
  runs_on: z.array(z.string()),
  provider: z.string(),
  os: z.string(),
  runs_per_month: z.number().int(),
  minutes_per_run: z.number(),
  minutes_per_month: Minutes,
  /** As billed to this repository: GitHub-hosted runners are free on public repositories. */
  cents_per_month: Cents,
  /** The same minutes at private-repository rates (`packages/core/cost/rates`). */
  list_cents_per_month: Cents,
  /** "history" when runs and minutes came from the repository's runs, "default" from COST_MODEL.md. */
  basis: z.enum(["history", "default"]),
});
export type PublicReportJob = z.infer<typeof PublicReportJob>;

export const PublicReportWorkflow = z.object({
  path: z.string(),
  name: z.string().nullable(),
  events: z.array(z.string()),
  jobs: z.array(PublicReportJob),
  minutes_per_month: Minutes,
  cents_per_month: Cents,
  list_cents_per_month: Cents,
  findings: z.number().int(),
});
export type PublicReportWorkflow = z.infer<typeof PublicReportWorkflow>;

/** Payback for an owned Mac (`packages/core/cost/payback`): GitHub-hosted spend that would move, against the fee and the hardware. */
export const PublicReportPayback = z.object({
  hosted_cents_per_month: Cents,
  macos_cents_per_month: Cents,
  machine_fee_cents: Cents,
  hardware_cents: Cents,
  machines_needed: z.number().int(),
  monthly_saving_cents: Cents,
  /** The month the machine has paid for itself; null when it never would at this spend. */
  payback_months: z.number().int().nullable(),
});
export type PublicReportPayback = z.infer<typeof PublicReportPayback>;

export const PublicReport = z.object({
  version: z.literal(1),
  repository: z.object({
    full_name: z.string(),
    url: z.string(),
    default_branch: z.string(),
    /** The default branch's head commit the workflows were read at; the cache key with the repository. */
    head_sha: z.string(),
    owner_type: z.enum(["User", "Organization"]).nullable(),
  }),
  scanned_at: z.string(),
  /**
   * True when the scan reached its time limit: the history, the workflows or the rules cover what was read by then,
   * and `assumptions` says which. Absent on reports stored before it existed.
   */
  partial: z.boolean().optional(),
  /** The run history the prices come from, or null for a static scan. `capped` when only the newest runs were read. */
  history: z
    .object({ days: z.number().int(), runs: z.number().int(), jobs: z.number().int(), capped: z.boolean(), start: z.string(), end: z.string() })
    .nullable(),
  rules: z.array(z.string()),
  workflows: z.array(PublicReportWorkflow),
  /**
   * Workflow files GitHub lists that were not read, and why: a symlink, a submodule, a file over 1 MB, a read GitHub
   * refused, or a limit. The rest of the report stands without them. Absent on reports stored before it existed.
   */
  unread_workflows: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
  findings: z.array(PublicReportFinding),
  totals: z.object({
    workflows: z.number().int(),
    findings: z.number().int(),
    minutes_per_month: Minutes,
    cents_per_month: Cents,
    list_cents_per_month: Cents,
    saving_minutes_per_month: Minutes,
    saving_cents_per_month: Cents,
  }),
  /** How long GitHub-hosted macOS jobs waited for a runner in the history (queued to started); null without history. */
  queue: z.object({ macos_hosted_jobs: z.number().int(), median_wait_seconds: z.number().int().nullable() }).nullable(),
  payback: z.object({
    /** As billed: GitHub-hosted is free on a public repository and so is the plan, so no saving is claimed (ADR-025). */
    billed: PublicReportPayback,
    /** The same jobs on a private repository: list rates, and Personal or Team by the owner's account type. */
    if_private: PublicReportPayback,
  }),
  assumptions: z.array(z.string()),
});
export type PublicReport = z.infer<typeof PublicReport>;

export const PublicScanResponse = z.object({
  id: z.string(),
  /** The shareable page, `https://buildhound.sh/r/<id>`. */
  url: z.string(),
  /** True when this commit was scanned in the last 24 hours and the stored report is returned. */
  cached: z.boolean(),
  report: PublicReport,
});
export type PublicScanResponse = z.infer<typeof PublicScanResponse>;

/** GET /v1/reports/:id: a stored public report. */
export const PublicReportResponse = z.object({
  id: z.string(),
  url: z.string(),
  created_at: z.string(),
  report: PublicReport,
});
export type PublicReportResponse = z.infer<typeof PublicReportResponse>;
