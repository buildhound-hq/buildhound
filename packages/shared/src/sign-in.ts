import { z } from "zod";

// Sign-in (ADR-038): the dashboard's server calls these on the control plane over the bridge, never a browser.

export const SignInMethod = z.enum(["github", "google", "passkey", "email"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/**
 * Who is signed in, answered by every sign-in and by POST /v1/auth/session. `github` is null until the person connects
 * GitHub, or after GitHub stopped accepting the stored token; `github_login` then says which account to reconnect.
 */
export const SignInResponse = z.object({
  user_id: z.string().uuid(),
  email: z.string().nullable(),
  github_login: z.string().nullable(),
  github: z
    .object({
      login: z.string(),
      token: z.string(),
      /** ISO time the access token expires; null when the App does not expire tokens. */
      expires_at: z.string().nullable(),
    })
    .nullable(),
});
export type SignInResponse = z.infer<typeof SignInResponse>;

/** POST /v1/auth/email/start: sent, or not, and never whether the address has an account. */
export const EmailCodeSent = z.object({
  status: z.literal("sent"),
  expires_in_seconds: z.number().int(),
  resend_after_seconds: z.number().int(),
});
export type EmailCodeSent = z.infer<typeof EmailCodeSent>;

/** GET /v1/auth/passkeys: a person's passkeys, for Profile. */
export const PasskeyList = z.object({
  passkeys: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      created_at: z.string(),
      last_used_at: z.string().nullable(),
    }),
  ),
});
export type PasskeyList = z.infer<typeof PasskeyList>;
