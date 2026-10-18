import { z } from "zod";

/*
 * POST /v1/support (CONTROL_PLANE_API.md, Support): the dashboard's and the website's support form, and the one-click
 * report on the error pages. The browser makes the id, so a retried send is stored and emailed once.
 */

export const SupportKind = z.enum(["question", "bug", "billing", "teams", "error"]);
export type SupportKind = z.infer<typeof SupportKind>;

export const SupportSource = z.enum(["dashboard", "site"]);
export type SupportSource = z.infer<typeof SupportSource>;

const Short = z.string().trim().max(300);

/** A PostHog replay link; anything else is dropped rather than put in the email. */
const ReplayUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => /^https:\/\/(eu|us)\.posthog\.com\//.test(u), "a PostHog replay link");

export const SupportRequest = z
  .object({
    id: z.string().uuid(),
    kind: SupportKind,
    source: SupportSource,
    message: z.string().trim().max(5000),
    email: z.string().trim().email().max(254).optional(),
    name: z.string().trim().max(120).optional(),
    context: z
      .object({
        path: Short.optional(),
        account: Short.optional(),
        reference: Short.optional(),
        error: z.string().trim().max(1000).optional(),
        browser: Short.optional(),
        replay_url: ReplayUrl.optional(),
      })
      .default({}),
  })
  // A person writes a message; an error report is drafted by the page, so it may arrive without one.
  .refine((r) => r.kind === "error" || r.message.length > 0, { message: "write a message", path: ["message"] });
export type SupportRequest = z.infer<typeof SupportRequest>;

export const SupportResponse = z.object({
  id: z.string(),
  /** A short reference to quote, `SR-` and the id's first characters. */
  reference: z.string(),
  status: z.literal("received"),
});
export type SupportResponse = z.infer<typeof SupportResponse>;
