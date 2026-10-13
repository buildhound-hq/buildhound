import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { classifyWorkflowJobs, readsSecrets } from "./classify-job";

const classify = (yaml: string, defaultTokenPermission: "read" | "write" | undefined = "read") => classifyWorkflowJobs(parse(yaml), { defaultTokenPermission });
const reasonsOf = (yaml: string, job = "build", d: "read" | "write" | undefined = "read") => classify(yaml, d).find((c) => c.jobId === job)!.reasons.map((r) => r.reason);

describe("readsSecrets", () => {
  it("counts every form of the secrets context except GITHUB_TOKEN alone", () => {
    for (const e of ["secrets.NPM_TOKEN", "secrets['NPM_TOKEN']", 'secrets["A"]', "toJSON(secrets)", " secrets ", "secrets.GITHUB_TOKEN || secrets.PAT", "format('{0}', secrets.X)"]) {
      expect(readsSecrets(e), e).toBe(true);
    }
    for (const e of ["secrets.GITHUB_TOKEN", "secrets['GITHUB_TOKEN']", " secrets.github_token ", "github.token", "inputs.secrets_note", "env.MY_secrets", "steps.secrets.outputs.x"]) {
      expect(readsSecrets(e), e).toBe(false);
    }
  });
});

describe("classifyWorkflowJobs", () => {
  it("leaves a plain job with a read-only token burst-safe", () => {
    const c = classify(`
permissions: { contents: read }
jobs:
  build:
    runs-on: \${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}
    steps:
      - uses: actions/checkout@v4
      - run: npm test
        env: { GH_TOKEN: "\${{ secrets.GITHUB_TOKEN }}" }
`);
    expect(c).toEqual([{ jobId: "build", secretBearing: false, reasons: [] }]);
  });

  it("flags secrets in steps, env, with, a job condition and the workflow env", () => {
    const base = "permissions: read-all\n";
    expect(reasonsOf(base + "jobs:\n  build:\n    runs-on: x\n    steps:\n      - run: echo \"${{ secrets.API_KEY }}\"\n")).toEqual(["secrets"]);
    expect(reasonsOf(base + "jobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: a/b@v1\n        with: { token: \"${{ secrets['PAT'] }}\" }\n")).toEqual(["secrets"]);
    expect(reasonsOf(base + "env:\n  ALL: ${{ toJSON(secrets) }}\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: ls }]\n")).toEqual(["secrets"]);
    expect(reasonsOf(base + "jobs:\n  build:\n    runs-on: x\n    steps:\n      - if: secrets.DEPLOY_KEY != ''\n        run: ls\n")).toEqual(["secrets"]);
  });

  it("flags an environment, an OIDC login, secrets: inherit and write tokens", () => {
    expect(reasonsOf("permissions: {}\njobs:\n  build:\n    runs-on: x\n    environment: production\n    steps: [{ run: ls }]\n")).toEqual(["environment"]);
    expect(reasonsOf("permissions: {}\njobs:\n  build:\n    runs-on: x\n    environment: { name: staging, url: https://x }\n    steps: [{ run: ls }]\n")).toEqual(["environment"]);
    expect(reasonsOf("jobs:\n  build:\n    runs-on: x\n    permissions: { id-token: write, contents: read }\n    steps: [{ run: ls }]\n")).toEqual(["id_token"]);
    expect(reasonsOf("permissions: {}\njobs:\n  build:\n    uses: ./.github/workflows/release.yml\n    secrets: inherit\n")).toEqual(["secrets_inherit"]);
    expect(reasonsOf("jobs:\n  build:\n    runs-on: x\n    permissions: write-all\n    steps: [{ run: ls }]\n")).toEqual(["write_token"]);
    expect(reasonsOf("permissions: { packages: write }\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: ls }]\n")).toEqual(["write_token"]);
  });

  it("allows write scopes that cannot change code or releases", () => {
    expect(reasonsOf("permissions: { pull-requests: write, checks: write, statuses: write, issues: write, contents: read }\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: ls }]\n")).toEqual([]);
  });

  it("lets a job's permissions replace the workflow's", () => {
    const yaml = "permissions: { contents: write }\njobs:\n  build:\n    runs-on: x\n    permissions: { contents: read }\n    steps: [{ run: ls }]\n  release:\n    runs-on: x\n    steps: [{ run: ls }]\n";
    expect(reasonsOf(yaml, "build")).toEqual([]);
    expect(reasonsOf(yaml, "release")).toEqual(["write_token"]);
  });

  it("treats no permissions block by the repository default, and an unknown default as write", () => {
    const yaml = "jobs:\n  build:\n    runs-on: x\n    steps: [{ run: ls }]\n";
    expect(reasonsOf(yaml, "build", "read")).toEqual([]);
    expect(reasonsOf(yaml, "build", "write")).toEqual(["default_write_token"]);
    expect(classifyWorkflowJobs(parse(yaml), {})[0]!.reasons.map((r) => r.reason)).toEqual(["default_write_token"]);
  });

  it("gives every reason with a detail a person can act on", () => {
    const [c] = classify("jobs:\n  build:\n    runs-on: x\n    environment: prod\n    permissions: { id-token: write }\n    steps:\n      - run: echo ${{ secrets.X }}\n");
    expect(c!.secretBearing).toBe(true);
    expect(c!.reasons).toEqual([
      { reason: "secrets", detail: "jobs.build.steps[0].run reads secrets" },
      { reason: "environment", detail: "jobs.build.environment: prod" },
      { reason: "id_token", detail: "jobs.build permissions: id-token: write" },
    ]);
  });

  it("classifies every job of the real workflows in the corpus without throwing", () => {
    const dir = join(__dirname, "..", "..", "fixtures", "corpus");
    let jobs = 0;
    let flagged = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      for (const c of classifyWorkflowJobs(parse(readFileSync(join(dir, file), "utf8")), { defaultTokenPermission: "read" })) {
        jobs++;
        if (c.secretBearing) flagged++;
        expect(c.secretBearing).toBe(c.reasons.length > 0);
      }
    }
    expect(jobs).toBeGreaterThan(100);
    expect(flagged).toBeGreaterThan(0);
    expect(flagged).toBeLessThan(jobs);
  });
});
