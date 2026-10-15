import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prettyPlan, type PlanResult } from "./commands/account";
import { prettyBillingCheckout, type BillingCheckoutResult } from "./commands/billing";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "index.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));

const bodies: unknown[] = [];

/** The control plane's billing routes for `acme` (an organisation) and `paid` (subscribed already). */
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c: string) => (text += c));
  req.on("end", () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
    const body = text ? (JSON.parse(text) as { plan: string; billing: string }) : null;
    bodies.push(body);
    if (req.method === "POST" && req.url === "/v1/accounts/acme/billing/checkout") {
      if (body?.plan !== "team") return send(400, { error: { code: "PLAN_MISMATCH", message: "acme is an organisation, which subscribes to Team", next: "buildhound billing checkout --org acme --plan team" } });
      const annual = body.billing === "annual";
      return send(200, {
        status: "needs_human",
        reason: "checkout",
        url: "https://app.buildhound.sh/acme/settings/billing?_ptxn=txn_1",
        next: "buildhound plan --org acme",
        checkout: { transaction_id: "txn_1", price_id: annual ? "pri_year" : "pri_month", quantity: 2, plan: "team", billing: body.billing, amount_cents: annual ? 48000 : 4800, customer_id: null, custom_data: { account_id: "50", plan: "team", login: "acme" }, environment: "sandbox" },
      });
    }
    if (req.method === "POST" && req.url === "/v1/accounts/paid/billing/checkout") return send(409, { error: { code: "ALREADY_SUBSCRIBED", message: "paid already has Team", next: "buildhound plan --org paid" } });
    send(404, { error: { code: "NOT_FOUND", message: "not found", next: "buildhound plan --org acme" } });
  });
});
let apiUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

type Out = Record<string, unknown> & { error?: { code: string; next: string } };

/** No TTY, no `gh`, nothing on PATH: the agent's view (AGENT_FIRST.md, What is tested). */
async function cli(args: string[]) {
  const env = { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl };
  try {
    const { stdout } = await run(process.execPath, [tsx, entry, ...args], { env });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return { code: 0, json: JSON.parse(lines[0]!) as Out };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, json: JSON.parse(err.stdout.trim()) as Out };
  }
}

describe("agentfirst: billing checkout", () => {
  it("agentfirst: billing checkout answers needs_human with Paddle's checkout URL and exits 0, monthly unless --annual", async () => {
    const r = await cli(["billing", "checkout", "--org", "acme", "--plan", "team"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: "needs_human", reason: "checkout", url: "https://app.buildhound.sh/acme/settings/billing?_ptxn=txn_1", next: "buildhound plan --org acme", owner: "acme", checkout: { quantity: 2, billing: "monthly" } });
    expect(bodies.at(-1)).toEqual({ plan: "team", billing: "monthly" });
    const annual = await cli(["billing", "checkout", "--org", "acme", "--plan", "team", "--annual"]);
    expect(annual.json).toMatchObject({ status: "needs_human", checkout: { billing: "annual", amount_cents: 48000 } });
    expect(bodies.at(-1)).toEqual({ plan: "team", billing: "annual" });
  });

  it("agentfirst: billing checkout without --org or --plan fails USAGE with next, and calls nothing", async () => {
    const before = bodies.length;
    const noOrg = await cli(["billing", "checkout", "--plan", "team"]);
    expect(noOrg.code).toBe(2);
    expect(noOrg.json.error).toMatchObject({ code: "USAGE", next: expect.stringContaining("--org") });
    const noPlan = await cli(["billing", "checkout", "--org", "acme"]);
    expect(noPlan.json.error).toMatchObject({ code: "USAGE", next: "buildhound billing checkout --org acme --plan team" });
    expect(bodies.length).toBe(before);
  });

  it("agentfirst: the wrong plan and a second subscription come back as error envelopes with next", async () => {
    const wrong = await cli(["billing", "checkout", "--org", "acme", "--plan", "personal"]);
    expect(wrong.code).toBe(2);
    expect(wrong.json.error).toMatchObject({ code: "PLAN_MISMATCH", next: "buildhound billing checkout --org acme --plan team" });
    const paid = await cli(["billing", "checkout", "--org", "paid", "--plan", "team"]);
    expect(paid.json.error).toMatchObject({ code: "ALREADY_SUBSCRIBED", next: "buildhound plan --org paid" });
  });

  it("agentfirst: billing without a subcommand fails USAGE in JSON", async () => {
    const r = await cli(["billing"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: "USAGE", next: expect.any(String) });
  });
});

describe("billing output for people", () => {
  it("says a person pays, what the first payment is, and what comes next", () => {
    const text = prettyBillingCheckout({
      owner: "acme",
      status: "needs_human",
      reason: "checkout",
      url: "https://app.buildhound.sh/acme/settings/billing?_ptxn=txn_1",
      next: "buildhound plan --org acme",
      checkout: { transaction_id: "txn_1", price_id: "pri", quantity: 2, plan: "team", billing: "annual", amount_cents: 48000, customer_id: null, custom_data: {}, environment: "sandbox" },
    } as BillingCheckoutResult);
    expect(text).toContain("Team for acme needs a person to pay\n  open https://app.buildhound.sh/acme/settings/billing?_ptxn=txn_1");
    expect(text).toContain("$480.00 for 2 machines, billed annually, plus tax");
    expect(text).not.toMatch(/per minute/);
  });

  it("plan shows the subscription: billing period, machines paid for and the next payment", () => {
    const r: PlanResult = {
      owner: "acme",
      role: "admin",
      plan: "team",
      effective: "team",
      trial_ends_at: null,
      valid_until: "2026-11-19T09:00:00.000Z",
      machines: 2,
      billable_machines: 1.5,
      price_per_machine_cents: 2400,
      price_per_machine_annual_cents: 24000,
      free_machine_limit: 2,
      checkout_next: "buildhound billing checkout --org acme --plan team",
      checkout_url: "https://app.buildhound.sh/acme/settings/billing",
      next: "buildhound savings --org acme",
      subscription: { status: "active", billing: "monthly", quantity: 2, period: { start: "2026-10-16T09:00:00.000Z", end: "2026-11-16T09:00:00.000Z" }, renews_at: "2026-11-16T09:00:00.000Z", cancel_at: null, next_bill_estimate_cents: 3600, credit_cents: 0 },
    };
    const text = prettyPlan(r);
    expect(text).toMatch(/Billing\s+monthly, renews Nov 16, 2026/);
    expect(text).toMatch(/Paid for\s+2 machines this period/);
    expect(text).toMatch(/Next payment\s+about \$36\.00 before tax/);
    expect(prettyPlan({ ...r, subscription: { ...r.subscription!, cancel_at: "2026-11-16T09:00:00.000Z", next_bill_estimate_cents: null } })).toMatch(/Billing\s+monthly, ends Nov 16, 2026/);
  });
});
