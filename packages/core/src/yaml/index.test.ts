import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdit, countComments, loadWorkflow } from "./index";

const corpusDir = join(__dirname, "..", "..", "fixtures", "corpus");
const corpus = readdirSync(corpusDir).filter((f) => /\.ya?ml$/.test(f));

describe("yaml editor", () => {
  it("has a corpus of at least 30 real workflow files", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30);
  });

  it.each(corpus)("round-trips %s through a no-op edit without losing comments", (file) => {
    const content = readFileSync(join(corpusDir, file), "utf8");
    const applied = applyEdit(file, content, () => {});
    expect(applied.commentsAfter).toBeGreaterThanOrEqual(applied.commentsBefore);
    expect(() => loadWorkflow(file, applied.after)).not.toThrow();
  });

  it("applies an edit, keeps comments, and produces a unified diff", () => {
    const content = `# top comment\nname: CI\non: push # inline\njobs:\n  build:\n    runs-on: ubuntu-latest # keep me\n    steps:\n      - run: echo hi\n`;
    const applied = applyEdit(".github/workflows/ci.yml", content, (doc) => {
      doc.setIn(["jobs", "build", "timeout-minutes"], 15);
    });
    expect(applied.after).toContain("timeout-minutes: 15");
    expect(applied.after).toContain("# keep me");
    expect(applied.after).toContain("# top comment");
    expect(applied.commentsAfter).toBe(applied.commentsBefore);
    expect(applied.diff).toContain("+    timeout-minutes: 15");
  });

  it("counts comment lines but not expressions", () => {
    expect(countComments("a: 1 # c\n# d\nx: ${{ github.sha }}\n")).toBe(2);
  });
});
