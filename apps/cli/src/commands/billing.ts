import { Command } from "commander";
import { EXIT, type CheckoutResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { CliError, emit } from "../output";
import { fields, money, needed, next } from "../lib/style";

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
      ["After that", "each renewal settles what the machines that ran jobs actually used"],
      ["Refund", "the first payment, on request within 30 days"],
    ]),
    "",
    next(r.next),
  ].join("\n");
}

export function billingCommand(): Command {
  const billing = new Command("billing").description("Pay for Personal or Team: per machine that ran jobs, never per minute");
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
  return billing;
}
