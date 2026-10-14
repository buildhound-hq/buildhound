import { z } from "zod";

/** Every CLI and MCP error carries a code, a message and the next command that fixes it. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    next: z.string(),
    example: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Returned when GitHub or payment forces a human step. Exit code is 0 so the agent can continue. */
export const NeedsHuman = z.object({
  status: z.literal("needs_human"),
  reason: z.string(),
  url: z.string().url(),
  next: z.string(),
});
export type NeedsHuman = z.infer<typeof NeedsHuman>;

export const Plan = z.enum(["personal", "team", "enterprise", "none"]);
export type Plan = z.infer<typeof Plan>;

export const Provider = z.enum([
  "github",
  "blacksmith",
  "depot",
  "warpbuild",
  "ubicloud",
  "jog",
  "runs_on",
  "namespace",
  "buildhound",
  "self_hosted",
  "unknown",
]);
export type Provider = z.infer<typeof Provider>;

export const Os = z.enum(["linux", "windows", "macos", "unknown"]);
export type Os = z.infer<typeof Os>;

export const EXIT = { ok: 0, findings: 1, usage: 2, auth: 3, network: 4 } as const;

export * from "./control-plane";
export * from "./dashboard";
