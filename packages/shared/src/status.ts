import { z } from "zod";

// The website's status page (B13.4; CONTROL_PLANE_API.md, Status). Public and unauthenticated, so nothing here
// names an account, a machine or an internal host: each component has a fixed id, a name and a short plain detail.

export const ComponentStatus = z.enum(["operational", "degraded", "outage"]);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

export const StatusComponentId = z.enum(["api", "database", "webhooks", "failover", "downloads"]);
export type StatusComponentId = z.infer<typeof StatusComponentId>;

export const StatusComponent = z.object({
  id: StatusComponentId,
  name: z.string(),
  status: ComponentStatus,
  detail: z.string().optional(),
  checked_at: z.string().datetime(),
});
export type StatusComponent = z.infer<typeof StatusComponent>;

/** GET /v1/status: `status` is the worst of the components. */
export const StatusResponse = z.object({
  status: ComponentStatus,
  checked_at: z.string().datetime(),
  components: z.array(StatusComponent),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

const rank: Record<ComponentStatus, number> = { operational: 0, degraded: 1, outage: 2 };

/** The worst of the given statuses; operational when there are none. */
export function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  return statuses.reduce<ComponentStatus>((worst, s) => (rank[s] > rank[worst] ? s : worst), "operational");
}
