import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The bundled CLI, which tests start as `node <cliBin> ...args` with `inject("cliBin")`. */
    cliBin: string;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const banner = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

/**
 * The cli project's globalSetup. Its tests start the CLI as a child process over 150 times, to check what an agent
 * sees. Through tsx each start resolves and loads the sources again in two Node processes, 0.2 s of CPU, and a
 * pre-push run next to other builds timed tests out. So the CLI is bundled once per run, as tsup.config.ts builds the
 * npm package but with its npm dependencies inside too, to run from a temp directory: a start then costs a quarter of
 * that. Watch mode bundles again before every rerun of this project, so a run never starts stale sources.
 */
export default async function setup(project: TestProject) {
  const outDir = mkdtempSync(path.join(tmpdir(), "buildhound-cli-"));
  const bundle = () => build({ config: false, tsconfig: path.join(here, "..", "tsconfig.json"), entry: { index: path.join(here, "index.ts") }, outDir, outExtension: () => ({ js: ".mjs" }), format: ["esm"], target: "node22", noExternal: [/./], banner: { js: banner }, silent: true });
  await bundle();
  project.provide("cliBin", path.join(outDir, "index.mjs"));
  project.onTestsRerun(async (specs) => {
    if (specs.some((s) => s.project === project)) await bundle();
  });
  return () => rmSync(outDir, { recursive: true, force: true });
}
