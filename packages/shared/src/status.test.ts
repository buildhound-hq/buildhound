import { describe, expect, it } from "vitest";
import { StatusResponse, worstStatus } from "./status";

describe("status schema", () => {
  it("takes the worst component status", () => {
    expect(worstStatus([])).toBe("operational");
    expect(worstStatus(["operational", "degraded", "operational"])).toBe("degraded");
    expect(worstStatus(["degraded", "outage", "operational"])).toBe("outage");
  });
  it("accepts a response with an optional detail and rejects an unknown component", () => {
    const at = "2026-10-15T12:00:00.000Z";
    const ok = StatusResponse.safeParse({ status: "operational", checked_at: at, components: [{ id: "api", name: "API", status: "operational", checked_at: at }] });
    expect(ok.success).toBe(true);
    const bad = StatusResponse.safeParse({ status: "operational", checked_at: at, components: [{ id: "machines", name: "Machines", status: "operational", checked_at: at }] });
    expect(bad.success).toBe(false);
  });
  it("keeps history and incidents optional, so answers without them still parse", () => {
    const at = "2026-10-15T12:00:00.000Z";
    const day = { date: "2026-10-15", state: "no_data", degraded_minutes: 0, outage_minutes: 0, incident_ids: [] };
    const full = StatusResponse.safeParse({
      status: "operational",
      checked_at: at,
      components: [{ id: "webhooks", name: "GitHub webhooks", status: "operational", checked_at: at, uptime_90d: null, days: [day] }],
      active_incidents: [],
    });
    expect(full.success).toBe(true);
    expect(StatusResponse.safeParse({ status: "degraded", checked_at: at, components: [] }).success).toBe(true);
  });
});
