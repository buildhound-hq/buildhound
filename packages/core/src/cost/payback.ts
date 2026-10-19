/**
 * The monthly saving on machines a team already has (COST_MODEL.md, "Monthly saving on machines you already have").
 * All money in integer cents. Nothing is bought, so no hardware is priced and there is no payback period
 * (the founder, 2026-10-15): the saving is the GitHub-hosted spend that would move, less the plan's monthly fee
 * per machine needed.
 */

export interface MonthlySavingInput {
  hostedCentsPerMonth: number;
  /** The plan's monthly price per machine, never the cheaper annual one: 1000 for Pro, 0 for Free (ADR-039). */
  machineFeeCents: number;
  /** Peak concurrent jobs among the jobs that would move. */
  peakConcurrency?: number;
  /** Jobs at once per machine; 2 for macOS guests. */
  capacityPerMachine?: number;
}

export interface MonthlySaving {
  /** Zero or below means no saving at this spend: the machines add speed, not savings. */
  monthlySavingCents: number;
  machinesNeeded: number;
}

export function monthlySaving(i: MonthlySavingInput): MonthlySaving {
  const capacity = i.capacityPerMachine ?? 2;
  const machinesNeeded = Math.max(1, Math.ceil((i.peakConcurrency ?? 1) / capacity));
  return { monthlySavingCents: i.hostedCentsPerMonth - i.machineFeeCents * machinesNeeded, machinesNeeded };
}

/**
 * Deprecated: a $899 Mac mini's price, no longer shown anywhere (2026-10-15). Kept only to fill the `hardware_cents`
 * fields that the published CLI's JSON, stored public reports and older dashboards still carry.
 */
export const DEFAULT_HARDWARE_CENTS = 89900;

export interface PaybackInput extends MonthlySavingInput {
  /** Purchase price; default `DEFAULT_HARDWARE_CENTS`. */
  hardwareCents?: number;
}

export interface Payback extends MonthlySaving {
  paybackMonths: number | null;
}

/**
 * Deprecated: `monthlySaving` plus the months to pay back a purchase. Not shown since 2026-10-15; it only fills the
 * `payback_months` and `months` fields kept for compatibility.
 */
export function payback(i: PaybackInput): Payback {
  const hardware = i.hardwareCents ?? DEFAULT_HARDWARE_CENTS;
  const s = monthlySaving(i);
  const paybackMonths = s.monthlySavingCents > 0 ? Math.ceil((hardware * s.machinesNeeded) / s.monthlySavingCents) : null;
  return { ...s, paybackMonths };
}
