import { isMap, isSeq, type Document } from "yaml";
import { classify } from "../cost/classify";
import type { History, JobRecord, NormalisedJob, NormalisedStep } from "../model/types";
import { ruleById } from "./registry";
import { cacheTemplate, type CacheEcosystem } from "./templates/cache";
import type { Detection, Rule, RuleContext } from "./types";

/** Minutes an uncached install step is assumed to take when history has no figure (COST_MODEL.md). */
const DEFAULT_INSTALL_MINUTES = 1.5;
const SAVED_SHARE = 0.6;

interface InstallPattern {
  re: RegExp;
  ecosystem: CacheEcosystem;
  manager: string;
  /** What the step name is expected to contain in history (`Run npm ci`). */
  command: string;
}

const INSTALL_PATTERNS: InstallPattern[] = [
  { re: /(^|[\s;&|])npm\s+ci\b/m, ecosystem: "node", manager: "npm", command: "npm ci" },
  { re: /(^|[\s;&|])npm\s+(install|i)\b/m, ecosystem: "node", manager: "npm", command: "npm install" },
  { re: /(^|[\s;&|])pnpm\s+(install|i)\b/m, ecosystem: "node", manager: "pnpm", command: "pnpm install" },
  { re: /(^|[\s;&|])yarn(\s+install\b|\s*$)/m, ecosystem: "node", manager: "yarn", command: "yarn" },
  { re: /(^|[\s;&|])(pip3?|python3?\s+-m\s+pip)\s+install\b/m, ecosystem: "python", manager: "pip", command: "pip install" },
  { re: /(^|[\s;&|])poetry\s+install\b/m, ecosystem: "python", manager: "poetry", command: "poetry install" },
  { re: /(^|[\s;&|])bundle\s+install\b/m, ecosystem: "ruby", manager: "bundler", command: "bundle install" },
  { re: /(^|[\s;&|])cargo\s+build\b/m, ecosystem: "rust", manager: "cargo", command: "cargo build" },
  { re: /(^|[\s;&|])go\s+(build|mod\s+download)\b/m, ecosystem: "go", manager: "go", command: "go build" },
  { re: /(^|[\s;&|])(\.\/)?gradlew?\b/m, ecosystem: "java", manager: "gradle", command: "gradle" },
  { re: /(^|[\s;&|])mvn\b/m, ecosystem: "java", manager: "maven", command: "mvn" },
  { re: /(^|[\s;&|])pod\s+install\b/m, ecosystem: "cocoapods", manager: "cocoapods", command: "pod install" },
  { re: /(^|[\s;&|])swift\s+package\s+resolve\b/m, ecosystem: "swift", manager: "swiftpm", command: "swift package resolve" },
];

/** The setup action that owns caching for each ecosystem, and the `cache:` value per manager. */
const SETUP_ACTIONS: Partial<Record<CacheEcosystem, { action: string; input: string; value: (manager: string) => unknown }>> = {
  node: { action: "actions/setup-node", input: "cache", value: (m) => m },
  python: { action: "actions/setup-python", input: "cache", value: (m) => m },
  go: { action: "actions/setup-go", input: "cache", value: () => true },
  java: { action: "actions/setup-java", input: "cache", value: (m) => m },
  ruby: { action: "ruby/setup-ruby", input: "bundler-cache", value: () => true },
};

const actionRepo = (uses: string): string => uses.split("@")[0]!;
const actionVersion = (uses: string): string => uses.split("@")[1] ?? "";
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== "" && v !== "false";

function findInstall(run: string): InstallPattern | null {
  const script = run.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  return INSTALL_PATTERNS.find((p) => p.re.test(script)) ?? null;
}

/** Ecosystems the job already caches, or "all" when a generic actions/cache step exists. */
function cachedEcosystems(steps: NormalisedStep[]): Set<CacheEcosystem> | "all" {
  const out = new Set<CacheEcosystem>();
  for (const s of steps) {
    if (!s.uses) continue;
    const repo = actionRepo(s.uses);
    if (repo === "actions/cache" || repo === "actions/cache/restore") return "all";
    if (repo === "actions/setup-node" && truthy(s.with.cache)) out.add("node");
    if (repo === "actions/setup-python" && truthy(s.with.cache)) out.add("python");
    if (repo === "actions/setup-go") {
      const legacy = /^v[1-3](\.|$)/.test(actionVersion(s.uses));
      if (s.with.cache === undefined ? !legacy : truthy(s.with.cache)) out.add("go");
    }
    if (repo === "actions/setup-java" && truthy(s.with.cache)) out.add("java");
    if (repo === "Swatinem/rust-cache") out.add("rust");
    if (repo === "ruby/setup-ruby" && truthy(s.with["bundler-cache"])) out.add("ruby");
    if (repo === "gradle/actions/setup-gradle" || repo === "gradle/gradle-build-action") out.add("java");
    if (repo === "astral-sh/setup-uv" && truthy(s.with["enable-cache"])) out.add("python");
  }
  return out;
}

function historyJobs(history: History | null, job: NormalisedJob): JobRecord[] {
  const name = job.name ?? job.id;
  return history?.jobs.filter((j) => j.name === name || j.name.startsWith(name + " (")) ?? [];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function medianInstallSeconds(jobs: JobRecord[], step: NormalisedStep, pattern: InstallPattern): number | null {
  const durations: number[] = [];
  for (const j of jobs) {
    for (const s of j.steps) {
      if (s.name.includes(pattern.command) || (step.name !== null && s.name === step.name)) durations.push(s.durationSeconds);
    }
  }
  const m = median(durations);
  return m === null ? null : Math.round(m);
}

function stepLabel(s: NormalisedStep, index: number): string {
  return s.name ?? s.run?.split("\n").find((l) => l.trim())?.trim() ?? `step ${index + 1}`;
}

export const R05: Rule = {
  meta: ruleById("R05")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, path } = ctx.workflow;
    const runsPerMonth = Object.values(ctx.estimator.runsByEvent(model, ctx.history, path).byEvent).reduce((a, b) => a + b, 0);
    const out: Detection[] = [];
    for (const job of model.jobs) {
      const cached = cachedEcosystems(job.steps);
      if (cached === "all") continue;
      const index = job.steps.findIndex((s) => s.run && findInstall(s.run) && !cached.has(findInstall(s.run)!.ecosystem));
      if (index < 0) continue;
      const step = job.steps[index]!;
      const pattern = findInstall(step.run!)!;
      const setup = SETUP_ACTIONS[pattern.ecosystem];
      const setupIndex = setup ? job.steps.findIndex((s) => s.uses && actionRepo(s.uses) === setup.action) : -1;
      const jobs = historyJobs(ctx.history, job);
      const observedSeconds = medianInstallSeconds(jobs, step, pattern);
      const installMinutes = observedSeconds === null ? DEFAULT_INSTALL_MINUTES : observedSeconds / 60;
      const entries = job.matrix?.size ?? 1;
      const c = classify(job.runsOn);
      const price = !ctx.repository.private && c.provider === "github" ? 0 : c.pricePerMinute;
      const savedMinutes = Math.round(runsPerMonth * entries * installMinutes * SAVED_SHARE);
      const template = cacheTemplate(pattern.manager);
      if (setupIndex < 0 && !template) continue;
      out.push({
        jobId: job.id,
        evidence: {
          installStep: stepLabel(step, index),
          installCommand: pattern.command,
          ecosystem: pattern.ecosystem,
          manager: pattern.manager,
          medianInstallSeconds: observedSeconds,
          runsPerMonth,
          matrixEntries: entries,
          fixKind: setupIndex >= 0 ? `cache input on ${setup!.action}` : "actions/cache step",
        },
        estimate: { minutesPerMonth: savedMinutes, centsPerMonth: Math.round(savedMinutes * price * 100), confidence: observedSeconds === null ? 0.4 : 0.6 },
        summary: `Job "${job.id}" runs "${pattern.command}" with no dependency cache`,
        fix: (d: Document) => {
          const steps = d.getIn(["jobs", job.id, "steps"], true);
          if (!isSeq(steps)) return;
          if (setupIndex >= 0 && setup) {
            const setupStep = steps.items[setupIndex];
            if (!isMap(setupStep)) return;
            if (!setupStep.has("with")) setupStep.set("with", d.createNode({}));
            const withMap = setupStep.get("with", true);
            if (isMap(withMap)) withMap.set(setup.input, setup.value(pattern.manager));
            return;
          }
          steps.items.splice(index, 0, d.createNode(template!));
        },
      });
    }
    return out;
  },
};
