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
  /** Minutes the check ran that day (2026-10-20), for the day's own uptime; absent from older servers. */
  checked_minutes: z.number().int().nonnegative().optional(),
  incident_ids: z.array(z.string()),
});
export type StatusDay = z.infer<typeof StatusDay>;

export const StatusComponent = z.object({
  id: StatusComponentId,
  name: z.string(),
  status: ComponentStatus,
  detail: z.string().optional(),
  checked_at: z.string().datetime(),
  /** Percent, two decimals, rounded down: 1 minus outage minutes over measured minutes in the 90 days; null when none were measured. Absent when history could not be read. */
  uptime_90d: z.number().min(0).max(100).nullable().optional(),
  /** The 90 UTC days ending today, oldest first. Absent when history could not be read. */
  days: z.array(StatusDay).optional(),
});
export type StatusComponent = z.infer<typeof StatusComponent>;

const rank: Record<ComponentStatus, number> = { operational: 0, degraded: 1, outage: 2 };

/** The worst of the given statuses; operational when there are none. */
export function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  return statuses.reduce<ComponentStatus>((worst, s) => (rank[s] > rank[worst] ? s : worst), "operational");
}

/** An incident's state, from its latest update. */
export const IncidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const StatusIncidentUpdate = z.object({
  id: z.string(),
  status: IncidentStatus,
  body: z.string(),
  created_at: z.string().datetime(),
});
export type StatusIncidentUpdate = z.infer<typeof StatusIncidentUpdate>;

/** An incident with its updates, newest first. `resolved_at` is null while it is open. */
export const StatusIncident = z.object({
  id: z.string(),
  title: z.string(),
  status: IncidentStatus,
  components: z.array(StatusComponentId),
  started_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  updates: z.array(StatusIncidentUpdate),
});
export type StatusIncident = z.infer<typeof StatusIncident>;

/** GET /v1/status: `status` is the worst of the components. */
export const StatusResponse = z.object({
  status: ComponentStatus,
  checked_at: z.string().datetime(),
  components: z.array(StatusComponent),
  /** Incidents not yet resolved, newest first, with their updates. Absent when incidents could not be read. */
  active_incidents: z.array(StatusIncident).optional(),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

/** GET /v1/status/incidents?days=7: incidents open at any time in the window, newest first. */
export const StatusIncidentsResponse = z.object({ days: z.number().int(), incidents: z.array(StatusIncident) });
export type StatusIncidentsResponse = z.infer<typeof StatusIncidentsResponse>;

const IncidentBody = z.string().trim().min(1).max(5000);
const IncidentTitle = z.string().trim().min(1).max(200);
const IncidentComponents = z.array(StatusComponentId).min(1).max(5);

/** POST /v1/status/incidents (admin): opens an incident with its first update. Send the same `id` to retry safely. */
export const CreateIncidentRequest = z.object({
  id: z.string().uuid().optional(),
  title: IncidentTitle,
  status: IncidentStatus.default("investigating"),
  components: IncidentComponents,
  body: IncidentBody,
  started_at: z.string().datetime().optional(),
});
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequest>;

/** POST /v1/status/incidents/:id/updates (admin): a timestamped update; `resolved` closes the incident. */
export const IncidentUpdateRequest = z.object({ id: z.string().uuid().optional(), status: IncidentStatus, body: IncidentBody });
export type IncidentUpdateRequest = z.infer<typeof IncidentUpdateRequest>;

/** PATCH /v1/status/incidents/:id (admin): corrects the title, components or start. */
export const EditIncidentRequest = z
  .object({ title: IncidentTitle.optional(), components: IncidentComponents.optional(), started_at: z.string().datetime().optional() })
  .refine((e) => e.title !== undefined || e.components !== undefined || e.started_at !== undefined, { message: "change at least one of title, components, started_at" });
export type EditIncidentRequest = z.infer<typeof EditIncidentRequest>;
