import { describe, expect, it } from "vitest";
import { ErrorEnvelope, NeedsHuman, Plan } from "./index";

describe("shared schemas", () => {
  it("accepts a well-formed error envelope", () => {
    const r = ErrorEnvelope.safeParse({
      error: { code: "AUTH_REQUIRED", message: "not logged in", next: "buildhound login" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects an error without a next command", () => {
    const r = ErrorEnvelope.safeParse({ error: { code: "X", message: "y" } });
    expect(r.success).toBe(false);
  });
  it("needs_human carries a url and a next command", () => {
    const r = NeedsHuman.safeParse({
      status: "needs_human",
      reason: "github_app_not_installed",
      url: "https://github.com/apps/buildhound-ci/installations/new",
      next: "buildhound runner add --org acme --label macos",
    });
    expect(r.success).toBe(true);
  });
  it("plans are personal, team, enterprise, none", () => {
    expect(Plan.options).toEqual(["personal", "team", "enterprise", "none"]);
  });
});
