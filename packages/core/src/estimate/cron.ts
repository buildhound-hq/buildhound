/** Minimal five-field cron matcher: * , - / and names are not needed for counting occurrences. */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min, hi = max;
    if (rangePart !== "*" && rangePart !== undefined) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepPart ? max : Number(a);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step <= 0) continue;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronInfo {
  valid: boolean;
  /** Occurrences in a 30-day window. */
  runsPerMonth: number;
  /** Shortest gap between consecutive occurrences, in minutes. */
  minIntervalMinutes: number;
}

export function cronInfo(expr: string): CronInfo {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return { valid: false, runsPerMonth: 0, minIntervalMinutes: 0 };
  const minutes = parseField(f[0]!, 0, 59), hours = parseField(f[1]!, 0, 23), dom = parseField(f[2]!, 1, 31), months = parseField(f[3]!, 1, 12), dow = parseField(f[4]!, 0, 7);
  if (dow.has(7)) dow.add(0);
  const domAny = f[2] === "*", dowAny = f[4] === "*";
  let count = 0, last = -1, minGap = Infinity;
  const start = Date.UTC(2026, 0, 1);
  for (let t = 0; t < 30 * 24 * 60; t++) {
    const d = new Date(start + t * 60_000);
    const domMatch = dom.has(d.getUTCDate()), dowMatch = dow.has(d.getUTCDay());
    const dayOk = domAny && dowAny ? true : domAny ? dowMatch : dowAny ? domMatch : domMatch || dowMatch;
    if (minutes.has(d.getUTCMinutes()) && hours.has(d.getUTCHours()) && months.has(d.getUTCMonth() + 1) && dayOk) {
      count++;
      if (last >= 0) minGap = Math.min(minGap, t - last);
      last = t;
    }
  }
  return { valid: true, runsPerMonth: count, minIntervalMinutes: minGap === Infinity ? 0 : minGap };
}
