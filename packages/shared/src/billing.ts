import { z } from "zod";

// Billing bodies for docs/CONTROL_PLANE_API.md (BILLING.md, B13.2). Shared by apps/api, apps/web, apps/cli and apps/mcp.

export const BillingPeriodName = z.enum(["monthly", "annual"]);
export type BillingPeriodName = z.infer<typeof BillingPeriodName>;

export const CheckoutRequest = z.object({
  plan: z.enum(["personal", "team"]),
  billing: BillingPeriodName.default("annual"),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/**
 * `POST /v1/accounts/:owner/billing/checkout`: paying is a person's step (AGENT_FIRST.md), so the answer is
 * `needs_human` with Paddle's checkout URL; `checkout` is what the dashboard needs to open Paddle.js on the page.
 */
export const CheckoutResponse = z.object({
  status: z.literal("needs_human"),
  reason: z.literal("checkout"),
  url: z.string(),
  next: z.string(),
  checkout: z.object({
    transaction_id: z.string(),
    price_id: z.string(),
    /** Machines charged for at checkout: those connected now, at least 1. */
    quantity: z.number().int().positive(),
    plan: z.enum(["personal", "team"]),
    billing: BillingPeriodName,
    /** The first payment in cents before tax: `quantity` times the period's price per machine. */
    amount_cents: z.number().int(),
    customer_id: z.string().nullable(),
    custom_data: z.record(z.string()),
    environment: z.enum(["sandbox", "production"]),
  }),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

/** `POST /v1/accounts/:owner/billing/portal`: Paddle's customer portal, where a person updates a card, sees invoices or cancels. */
export const PortalResponse = z.object({
  status: z.literal("needs_human"),
  reason: z.literal("billing_portal"),
  url: z.string(),
  next: z.string(),
});
export type PortalResponse = z.infer<typeof PortalResponse>;

/** The subscription behind a plan, in the plan response; absent without one. */
export const SubscriptionView = z.object({
  status: z.enum(["active", "past_due", "paused", "canceled"]),
  billing: BillingPeriodName,
  /** Machines paid for this period. */
  quantity: z.number().int(),
  period: z.object({ start: z.string(), end: z.string() }),
  /** When the next payment is taken; null when the subscription is set to end. */
  renews_at: z.string().nullable(),
  /** When a scheduled cancellation takes effect: private repositories go back to GitHub-hosted then, and nothing is deleted. */
  cancel_at: z.string().nullable(),
  /**
   * An estimate, not an invoice, in cents before tax: the next payment at today's average, which is the next period's
   * machines in advance plus or minus this period's difference between what was paid and what was used. Null once the
   * subscription is set to end.
   */
  next_bill_estimate_cents: z.number().int().nullable(),
  /** Overpayment still to be given back as a discount on a later payment, cents before tax. */
  credit_cents: z.number().int(),
});
export type SubscriptionView = z.infer<typeof SubscriptionView>;
