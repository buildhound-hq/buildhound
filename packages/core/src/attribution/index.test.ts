import { describe, expect, it } from "vitest";
import { attribute } from "./index";

describe("attribute", () => {
  it("scheduled runs are scheduled regardless of actor", () => {
    expect(attribute({ actorLogin: "beny", headBranch: "main", event: "schedule" })).toEqual({ kind: "scheduled", agentName: null });
  });
  it("known agent logins and branch prefixes are agents", () => {
    expect(attribute({ actorLogin: "copilot-swe-agent[bot]", headBranch: "x", event: "push" }).agentName).toBe("copilot");
    expect(attribute({ actorLogin: "beny", headBranch: "claude/fix-123", event: "pull_request" })).toEqual({ kind: "agent", agentName: "claude" });
  });
  it("bots and humans", () => {
    expect(attribute({ actorLogin: "dependabot[bot]", headBranch: "x", event: "push" }).kind).toBe("bot");
    expect(attribute({ actorLogin: "beny", headBranch: "feature", event: "push" }).kind).toBe("human");
    expect(attribute({ actorLogin: null, headBranch: null, event: "push" }).kind).toBe("unknown");
  });
  it("co-author trailers", () => {
    expect(attribute({ actorLogin: "beny", headBranch: "f", event: "push", coAuthors: ["Claude <noreply@anthropic.com>"] }).agentName).toBe("claude");
  });
});
