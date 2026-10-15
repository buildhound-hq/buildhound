import { describe, expect, it } from "vitest";
import { auditWorkflows } from "./audit";
import { R06 } from "./index";
import type { Rule } from "./types";

const repository = { fullName: "acme/app", private: false, defaultBranch: "main" };
const workflow = (name: string) => ({
  path: `.github/workflows/${name}.yml`,
  content: `name: ${name}\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n`,
});

describe("auditWorkflows", () => {
  it("runs the rules until proceed says stop, then estimates the rest without them", async () => {
    let calls = 0;
    const audit = await auditWorkflows({ workflows: [workflow("a"), workflow("b"), workflow("c")], repository, history: null, rules: [R06], proceed: async () => ++calls < 2 });
    expect(audit.workflows.map((w) => [w.path, w.findings.length])).toEqual([
      [".github/workflows/a.yml", 1],
      [".github/workflows/b.yml", 0],
      [".github/workflows/c.yml", 0],
    ]);
    expect(audit.workflows.every((w) => w.estimate.jobs.length === 1)).toBe(true);
    expect(audit.unaudited).toEqual([".github/workflows/b.yml", ".github/workflows/c.yml"]);
    expect(audit.assumptions).toContain("rules not run on 2 workflows for time: .github/workflows/b.yml, .github/workflows/c.yml");
    // Once stopped, proceed is not asked again.
    expect(calls).toBe(2);
  });

  it("keeps the audit when a rule fails on one file, noting the file", async () => {
    const failing: Rule = {
      meta: R06.meta,
      detect(ctx) {
        if (ctx.workflow.path.endsWith("b.yml")) throw new Error("boom");
        return R06.detect(ctx);
      },
    };
    const audit = await auditWorkflows({ workflows: [workflow("a"), workflow("b")], repository, history: null, rules: [failing] });
    expect(audit.findings.map((f) => f.workflowPath)).toEqual([".github/workflows/a.yml"]);
    expect(audit.workflows).toHaveLength(2);
    expect(audit.unaudited).toEqual([".github/workflows/b.yml"]);
    expect(audit.assumptions).toContain(".github/workflows/b.yml: rules not run, a rule failed (boom)");
  });
});
