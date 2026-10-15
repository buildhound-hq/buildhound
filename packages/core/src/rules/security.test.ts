import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { stepNeeds } from "./action-permissions";
import { agentOf } from "./agent-actions";
import { makeContext, type MakeContextInput } from "./context";
import { R15 } from "./r15-pull-request-target-checkout";
import { R16 } from "./r16-token-permissions";
import { R17 } from "./r17-unpinned-actions";
import { R18 } from "./r18-agent-on-untrusted-input";
import { R19 } from "./r19-long-lived-cloud-keys";
import { runRules } from "./runner";
import { parseUses, secretsIn, type RawStep } from "./security";

const SECURITY_RULES = [R15, R16, R17, R18, R19];
const step = (s: Partial<RawStep>): RawStep => ({ index: 0, name: null, uses: null, run: null, if: null, with: {}, env: {}, raw: {}, ...s });
const run = (content: string, extra: Partial<MakeContextInput> = {}) =>
  runRules(SECURITY_RULES, makeContext({ path: ".github/workflows/x.yml", content, ...extra }));

describe("security rules", () => {
  it("run over every fixture workflow without losing comments, and every diff parses", async () => {
    const root = join(__dirname, "..", "..", "fixtures", "workflows");
    let findings = 0;
    for (const slug of readdirSync(root)) {
      for (const f of readdirSync(join(root, slug)).filter((x) => x.endsWith(".yml"))) {
        const content = readFileSync(join(root, slug, f), "utf8");
        const out = await runRules(SECURITY_RULES, makeContext({ path: `.github/workflows/${f}`, content, resolveActionRef: () => "11bd71901bbe5b1630ceea73d27597364c9af683" }));
        findings += out.length;
        for (const finding of out) {
          expect(finding.estimate).toEqual({ minutesPerMonth: 0, centsPerMonth: 0, confidence: 0.9 });
          expect(["critical", "high", "medium", "low"]).toContain(finding.evidence.risk);
          if (finding.ruleId !== "R17") expect(finding.confirmBeforeMerging).toMatch(/^Confirm before merging: /);
          expect(finding.summary + (finding.confirmBeforeMerging ?? "")).not.toMatch(/\u2014/);
        }
        expect(parseDocument(content).errors).toHaveLength(0);
      }
    }
    expect(findings).toBeGreaterThan(20);
  });

  it("R17 reports with no diff and says why when no SHA can be resolved", async () => {
    const content = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/tool@v1\n";
    const offline = (await run(content)).filter((f) => f.ruleId === "R17");
    expect(offline).toHaveLength(1);
    expect(offline[0]!.diff).toBeNull();
    expect(offline[0]!.evidence.unresolvedNote).toMatch(/could not be resolved offline/);
    const bogus = (await run(content, { resolveActionRef: () => "not-a-sha" })).filter((f) => f.ruleId === "R17");
    expect(bogus[0]!.diff).toBeNull();
    expect(bogus[0]!.evidence.unresolvedNote).toMatch(/did not return a commit/);
  });

  it("R17 rates first-party actions low and secret-receiving third-party actions high", async () => {
    const content = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/deploy@main\n        with:\n          key: ${{ secrets.DEPLOY_KEY }}\n";
    const f = (await run(content)).filter((x) => x.ruleId === "R17");
    expect(f.map((x) => [x.jobName, x.evidence.risk, x.severity])).toEqual([["a", "low", "low"], ["b", "high", "high"]]);
  });

  it("R15 explains the two-workflow pattern in the evidence and the confirmation", async () => {
    const content = "on: pull_request_target\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.head_ref }}\n      - run: make\n";
    const [f] = (await run(content)).filter((x) => x.ruleId === "R15");
    expect(f!.evidence.splitGenerated).toBe(false);
    expect(f!.evidence.twoWorkflowPattern).toMatch(/workflow_run/);
    expect(f!.confirmBeforeMerging).toMatch(/unprivileged pull_request workflow/);
  });

  it("R16 leaves no diff when a reusable workflow would lose the repository default blind", async () => {
    const content = "on: push\njobs:\n  call:\n    uses: acme/ci/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567\n";
    const [f] = (await run(content)).filter((x) => x.ruleId === "R16");
    expect(f!.diff).toBeNull();
    expect(f!.evidence.notFixedReusableWorkflows).toEqual(["call"]);
  });

  it("R16 names steps whose scopes it could not infer", async () => {
    const content = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/mystery@v1\n";
    const [f] = (await run(content)).filter((x) => x.ruleId === "R16");
    expect(f!.confirmBeforeMerging).toContain("a: acme/mystery@v1");
    expect(f!.diff).toContain("+  contents: read");
  });

  it("R18 accepts an author check on the agent step itself", async () => {
    const content = "on: issue_comment\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - if: github.event.comment.author_association == 'OWNER'\n        uses: anthropics/claude-code-action@v1\n        with:\n          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n";
    expect((await run(content)).filter((x) => x.ruleId === "R18")).toHaveLength(0);
  });

  it("R18 is high, not critical, with a read-only token and only the model key", async () => {
    const content = "on: issues\npermissions:\n  issues: write\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx @google/gemini-cli -p \"label it\"\n        env:\n          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}\n";
    const [f] = (await run(content)).filter((x) => x.ruleId === "R18");
    expect(f!.evidence.risk).toBe("high");
    expect(f!.evidence.agents).toEqual(["Gemini CLI"]);
  });

  it("R19 adds nothing to permissions when the job already has write-all", async () => {
    const content = "on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/login@v2\n        with:\n          creds: ${{ secrets.AZURE_CREDENTIALS }}\n";
    const [f] = (await run(content)).filter((x) => x.ruleId === "R19");
    expect(f!.evidence.proposedPermissions).toBeNull();
    expect(f!.diff).toContain("+          client-id: <AZURE_CLIENT_ID>");
    expect(f!.diff).not.toContain("id-token");
  });
});

describe("security helpers", () => {
  it("parses action references", () => {
    expect(parseUses("github/codeql-action/analyze@v3")).toEqual({ owner: "github", repo: "codeql-action", path: "/analyze", ref: "v3", key: "github/codeql-action" });
    expect(parseUses("./.github/actions/setup")).toBeNull();
    expect(parseUses("docker://alpine:3.20")).toBeNull();
  });

  it("finds secret names without GITHUB_TOKEN", () => {
    expect(secretsIn({ a: "${{ secrets.NPM_TOKEN }}", b: "${{ secrets['X'] }}", c: "${{ secrets.GITHUB_TOKEN }}", d: "${{ toJSON(secrets) }}" })).toEqual(["NPM_TOKEN", "X", "toJSON(secrets)"]);
  });

  it("infers scopes from run commands and marks unknown API use", () => {
    expect(stepNeeds(step({ run: "gh pr comment 1 --body hi" }))).toEqual({ scopes: { "pull-requests": "write" }, known: true });
    expect(stepNeeds(step({ run: "git push origin HEAD", env: { GITHUB_TOKEN: "${{ github.token }}" } }))).toEqual({ scopes: { contents: "write" }, known: true });
    expect(stepNeeds(step({ run: "gh api repos/acme/app/labels" })).known).toBe(false);
    expect(stepNeeds(step({ run: "npm test" }))).toEqual({ scopes: {}, known: true });
    expect(stepNeeds(step({ uses: "docker/login-action@v3", with: { registry: "ghcr.io" } }))).toEqual({ scopes: { packages: "write" }, known: true });
  });

  it("recognises agents by action and by command", () => {
    expect(agentOf(step({ uses: "anthropics/claude-code-action@v1" }))).toBe("Claude Code");
    expect(agentOf(step({ uses: "OpenAI/codex-action@main" }))).toBe("Codex");
    expect(agentOf(step({ run: "codex exec 'fix the bug'" }))).toBe("Codex");
    expect(agentOf(step({ uses: "actions/checkout@v4" }))).toBeNull();
  });
});
