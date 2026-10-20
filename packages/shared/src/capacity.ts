import { z } from "zod";

/** One label's capacity over the last 7 days: the slots the Fleet offers it now against the most jobs it was asked for at once, and the wait that came from every slot being full. */
export const CapacityLine = z.object({
  label: z.string(),
  /** Slots the connected machines (routing not off) offer the label now, from their last heartbeats. */
  slots: z.number().int(),
  /** The machines that offer them, most slots first. */
  machines: z.array(z.object({ id: z.string(), name: z.string(), slots: z.number().int() })),
  /** The most jobs queued or running at once for the label in the week. */
  peak_demand: z.number().int(),
  /** Whole minutes in which every slot ran a job while at least one more waited. */
  saturated_minutes: z.number().int(),
  /** Seconds jobs waited in those minutes, added up over the waiting jobs. */
  wait_seconds_from_saturation: z.number().int(),
});
export type CapacityLine = z.infer<typeof CapacityLine>;
