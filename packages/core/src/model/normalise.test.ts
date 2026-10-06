import { describe, expect, it } from "vitest";
import { loadWorkflow } from "../yaml";

const yml = `
name: CI
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
  schedule:
    - cron: '*/15 * * * *'
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
        exclude:
          - os: macos-latest
            node: 20
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: pnpm install
  lint:
    runs-on: ubuntu-latest
    needs: test
    if: github.event.pull_request.draft == false
    container: node:22
    steps:
      - run: pnpm lint
`;

describe("normaliseWorkflow", () => {
  const { model } = loadWorkflow(".github/workflows/ci.yml", yml);
  it("reads triggers, filters and schedules", () => {
    expect(model.events).toEqual(["push", "pull_request", "schedule"]);
    expect(model.pushBranches).toEqual(["main"]);
    expect(model.pushTags).toEqual(["v*"]);
    expect(model.pullRequestBranches).toBeNull();
    expect(model.schedules).toEqual(["*/15 * * * *"]);
    expect(model.concurrency?.cancelInProgress).toBe(true);
  });
  it("expands a matrix and resolves runs-on through it", () => {
    const test = model.jobs.find((j) => j.id === "test")!;
    expect(test.matrix?.size).toBe(3);
    expect(test.runsOn).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(test.timeoutMinutes).toBe(20);
    expect(test.steps[0]?.uses).toBe("actions/checkout@v4");
    expect(test.steps[0]?.with["fetch-depth"]).toBe(0);
  });
  it("resolves runs-on through include-only matrices", () => {
    const inc = `on: push\njobs:\n  build:\n    strategy:\n      matrix:\n        include:\n          - os: windows-latest\n            target: win\n          - os: macos-latest\n            target: mac\n    runs-on: \${{ matrix.os }}\n    steps: [{ run: npm run build }]\n`;
    const m = loadWorkflow("rel.yml", inc).model;
    expect(m.jobs[0]?.runsOn).toEqual(["windows-latest", "macos-latest"]);
    expect(m.jobs[0]?.matrix?.size).toBe(2);
  });
  it("reads needs, if and container", () => {
    const lint = model.jobs.find((j) => j.id === "lint")!;
    expect(lint.needs).toEqual(["test"]);
    expect(lint.if).toContain("draft");
    expect(lint.usesContainer).toBe(true);
    expect(lint.timeoutMinutes).toBeNull();
  });
});
