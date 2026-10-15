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
  it("asks before each fix diff and keeps the finding without one when told no", async () => {
    const sizes: number[] = [];
    const audit = await auditWorkflows({
      workflows: [workflow("a"), workflow("b"), workflow("c")],
      repository,
      history: null,
      rules: [R06],
      beforeFix: async (bytes) => {
        sizes.push(bytes);
        return sizes.length !== 2;
      },
    });
    expect(sizes).toEqual([workflow("a").content.length, workflow("b").content.length, workflow("c").content.length]);
    expect(audit.findings.map((f) => [f.workflowPath, f.diff === null])).toEqual([
      [".github/workflows/a.yml", false],
      [".github/workflows/b.yml", true],
      [".github/workflows/c.yml", false],
    ]);
    expect(audit.unwritten).toBe(1);
    expect(audit.assumptions).toContain("1 finding has no diff: the audit reached its limit before writing it");
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
