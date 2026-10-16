import { Command } from "commander";
import { EXIT, type BillingPeriodResponse, type CheckoutResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { done, fields, money, needed, next } from "../lib/style";

// Paying is one of the three human steps (AGENT_FIRST.md): `billing checkout` answers needs_human with Paddle's checkout
// URL and exits 0, so the agent hands the URL to a person and runs `next` once they have paid (BILLING.md, Checkout flow).

export interface BillingCheckoutOptions {
  org?: string | undefined;
  plan?: string | undefined;
  annual?: boolean | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export type BillingCheckoutResult = CheckoutResponse & { owner: string };

export async function runBillingCheckout(opts: BillingCheckoutOptions): Promise<BillingCheckoutResult> {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user that pays", "buildhound billing checkout --org <login> --plan team", EXIT.usage);
  const owner = opts.org;
  if (opts.plan !== "personal" && opts.plan !== "team") {
    throw new CliError("USAGE", "--plan is personal for a personal account or team for an organisation", `buildhound billing checkout --org ${owner} --plan team`, EXIT.usage);
  }
  const retry = `buildhound billing checkout --org ${owner} --plan ${opts.plan}${opts.annual ? " --annual" : ""}`;
  const r = await ApiClient.forCommand(opts, retry).request<CheckoutResponse>(
    "POST",
    `/v1/accounts/${encodeURIComponent(owner)}/billing/checkout`,
    { plan: opts.plan, billing: opts.annual ? "annual" : "monthly" },
    retry,
  );
  if (r.kind === "needs_human") throw new CliError("NEEDS_HUMAN", `${r.body.reason}: open ${r.body.url}`, r.body.next, EXIT.auth);
  return { ...r.body, owner };
}

export function prettyBillingCheckout(r: BillingCheckoutResult): string {
  const c = r.checkout;
  const machines = `${c.quantity} machine${c.quantity === 1 ? "" : "s"}`;
  return [
    ...needed(`${c.plan === "team" ? "Team" : "Personal"} for ${r.owner} needs a person to pay`, `open ${r.url}`),
    "",
    ...fields([
      ["First payment", `${money(c.amount_cents)} for ${machines}, billed ${c.billing === "annual" ? "annually" : "monthly"}, plus tax`],
      ["After that", "each renewal settles the period's machine days with jobs against what was paid; idle machine days come off the next payment"],
      ["Refund", "the first payment, on request within 30 days"],
    ]),
    "",
    next(r.next),
  ].join("\n");
}

export interface BillingPeriodOptions {
  org?: string | undefined;
  billing?: string | undefined;
  yes?: boolean | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  json?: boolean | undefined;
}

export type BillingPeriodResult = BillingPeriodResponse;

/**
 * Switches between annual and monthly at the next renewal (BILLING.md, Switching period). Read-only without --yes: it
 * answers what would happen (`dry_run: true`) with the --yes command as `next`. Nothing is charged when it is asked;
 * the renewal bills the new period. Asking for the period billed now drops a scheduled switch.
 */
export async function runBillingPeriod(opts: BillingPeriodOptions): Promise<BillingPeriodResult> {
  if (!opts.org) throw new CliError("USAGE", "pass --org <login>: the GitHub organisation or user that pays", "buildhound billing period --org <login> --billing annual", EXIT.usage);
  const owner = opts.org;
  if (opts.billing !== "annual" && opts.billing !== "monthly") {
    throw new CliError("USAGE", "--billing is annual or monthly", `buildhound billing period --org ${owner} --billing annual`, EXIT.usage);
  }
  const retry = `buildhound billing period --org ${owner} --billing ${opts.billing} --yes`;
  return ApiClient.forCommand(opts, retry).expect<BillingPeriodResponse>("POST", `/v1/accounts/${encodeURIComponent(owner)}/billing/period`, { billing: opts.billing, dry_run: !opts.yes }, retry);
}

export function prettyBillingPeriod(r: BillingPeriodResult): string {
  const word = (b: string) => (b === "annual" ? "annual" : "monthly");
  const s = r.switch;
  const day = s ? s.effective_at.slice(0, 10) : "";
  const head =
    r.status === "unchanged"
      ? s
        ? `${r.owner} already switches to ${word(s.billing)} billing on ${day}`
        : `${r.owner} is billed ${word(r.billing)} already`
      : r.status === "cancelled"
        ? `${r.owner} ${r.dry_run ? "would keep" : "keeps"} ${word(r.billing)} billing; the scheduled switch ${r.dry_run ? "would be" : "is"} dropped`
        : `${r.owner} ${r.dry_run ? "would switch" : "switches"} to ${word(s!.billing)} billing on ${day}`;
  return [
    r.dry_run && r.status !== "unchanged" ? head : done(head),
    ...(s
      ? ["", ...fields([
          ["Price", `${money(s.unit_cents)} a machine ${s.billing === "annual" ? "a year" : "a month"}`],
          ["Next payment", `${money(s.amount_cents)} for ${s.quantity} machine${s.quantity === 1 ? "" : "s"} at the renewal, before its settlement and tax`],
          ["Today", "nothing is charged"],
        ])]
      : []),
    "",
    next(r.next),
  ].join("\n");
}

export function billingCommand(): Command {
  const billing = new Command("billing").description("Pay for Personal or Team: per machine day with jobs, never per minute");
  billing.addCommand(
    new Command("checkout")
      .description("Opens Paddle's checkout for the account's plan and answers needs_human with its URL; a person pays there")
      .option("--org <login>", "GitHub organisation or user that pays")
      .option("--plan <plan>", "personal for a personal account, team for an organisation")
      .option("--annual", "billed annually ($8 or $20 a machine a month) instead of monthly ($10 or $24)")
      .option("--api-url <url>", "control plane URL")
      .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
      .option("--json", "JSON output")
      .action(async (opts: BillingCheckoutOptions) => {
        emit(await runBillingCheckout(opts), opts, prettyBillingCheckout);
      }),
  );
  billing.addCommand(
    new Command("period")
      .description("Switches between annual and monthly billing at the next renewal; nothing is charged now. Read-only without --yes")
      .option("--org <login>", "GitHub organisation or user that pays")
      .option("--billing <period>", "annual or monthly; the period billed now drops a scheduled switch")
      .option("--yes", "make the switch; without it the command only says what would happen")
      .option("--api-url <url>", "control plane URL")
      .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
      .option("--json", "JSON output")
      .action(async (opts: BillingPeriodOptions) => {
        emit(await runBillingPeriod(opts), opts, prettyBillingPeriod);
      }),
  );
  return billing;
}
