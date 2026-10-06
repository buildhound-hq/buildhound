/** Payback for a connected machine (COST_MODEL.md). All money in integer cents. */
export interface PaybackInput {
  hostedCentsPerMonth: number;
  /** 2000 for Team, 0 for Personal. */
  machineFeeCents: number;
  /** Purchase price; default $899 Mac mini. */
  hardwareCents?: number;
  /** Peak concurrent jobs among the jobs that would move. */
  peakConcurrency?: number;
  /** Jobs at once per machine; 2 for macOS guests. */
  capacityPerMachine?: number;
}

export interface Payback {
  monthlySavingCents: number;
  machinesNeeded: number;
  paybackMonths: number | null;
}

export function payback(i: PaybackInput): Payback {
  const hardware = i.hardwareCents ?? 89900;
  const capacity = i.capacityPerMachine ?? 2;
  const machinesNeeded = Math.max(1, Math.ceil((i.peakConcurrency ?? 1) / capacity));
  const monthlySavingCents = i.hostedCentsPerMonth - i.machineFeeCents * machinesNeeded;
  const paybackMonths = monthlySavingCents > 0 ? Math.ceil((hardware * machinesNeeded) / monthlySavingCents) : null;
  return { monthlySavingCents, machinesNeeded, paybackMonths };
}
