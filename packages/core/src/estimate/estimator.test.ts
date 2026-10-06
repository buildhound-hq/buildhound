import { describe, expect, it } from "vitest";
import { cronInfo } from "./cron";
import { Estimator } from "./estimator";
import { loadWorkflow } from "../yaml";
import type { History } from "../model/types";

describe("cronInfo", () => {
  it("counts occurrences in a 30-day window", () => {
    expect(cronInfo("0 0 * * *").runsPerMonth).toBe(30);
    expect(cronInfo("*/15 * * * *").runsPerMonth).toBe(30 * 24 * 4);
    expect(cronInfo("0 0 * * 1").runsPerMonth).toBeGreaterThanOrEqual(4);
    expect(cronInfo("0 */6 * * *").minIntervalMinutes).toBe(360);
    expect(cronInfo("bad").valid).toBe(false);
  });
});

const yml = `
on: [push, pull_request]
jobs:
  build:
    runs-on: macos-latest
    steps: [{ run: xcodebuild }]
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: pnpm lint }]
`;

describe("Estimator", () => {
  it("uses defaults without history and lists the assumptions", () => {
    const { model } = loadWorkflow("ci.yml", yml);
    const e = new Estimator().estimateWorkflow(model, null, "ci.yml");
    expect(e.runsPerMonth).toBe(100);
    expect(e.assumptions.length).toBeGreaterThan(0);
    const mac = e.jobs.find((j) => j.jobId === "build")!;
    expect(mac.minutesPerRun).toBe(8);
    expect(mac.centsPerMonth).toBe(Math.round(100 * 8 * 0.062 * 100));
  });
  it("uses observed runs and medians when history exists", () => {
    const { model } = loadWorkflow("ci.yml", yml);
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    const history: History = {
      days: 30,
      runs: Array.from({ length: 10 }, (_, i) => ({ id: i, workflowPath: "ci.yml", event: "push", headBranch: "main", headSha: null, actorLogin: "a", actorKind: "human", agentName: null, createdAt: t(0), runStartedAt: t(0), conclusion: "success", isFork: false, isDraft: false })),
      jobs: [3, 5, 7].map((min, i) => ({ id: i, runId: i, name: "build", labels: ["macos-latest"], startedAt: t(0), completedAt: t(min), conclusion: "success", steps: [] })),
    };
    const e = new Estimator().estimateWorkflow(model, history, "ci.yml");
    expect(e.runsByEvent.push).toBe(10);
    const mac = e.jobs.find((j) => j.jobId === "build")!;
    expect(mac.minutesPerRun).toBe(5);
    expect(mac.basis).toBe("history");
  });
  it("prices GitHub-hosted jobs at zero for public repositories", () => {
    const { model } = loadWorkflow("ci.yml", yml);
    const e = new Estimator({}, true).estimateWorkflow(model, null, "ci.yml");
    expect(e.centsPerMonth).toBe(0);
  });
});
