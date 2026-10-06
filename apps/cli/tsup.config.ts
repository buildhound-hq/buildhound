import { defineConfig } from "tsup";

// The @buildhound/* packages are private TypeScript sources, so they are bundled with the npm packages they use;
// those include CommonJS modules, which need a require in ESM output.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  noExternal: [/^@buildhound\//, /^buildhound\//],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
