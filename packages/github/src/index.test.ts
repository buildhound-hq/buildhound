import { describe, expect, it } from "vitest";
import { sign } from "@octokit/webhooks-methods";
import { shouldDropAtEdge, verifyWebhookSignature } from "./index";

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature and rejects a bad one", async () => {
    const secret = "s3cret";
    const body = JSON.stringify({ action: "completed" });
    const sig = await sign(secret, body);
    expect(await verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(await verifyWebhookSignature(secret, body, "sha256=deadbeef")).toBe(false);
    expect(await verifyWebhookSignature(secret, body, null)).toBe(false);
  });
});

describe("shouldDropAtEdge", () => {
  it("drops queued workflow_job unless it targets a buildhound label", () => {
    expect(shouldDropAtEdge("workflow_job", "queued", ["ubuntu-latest"])).toBe(true);
    expect(shouldDropAtEdge("workflow_job", "queued", ["buildhound-macos"])).toBe(false);
    expect(shouldDropAtEdge("workflow_job", "completed", ["ubuntu-latest"])).toBe(false);
  });
  it("keeps only the pull_request actions we use", () => {
    expect(shouldDropAtEdge("pull_request", "labeled")).toBe(true);
    expect(shouldDropAtEdge("pull_request", "synchronize")).toBe(false);
  });
});
