import { defineConfig } from "vitest/config";

// The same projects and settings these packages have in the monorepo they are mirrored from.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", root: "packages/core", include: ["src/**/*.test.ts"], testTimeout: 20_000 } },
      { test: { name: "github", root: "packages/github", include: ["src/**/*.test.ts"] } },
      { test: { name: "shared", root: "packages/shared", include: ["src/**/*.test.ts"] } },
      // The CLI is bundled once per run (src/test-bundle.ts) and tests start it with inject("cliBin").
      { test: { name: "cli", root: "apps/cli", include: ["src/**/*.test.ts"], globalSetup: ["src/test-bundle.ts"], env: { BUILDHOUND_NO_CACHE: "1" }, testTimeout: 30_000 } },
      { test: { name: "mcp", root: "apps/mcp", include: ["src/**/*.test.ts"], testTimeout: 20_000 } },
    ],
  },
});
