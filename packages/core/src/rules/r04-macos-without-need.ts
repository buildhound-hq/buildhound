import { isScalar, isSeq, type Document } from "yaml";
import { classify, type Classification } from "../cost/classify";
import { githubRateForLabel } from "../cost/rates/github";
import type { History, JobRecord, NormalisedJob, NormalisedStep } from "../model/types";
import { ruleById } from "./registry";
import type { Detection, Rule, RuleContext } from "./types";

/** Runs with both a macOS and a Linux entry needed before a mixed matrix is a candidate. */
const MIN_MATRIX_RUNS = 5;
const LINUX_LABEL = "ubuntu-latest";

const APPLE_RUN_SIGNALS: RegExp[] = [
  /\bxcodebuild\b/,
  /\bxcrun\b/,
  /\bswift\s/,
  /\bfastlane\b/,
  /\bpod\s/,
  /\bxcode-select\b/,
  /\bsimctl\b/,
  /\bnotarytool\b/,
  /\bcodesign\b/,
  /\bflutter\s+build\s+(ios|ipa|macos)\b/,
  /\btauri\s+build\b[^\n]*(apple-darwin|\bdmg\b)/,
  /\belectron-builder\b[^\n]*(\s--mac\b|\s-m\b)/,
];
const APPLE_ACTIONS = ["maxim-lobanov/setup-xcode", "mxcl/xcodebuild"];
const APPLE_REPO_WORDS = /xcode|fastlane|swift|ios|macos/i;

/** Actions that run the same on Linux and macOS; a job made only of these is fully classified. */
const SAFE_ACTIONS = new Set([
  "actions/checkout", "actions/setup-node", "actions/setup-python", "actions/setup-go", "actions/setup-java", "actions/cache",
  "actions/cache/restore", "actions/cache/save", "actions/upload-artifact", "actions/download-artifact", "actions/github-script",
  "pnpm/action-setup", "oven-sh/setup-bun", "denoland/setup-deno", "dtolnay/rust-toolchain", "actions-rust-lang/setup-rust-toolchain",
  "Swatinem/rust-cache", "ruby/setup-ruby", "codecov/codecov-action", "astral-sh/setup-uv", "snok/install-poetry",
]);

/** Binaries that behave the same on Linux; anything else in a run script leaves the step unclassified. */
const SAFE_BINARIES = new Set([
  "npm", "npx", "pnpm", "yarn", "node", "corepack", "bun", "deno", "pip", "pip3", "python", "python3", "poetry", "uv", "pytest", "tox",
  "ruff", "black", "mypy", "flake8", "go", "cargo", "rustup", "rustc", "make", "cmake", "echo", "cat", "ls", "cd", "export", "set",
  "mkdir", "cp", "mv", "rm", "touch", "chmod", "git", "curl", "wget", "bash", "sh", "gradle", "mvn", "bundle", "gem", "ruby", "rake",
  "true", "false", "test", "[", "[[", "printf", "env", "pwd", "sleep", "source", ".", "if", "then", "else", "elif", "fi", "for", "do",
  "done", "while", "case", "esac", "exit", "tar", "unzip", "zip", "sed", "awk", "grep", "find", "xargs", "tee", "sort", "head", "tail",
  "wc", "tr", "cut", "date", "jq", "uname", "which", "composer", "php", "dotnet", "java", "javac", "tsc", "eslint", "prettier",
  "vitest", "jest", "mocha", "turbo", "nx", "lerna", "gh",
]);
const WRAPPERS = new Set(["sudo", "time", "exec", "nohup", "nice"]);

function actionRepo(uses: string): string {
  return uses.split("@")[0]!.replace(/^\.\//, "");
}

function usesAppleAction(uses: string): boolean {
  const repo = actionRepo(uses);
  if (APPLE_ACTIONS.includes(repo)) return true;
  const name = repo.split("/")[1] ?? repo;
  return APPLE_REPO_WORDS.test(name);
}

function runHasAppleSignal(run: string): boolean {
  return APPLE_RUN_SIGNALS.some((re) => re.test(run));
}

/** First binary of every command in a script that is not in the safe list. */
function unknownBinaries(run: string): string[] {
  const out = new Set<string>();
  for (const rawLine of run.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    for (const segment of line.split(/\s*(?:&&|\|\||\||;)\s*/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))) i++;
      const first = tokens[i]?.replace(/^[({]+/, "");
      if (!first || first.startsWith("-") || first.startsWith("$") || first.startsWith("\"") || first.startsWith("'")) continue;
      if (!SAFE_BINARIES.has(first)) out.add(first);
    }
  }
  return [...out];
}

function stepLabel(s: NormalisedStep, index: number): string {
  if (s.name) return s.name;
  if (s.uses) return s.uses;
  if (s.run) return s.run.split("\n").find((l) => l.trim())?.trim() ?? `step ${index + 1}`;
  return `step ${index + 1}`;
}

interface Classified {
  apple: boolean;
  unclassified: string[];
}

function classifySteps(steps: NormalisedStep[]): Classified {
  const unclassified: string[] = [];
  let apple = false;
  steps.forEach((s, i) => {
    if (s.uses) {
      if (usesAppleAction(s.uses)) apple = true;
      else if (!SAFE_ACTIONS.has(actionRepo(s.uses))) unclassified.push(stepLabel(s, i));
      return;
    }
    if (s.run) {
      if (runHasAppleSignal(s.run)) { apple = true; return; }
      const unknown = unknownBinaries(s.run);
      if (unknown.length) unclassified.push(`${stepLabel(s, i)} (${unknown.join(", ")})`);
    }
  });
  return { apple, unclassified };
}

function historyJobs(history: History | null, job: NormalisedJob): JobRecord[] {
  const name = job.name ?? job.id;
  return history?.jobs.filter((j) => (j.name === name || j.name.startsWith(name + " (")) && j.startedAt && j.completedAt) ?? [];
}

const jobMinutes = (j: JobRecord): number => Math.max(1, Math.ceil((j.completedAt!.getTime() - j.startedAt!.getTime()) / 60_000));

/** Observed macOS minutes scaled to 30 days, or null when the history has no such job. */
function observedMacosMinutes(history: History | null, jobs: JobRecord[]): number | null {
  if (!history || !jobs.length) return null;
  const total = jobs.reduce((a, j) => a + jobMinutes(j), 0);
  return Math.round((total * 30) / Math.max(1, history.days));
}

/** True when every run with both OS entries saw identical conclusions, over at least MIN_MATRIX_RUNS runs. */
function matrixEntriesAgree(jobs: JobRecord[]): boolean {
  const byRun = new Map<number, JobRecord[]>();
  for (const j of jobs) byRun.set(j.runId, [...(byRun.get(j.runId) ?? []), j]);
  let agreeing = 0;
  for (const entries of byRun.values()) {
    const oses = new Set(entries.map((j) => classify(j.labels).os));
    if (!oses.has("macos") || !oses.has("linux")) continue;
    const conclusions = new Set(entries.map((j) => j.conclusion ?? "unknown"));
    if (conclusions.size > 1) return false;
    agreeing++;
  }
  return agreeing >= MIN_MATRIX_RUNS;
}

function matrixAxis(doc: Document, job: NormalisedJob): string | null {
  const raw = doc.getIn(["jobs", job.id, "runs-on"]);
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/);
  return m && job.matrix?.axes[m[1]!] ? m[1]! : null;
}

/** Set a label in place so comments attached to the existing node survive; a label list becomes a single entry. */
function setLabel(doc: Document, path: unknown[], value: string): void {
  const node = doc.getIn(path, true);
  if (isScalar(node)) node.value = value;
  else if (isSeq(node) && node.items.some(isScalar)) {
    const first = node.items.find(isScalar)!;
    first.value = value;
    node.items = [first];
  } else doc.setIn(path, value);
}

export const R04: Rule = {
  meta: ruleById("R04")!,
  detect(ctx: RuleContext): Detection[] {
    const { model, doc, path } = ctx.workflow;
    const linuxPrice = githubRateForLabel(LINUX_LABEL)!.pricePerMinute;
    const out: Detection[] = [];
    const workflowEstimate = ctx.estimator.estimateWorkflow(model, ctx.history, path);
    for (const job of model.jobs) {
      if (!job.steps.length) continue;
      const axis = matrixAxis(doc, job);
      const axisValues = axis ? job.matrix!.axes[axis]!.map(String) : [];
      const macLabels = axis ? axisValues.filter((l) => classify([l]).os === "macos") : [];
      const mixed = axis !== null && macLabels.length > 0 && macLabels.length < axisValues.length;
      const jobs = historyJobs(ctx.history, job);
      let macClass: Classification;
      if (mixed) {
        if (!matrixEntriesAgree(jobs)) continue;
        macClass = classify([macLabels[0]!]);
      } else if (axis && macLabels.length === axisValues.length && axisValues.length > 0) {
        macClass = classify([macLabels[0]!]);
      } else {
        if (axis) continue;
        macClass = classify(job.runsOn);
        if (macClass.os !== "macos") continue;
      }
      const { apple, unclassified } = classifySteps(job.steps);
      if (apple) continue;
      const macJobs = axis ? jobs.filter((j) => classify(j.labels).os === "macos") : jobs;
      const observed = observedMacosMinutes(ctx.history, macJobs);
      const minutes = observed ?? workflowEstimate.jobs.filter((j) => j.jobId === job.id && j.os === "macos").reduce((a, j) => a + j.minutesPerMonth, 0);
      const free = !ctx.repository.private && macClass.provider === "github";
      const differential = free ? 0 : Math.max(0, macClass.pricePerMinute - linuxPrice);
      const fullyClassified = unclassified.length === 0;
      const confirm = fullyClassified
        ? `Confirm before merging: no step in job "${job.id}" needs macOS; every step was classified as portable.`
        : `Confirm before merging: no step in job "${job.id}" needs macOS. Unclassified steps: ${unclassified.join("; ")}.`;
      out.push({
        jobId: job.id,
        evidence: {
          runsOn: axis ? macLabels : job.runsOn,
          matrixAxis: axis,
          stepNames: job.steps.map(stepLabel),
          unclassifiedSteps: unclassified,
          macosMinutesPerMonth: minutes,
          minutesBasis: observed === null ? "default" : "history",
          priceDifferential: differential,
          macosPricePerMinute: macClass.pricePerMinute,
          linuxPricePerMinute: linuxPrice,
        },
        estimate: { minutesPerMonth: Math.round(minutes), centsPerMonth: Math.round(minutes * differential * 100), confidence: fullyClassified ? 0.9 : 0.6 },
        summary: mixed
          ? `Job "${job.id}" runs a macOS matrix entry whose results never differ from Linux`
          : `Job "${job.id}" runs on macOS but no step needs an Apple toolchain`,
        confirmBeforeMerging: confirm,
        fix: (d: Document) => {
          if (!axis) { setLabel(d, ["jobs", job.id, "runs-on"], LINUX_LABEL); return; }
          const seq = d.getIn(["jobs", job.id, "strategy", "matrix", axis], true);
          if (!isSeq(seq)) return;
          if (mixed) {
            seq.items = seq.items.filter((item) => !(isScalar(item) && macLabels.includes(String(item.value))));
          } else {
            const first = seq.items.find(isScalar);
            if (first) { first.value = LINUX_LABEL; seq.items = [first]; }
          }
        },
      });
    }
    return out;
  },
};
