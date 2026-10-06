/**
 * actions/cache@v4 step templates for R05, keyed by ecosystem. Plain objects so the rule can hand
 * them to `doc.createNode` and insert the step before the install step with comments intact.
 */
export type CacheEcosystem = "node" | "python" | "ruby" | "rust" | "go" | "java" | "cocoapods" | "swift";

export interface CacheTemplate {
  name: string;
  uses: "actions/cache@v4";
  with: { path: string; key: string; "restore-keys"?: string };
}

const CACHE_ACTION = "actions/cache@v4";

function template(name: string, paths: string[], tag: string, lockGlobs: string[]): CacheTemplate {
  const hash = lockGlobs.map((g) => `'${g}'`).join(", ");
  return {
    name,
    uses: CACHE_ACTION,
    with: {
      path: paths.join("\n") + "\n",
      key: `\${{ runner.os }}-${tag}-\${{ hashFiles(${hash}) }}`,
      "restore-keys": `\${{ runner.os }}-${tag}-`,
    },
  };
}

/** Templates by ecosystem and, where it matters, by package manager. */
export const CACHE_TEMPLATES: Record<string, CacheTemplate> = {
  npm: template("Cache npm dependencies", ["~/.npm", "node_modules"], "npm", ["**/package-lock.json"]),
  pnpm: template("Cache pnpm dependencies", ["~/.local/share/pnpm/store", "node_modules"], "pnpm", ["**/pnpm-lock.yaml"]),
  yarn: template("Cache yarn dependencies", ["~/.cache/yarn", "node_modules"], "yarn", ["**/yarn.lock"]),
  pip: template("Cache pip dependencies", ["~/.cache/pip"], "pip", ["**/requirements*.txt", "**/pyproject.toml"]),
  poetry: template("Cache poetry dependencies", ["~/.cache/pypoetry", ".venv"], "poetry", ["**/poetry.lock"]),
  bundler: template("Cache gems", ["vendor/bundle"], "gems", ["**/Gemfile.lock"]),
  cargo: template("Cache cargo dependencies", ["~/.cargo/registry", "~/.cargo/git", "target"], "cargo", ["**/Cargo.lock"]),
  go: template("Cache Go modules", ["~/go/pkg/mod", "~/.cache/go-build"], "go", ["**/go.sum"]),
  gradle: template("Cache Gradle dependencies", ["~/.gradle/caches", "~/.gradle/wrapper"], "gradle", ["**/*.gradle*", "**/gradle-wrapper.properties"]),
  maven: template("Cache Maven dependencies", ["~/.m2/repository"], "maven", ["**/pom.xml"]),
  cocoapods: template("Cache CocoaPods", ["Pods", "~/Library/Caches/CocoaPods"], "pods", ["**/Podfile.lock"]),
  swiftpm: template("Cache Swift packages", [".build", "~/Library/Caches/org.swift.swiftpm"], "spm", ["**/Package.resolved"]),
};

export function cacheTemplate(manager: string): CacheTemplate | undefined {
  return CACHE_TEMPLATES[manager];
}
