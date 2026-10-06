import type { NormalisedConcurrency, NormalisedJob, NormalisedMatrix, NormalisedStep, NormalisedWorkflow } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): string[] | null => (v === undefined || v === null ? null : Array.isArray(v) ? v.map(String) : [String(v)]);

function concurrency(v: unknown): NormalisedConcurrency | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return { group: v, cancelInProgress: null };
  if (isObj(v)) {
    const c = v["cancel-in-progress"];
    return { group: v.group === undefined ? null : String(v.group), cancelInProgress: typeof c === "boolean" || typeof c === "string" ? c : null };
  }
  return null;
}

function matrix(strategy: unknown): NormalisedMatrix | null {
  if (!isObj(strategy) || !isObj(strategy.matrix)) return null;
  const m = strategy.matrix;
  const axes: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "include" || k === "exclude") continue;
    if (Array.isArray(v)) axes[k] = v;
  }
  const include = Array.isArray(m.include) ? m.include : [];
  const exclude = Array.isArray(m.exclude) ? m.exclude : [];
  const base = Object.values(axes).reduce((n, a) => n * Math.max(1, a.length), Object.keys(axes).length ? 1 : 0);
  return { axes, include, exclude, size: Math.max(1, base + include.length - exclude.length) };
}

function steps(v: unknown): NormalisedStep[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((s) => ({
    name: s.name === undefined ? null : String(s.name),
    uses: s.uses === undefined ? null : String(s.uses),
    run: s.run === undefined ? null : String(s.run),
    with: isObj(s.with) ? s.with : {},
  }));
}

function runsOn(v: unknown, m: NormalisedMatrix | null): string[] {
  const raw = v === undefined ? [] : Array.isArray(v) ? v.map(String) : isObj(v) && Array.isArray(v.labels) ? v.labels.map(String) : [String(v)];
  // Resolve ${{ matrix.<axis> }} to the literal values when the axis is literal.
  const out: string[] = [];
  for (const label of raw) {
    const mm = label.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/);
    const axis = mm?.[1];
    if (mm && m && axis && m.axes[axis]) out.push(...m.axes[axis]!.map(String));
    else if (mm && m && axis) {
      // Axis values that live only in `include:` entries, as in matrices built from a list of targets.
      const fromInclude = m.include.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && axis in e).map((e) => String(e[axis]));
      if (fromInclude.length) out.push(...new Set(fromInclude));
      else out.push(label);
    } else out.push(label);
  }
  return out;
}

/** Turn the parsed YAML object of a workflow into the normalised model rules operate on. */
export function normaliseWorkflow(raw: unknown): NormalisedWorkflow {
  const w = isObj(raw) ? raw : {};
  const on = w.on ?? w[true as unknown as string]; // the `on:` key parses as boolean true under YAML 1.1 in some readers
  let events: string[] = [];
  let schedules: string[] = [];
  let pushBranches: string[] | null = null, pushTags: string[] | null = null, prBranches: string[] | null = null, prTypes: string[] | null = null;
  if (typeof on === "string") events = [on];
  else if (Array.isArray(on)) events = on.map(String);
  else if (isObj(on)) {
    events = Object.keys(on);
    const sched = on.schedule;
    if (Array.isArray(sched)) schedules = sched.filter(isObj).map((s) => String(s.cron ?? "")).filter(Boolean);
    const push = on.push;
    if (isObj(push)) { pushBranches = asList(push.branches); pushTags = asList(push.tags); }
    const pr = on.pull_request;
    if (isObj(pr)) { prBranches = asList(pr.branches); prTypes = asList(pr.types); }
  }
  const jobsRaw = isObj(w.jobs) ? w.jobs : {};
  const jobs: NormalisedJob[] = Object.entries(jobsRaw).filter(([, j]) => isObj(j)).map(([id, j]) => {
    const job = j as Obj;
    const m = matrix(job.strategy);
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];
    return {
      id,
      name: job.name === undefined ? null : String(job.name),
      runsOn: runsOn(job["runs-on"], m),
      needs,
      timeoutMinutes: typeof job["timeout-minutes"] === "number" ? job["timeout-minutes"] : null,
      steps: steps(job.steps),
      matrix: m,
      concurrency: concurrency(job.concurrency),
      if: job.if === undefined ? null : String(job.if),
      usesContainer: job.container !== undefined,
      usesServices: job.services !== undefined,
    };
  });
  return {
    name: w.name === undefined ? null : String(w.name),
    events, schedules, pushBranches, pushTags, pullRequestBranches: prBranches, pullRequestTypes: prTypes,
    concurrency: concurrency(w.concurrency),
    jobs,
  };
}
