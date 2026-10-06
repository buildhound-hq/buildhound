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

describe("minimiseChurn", () => {
  it("restores untouched lines so the diff shows only the fix", () => {
    const content = `name:   Sync   # odd spacing\non:   # triggers\n    schedule:   # four-space indent\n        -   cron:   '0 */2 * * *'   # every two hours\njobs:\n    sync:   # the only job\n        runs-on:   ubuntu-latest   # cheap\n        steps:\n            -   run: ./sync.sh   # script\n`;
    const applied = applyEdit("ci.yml", content, (doc) => {
      doc.setIn(["jobs", "sync", "timeout-minutes"], 30);
    });
    expect(applied.after).toContain("name:   Sync   # odd spacing");
    expect(applied.after).toContain("on:   # triggers");
    expect(applied.after).toContain("        runs-on:   ubuntu-latest   # cheap");
    expect(applied.after).toContain("timeout-minutes: 30");
    const changed = applied.diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l));
    expect(changed).toEqual(["+        timeout-minutes: 30"]);
  });
});
