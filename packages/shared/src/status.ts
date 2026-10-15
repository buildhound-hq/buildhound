import { z } from "zod";

// The website's status page (B13.4; CONTROL_PLANE_API.md, Status). Public and unauthenticated, so nothing here
// names an account, a machine or an internal host: each component has a fixed id, a name and a short plain detail.

export const ComponentStatus = z.enum(["operational", "degraded", "outage"]);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

export const StatusComponentId = z.enum(["api", "dashboard", "webhooks", "failover", "downloads"]);
export type StatusComponentId = z.infer<typeof StatusComponentId>;

/** A day's colour on the page: down if any minute was down, else degraded if any was; `no_data` when nothing was measured. */
export const StatusDayState = z.enum(["operational", "degraded", "outage", "no_data"]);
export type StatusDayState = z.infer<typeof StatusDayState>;

/** One UTC day of a component's 90: `date` is `YYYY-MM-DD`; `incident_ids` are incidents on this component open that day. */
export const StatusDay = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: StatusDayState,
  degraded_minutes: z.number().int().nonnegative(),
  outage_minutes: z.number().int().nonnegative(),
  incident_ids: z.array(z.string()),
});
export type StatusDay = z.infer<typeof StatusDay>;

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
