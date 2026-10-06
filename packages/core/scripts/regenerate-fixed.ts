// Regenerates every fixtures/workflows/<slug>/<case>.fixed.yml by running the rule's fix. Never hand-edit a fixed file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_RULES } from "../src/rules/index";
import { makeContext } from "../src/rules/context";
import { applyEdit } from "../src/yaml";
import type { History } from "../src/model/types";

const root = join(import.meta.dirname, "..", "fixtures", "workflows");
let n = 0;
for (const slug of readdirSync(root)) {
  const rule = ALL_RULES.find((r) => r.meta.slug === slug);
  if (!rule) continue;
  const dir = join(root, slug);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".fixed.yml"))) {
    const c = f.replace(/\.fixed\.yml$/, "");
    const content = readFileSync(join(dir, `${c}.yml`), "utf8");
    const hp = join(dir, `${c}.history.json`);
    let history: History | null = null;
    if (existsSync(hp)) {
      const h = JSON.parse(readFileSync(hp, "utf8")) as History;
      history = { days: h.days, runs: h.runs.map((r) => ({ ...r, createdAt: new Date(r.createdAt), runStartedAt: r.runStartedAt ? new Date(r.runStartedAt) : null })), jobs: h.jobs.map((j) => ({ ...j, startedAt: j.startedAt ? new Date(j.startedAt) : null, completedAt: j.completedAt ? new Date(j.completedAt) : null })) };
    }
    const ctx = makeContext({ path: `.github/workflows/${c}.yml`, content, history });
    const d = rule.detect(ctx).find((x) => x.fix);
    if (!d) { console.error(`no fix for ${slug}/${c}`); continue; }
    writeFileSync(join(dir, f), applyEdit(ctx.workflow.path, content, d.fix!).after);
    n++;
  }
}
console.log(JSON.stringify({ regenerated: n }));
