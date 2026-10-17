/**
 * The monthly saving on machines a team already has (COST_MODEL.md, "Monthly saving on machines you already have").
 * All money in integer cents. Nothing is bought, so no hardware is priced and there is no payback period
 * (the founder, 2026-10-15): the saving is the GitHub-hosted spend that would move, less the plan's monthly fee
 * per machine needed.
 */

export interface MonthlySavingInput {
  hostedCentsPerMonth: number;
  /** The plan's monthly price per machine, never the cheaper annual one: 2400 for Team, 1000 for Personal, 0 for Free. */
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
 * What the plan costs for a machine's days with jobs in a period, in integer cents (BILLING.md, ADR-033): a machine
 * counts only on UTC days it started a job, each such day is the monthly price over the period's days, and an idle
 * day costs nothing. So a machine that ran one job costs one day of the plan, never a month. The renewal's
 * settlement rounds the account's total to hundredths of a machine, so the invoice can differ by a few cents.
 */
export function machineDaysCents(machineDays: number, periodDays: number, machineFeeCents: number): number {
  if (periodDays <= 0 || machineDays <= 0 || machineFeeCents <= 0) return 0;
  return Math.round((Math.min(machineDays, periodDays) * machineFeeCents) / periodDays);
}

export interface MachineSavingInput {
  /** What GitHub-hosted would have billed for the machine's jobs in the period. */
  hostedCents: number;
  /** UTC days in the period on which the machine started at least one job. */
  machineDays: number;
  /** The period's UTC days: a calendar month's 28 to 31 on the Savings page. */
  periodDays: number;
  /** The plan's monthly price per machine, never the annual one (2400 Team, 1000 Personal, 0 Free). */
  machineFeeCents: number;
}

export interface MachineSaving {
  /** The plan's price for the machine's days with jobs (`machineDaysCents`). */
  planCents: number;
  /** `hostedCents` less `planCents`; below zero when the plan cost more than the jobs would have on GitHub-hosted. */
  savedCents: number;
}

/** One machine's saving after the plan in a period: GitHub-hosted's bill for its jobs less its machine days. */
export function machineSaving(i: MachineSavingInput): MachineSaving {
  const planCents = machineDaysCents(i.machineDays, i.periodDays, i.machineFeeCents);
  return { planCents, savedCents: i.hostedCents - planCents };
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
