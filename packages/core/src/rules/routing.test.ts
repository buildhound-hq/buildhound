import { describe, expect, it } from "vitest";
import { applyEdit } from "../yaml";
import { buildhoundLabelExpression, parseRoutingExpression, routingExpression, trustedRun, upgradeRoutingExpressions, type RoutingUpgrade } from "./routing";

/**
 * A small evaluator for the subset of GitHub's expression syntax the routing expressions use, following the
 * expressions reference: `&&` and `||` return an operand, falsy is false, 0, '' and null, `==` is loose (mismatched
 * types become numbers, null is 0, a non-numeric string is NaN) and ignores case on strings. A property of something
 * that is not an object, or a missing property, is null, which is what a deleted fork's `head.repo` gives.
 */
type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

function evaluate(expression: string, context: Record<string, Value>): Value {
  const body = /^\$\{\{([\s\S]*)\}\}$/.exec(expression.trim())?.[1] ?? expression;
  const tokens = body.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!.]|[A-Za-z_][A-Za-z0-9_-]*|\d+(?:\.\d+)?|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    const tok = tokens[i++];
    if (t !== undefined && tok !== t) throw new Error(`expected ${t}, got ${tok} in ${expression}`);
    return tok!;
  };
  const truthy = (v: Value) => !(v === false || v === 0 || v === "" || v === null || Number.isNaN(v));
  const toNumber = (v: Value): number => {
    if (v === null) return 0;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") return v.trim() === "" ? 0 : /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    return NaN;
  };
  const equals = (a: Value, b: Value): boolean => {
    if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
    if (typeof a === "object" && a !== null) return a === b;
    if (typeof b === "object" && b !== null) return false;
    if (typeof a === typeof b && a !== null) return a === b;
    return toNumber(a) === toNumber(b);
  };
  const primary = (): Value => {
    const t = take();
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t === "!") return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    if (!/^[A-Za-z_]/.test(t)) throw new Error(`unexpected ${t} in ${expression}`);
    let v: Value = context[t] ?? null;
    while (peek() === ".") {
      take(".");
      const key = take();
      v = typeof v === "object" && v !== null && !Array.isArray(v) ? (v[key] ?? null) : null;
    }
    return v;
  };
  const eq = (): Value => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const r = primary();
      v = op === "==" ? equals(v, r) : !equals(v, r);
    }
    return v;
  };
  const and = (): Value => {
    let v = eq();
    while (peek() === "&&") {
      take();
      const r = eq();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === "||") {
      take();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const result = or();
  if (i !== tokens.length) throw new Error(`trailing ${tokens.slice(i).join(" ")} in ${expression}`);
  return result;
}

const REPO = "acme/app";
const MACHINE = "buildhound-macos";
const sameRepoHead = { repo: { full_name: REPO, fork: false } };
const forkHead = { repo: { full_name: "stranger/app", fork: true } };

/** Each event as GitHub delivers it to a workflow on acme/app; `github.event` holds only that event's payload. */
const EVENTS: Record<string, { event_name: string; event: { [k: string]: Value } }> = {
  "same-repository pull_request": { event_name: "pull_request", event: { pull_request: { head: sameRepoHead } } },
  "fork pull_request": { event_name: "pull_request", event: { pull_request: { head: forkHead } } },
  "deleted-fork pull_request": { event_name: "pull_request", event: { pull_request: { head: { repo: null } } } },
  push: { event_name: "push", event: { ref: "refs/heads/main" } },
  schedule: { event_name: "schedule", event: { schedule: "0 3 * * *" } },
  workflow_dispatch: { event_name: "workflow_dispatch", event: { inputs: {} } },
  merge_group: { event_name: "merge_group", event: { merge_group: { head_sha: "abc" } } },
  release: { event_name: "release", event: { release: { tag_name: "v1.0.0" } } },
  issue_comment: { event_name: "issue_comment", event: { issue: { pull_request: { url: "https://api.github.com/repos/acme/app/pulls/7" } }, comment: { body: "/test" } } },
  issues: { event_name: "issues", event: { issue: { title: "bug" } } },
  discussion: { event_name: "discussion", event: { discussion: { title: "idea" } } },
  discussion_comment: { event_name: "discussion_comment", event: { discussion: {}, comment: { body: "hi" } } },
  workflow_run: { event_name: "workflow_run", event: { workflow_run: { event: "pull_request", head_repository: { full_name: "stranger/app" } } } },
  "same-repository pull_request_target": { event_name: "pull_request_target", event: { pull_request: { head: sameRepoHead } } },
  "fork pull_request_target": { event_name: "pull_request_target", event: { pull_request: { head: forkHead } } },
  "same-repository pull_request_review": { event_name: "pull_request_review", event: { pull_request: { head: sameRepoHead }, review: { body: "lgtm" } } },
  repository_dispatch: { event_name: "repository_dispatch", event: { client_payload: { ref: "refs/pull/7/head" } } },
};

const TO_MACHINE = new Set(["same-repository pull_request", "push", "schedule", "workflow_dispatch", "merge_group", "release"]);

function runsOn(expression: string, name: string, variable: string | null = MACHINE): Value {
  const e = EVENTS[name]!;
  return evaluate(expression, { github: { event_name: e.event_name, repository: REPO, event: e.event }, vars: variable === null ? {} : { BUILDHOUND_MACOS: variable } });
}

const LEGACY_PUBLIC = "${{ github.event.pull_request.head.repo.fork && 'macos-latest' || vars.BUILDHOUND_MACOS || 'macos-latest' }}";
const SHORT = "${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}";

describe("the public routing expression", () => {
  const expression = buildhoundLabelExpression("macos", "macos-latest", true);

  for (const name of Object.keys(EVENTS)) {
    const expected = TO_MACHINE.has(name) ? MACHINE : "macos-latest";
    it(`sends ${name} to ${expected === MACHINE ? "the connected machine" : "GitHub-hosted"}`, () => {
      expect(runsOn(expression, name)).toBe(expected);
    });
  }

  it("falls back to GitHub-hosted on every event when the control plane has cleared the variable", () => {
    for (const name of Object.keys(EVENTS)) {
      expect(runsOn(expression, name, null), name).toBe("macos-latest");
      expect(runsOn(expression, name, ""), name).toBe("macos-latest");
    }
  });

  it("compares the head repository by name, so case alone does not send a same-repository pull request to hosted", () => {
    const e = EVENTS["same-repository pull_request"]!;
    expect(evaluate(expression, { github: { event_name: "pull_request", repository: "Acme/App", event: e.event }, vars: { BUILDHOUND_MACOS: MACHINE } })).toBe(MACHINE);
  });

  it("closes both holes the fork-check form left open", () => {
    // The form used until 2026-10-15: a deleted fork's null head repository and any event without a pull request fell through to the variable.
    expect(runsOn(LEGACY_PUBLIC, "fork pull_request")).toBe("macos-latest");
    expect(runsOn(LEGACY_PUBLIC, "deleted-fork pull_request")).toBe(MACHINE);
    expect(runsOn(LEGACY_PUBLIC, "issue_comment")).toBe(MACHINE);
    expect(runsOn(LEGACY_PUBLIC, "workflow_run")).toBe(MACHINE);
    expect(runsOn(expression, "deleted-fork pull_request")).toBe("macos-latest");
    expect(runsOn(expression, "issue_comment")).toBe("macos-latest");
    expect(runsOn(expression, "workflow_run")).toBe("macos-latest");
  });

  it("is exactly the trusted-events form", () => {
    expect(expression).toBe(
      "${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'release') && vars.BUILDHOUND_MACOS || 'macos-latest' }}",
    );
  });
});

describe("trustedRun, the control plane's copy of the condition", () => {
  /** The run as GitHub's API reports it for each event: a pull request's head repository, null once the fork is deleted. */
  const origin = (name: string, repository = REPO) => {
    const e = EVENTS[name]!;
    const pr = e.event.pull_request as { head?: { repo?: { full_name?: string } | null } } | undefined;
    return { event: e.event_name, repository, headRepository: pr ? (pr.head?.repo?.full_name ?? null) : repository };
  };

  it("agrees with the public expression on every event", () => {
    const expression = buildhoundLabelExpression("macos", "macos-latest", true);
    for (const name of Object.keys(EVENTS)) expect(trustedRun(origin(name)), name).toBe(runsOn(expression, name) === MACHINE);
  });

  it("refuses a pull request with no head repository and compares names without case", () => {
    expect(trustedRun({ event: "pull_request", repository: REPO, headRepository: null })).toBe(false);
    expect(trustedRun({ event: "pull_request", repository: "Acme/App", headRepository: REPO })).toBe(true);
    expect(trustedRun({ event: "workflow_call", repository: REPO, headRepository: REPO })).toBe(false);
  });
});

describe("the private routing expression", () => {
  it("is the short form and routes whenever the variable is set", () => {
    expect(buildhoundLabelExpression("macos", "macos-latest")).toBe(SHORT);
    expect(buildhoundLabelExpression("linux", "ubuntu-latest")).toBe("${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}");
    expect(runsOn(SHORT, "issue_comment")).toBe(MACHINE);
    expect(runsOn(SHORT, "push", null)).toBe("macos-latest");
  });
});

describe("parseRoutingExpression", () => {
  it("recognises every form Buildhound has written, hand-spaced copies included", () => {
    expect(parseRoutingExpression(SHORT)).toEqual({ variable: "BUILDHOUND_MACOS", hostedDefault: "macos-latest", form: "short" });
    expect(parseRoutingExpression("${{vars.BUILDHOUND_LINUX_X64||'ubuntu-24.04'}}")).toEqual({ variable: "BUILDHOUND_LINUX_X64", hostedDefault: "ubuntu-24.04", form: "short" });
    expect(parseRoutingExpression(LEGACY_PUBLIC)).toEqual({ variable: "BUILDHOUND_MACOS", hostedDefault: "macos-latest", form: "fork_check" });
    expect(parseRoutingExpression(routingExpression("BUILDHOUND_LINUX", "ubuntu-latest", true))).toEqual({ variable: "BUILDHOUND_LINUX", hostedDefault: "ubuntu-latest", form: "trusted_events" });
    const spaced = routingExpression("BUILDHOUND_MACOS", "macos-15", true).replace(/\(/g, "( ").replace(/ \|\| /g, "  ||\n ");
    expect(parseRoutingExpression(spaced)?.form).toBe("trusted_events");
  });

  it("does not recognise hand-written variants or other labels", () => {
    expect(parseRoutingExpression("macos-latest")).toBeNull();
    expect(parseRoutingExpression("buildhound-macos")).toBeNull();
    expect(parseRoutingExpression("${{ matrix.os }}")).toBeNull();
    expect(parseRoutingExpression("${{ github.event_name == 'push' && vars.BUILDHOUND_MACOS || 'macos-latest' }}")).toBeNull();
    expect(parseRoutingExpression("${{ vars.OTHER_RUNNER || 'macos-latest' }}")).toBeNull();
  });
});

const ROUTED = `name: CI
on: [push, pull_request, issue_comment]
jobs:
  ios:
    # the Mac mini in the office
    runs-on: \${{ github.event.pull_request.head.repo.fork && 'macos-latest' || vars.BUILDHOUND_MACOS || 'macos-latest' }} # routed by Buildhound
    steps:
      - run: xcodebuild test
  linux:
    runs-on: "\${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}"
    steps:
      - run: make test # unit tests
  already:
    runs-on: ${"${{"} ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'release') && vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}
    steps:
      - run: echo ok
  custom:
    runs-on: \${{ github.actor == 'me' && vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}
    steps:
      - run: echo mine
  hosted:
    runs-on: [ubuntu-latest]
    steps:
      - run: echo hosted
`;

describe("upgradeRoutingExpressions", () => {
  it("rewrites the short and fork-check forms on a public repository and keeps every comment", () => {
    let upgrades: RoutingUpgrade[] = [];
    const applied = applyEdit(".github/workflows/ci.yml", ROUTED, (doc) => {
      upgrades = upgradeRoutingExpressions(doc, true);
    });
    const macos = buildhoundLabelExpression("macos", "macos-latest", true);
    const linux = buildhoundLabelExpression("linux", "ubuntu-latest", true);
    expect(upgrades).toEqual([
      { jobId: "ios", from: LEGACY_PUBLIC, to: macos },
      { jobId: "linux", from: "${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}", to: linux },
      { jobId: "custom", from: "${{ github.actor == 'me' && vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}", to: null },
    ]);
    expect(applied.after).toBe(
      ROUTED.replace(`runs-on: ${LEGACY_PUBLIC} #`, `runs-on: ${macos} #`).replace(`runs-on: "\${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}"`, `runs-on: "${linux}"`),
    );
    expect(applied.commentsAfter).toBe(applied.commentsBefore);
    expect(applied.diff).toContain(`+    runs-on: ${macos} # routed by Buildhound`);
    expect(applied.diff).not.toContain("echo mine");
  });

  it("is idempotent", () => {
    const once = applyEdit(".github/workflows/ci.yml", ROUTED, (doc) => void upgradeRoutingExpressions(doc, true)).after;
    let again: RoutingUpgrade[] = [];
    const twice = applyEdit(".github/workflows/ci.yml", once, (doc) => {
      again = upgradeRoutingExpressions(doc, true);
    });
    expect(again.filter((u) => u.to !== null)).toEqual([]);
    expect(twice.after).toBe(once);
  });

  it("leaves a private repository's workflows as they are", () => {
    let upgrades: RoutingUpgrade[] = [];
    const applied = applyEdit(".github/workflows/ci.yml", ROUTED, (doc) => {
      upgrades = upgradeRoutingExpressions(doc, false);
    });
    expect(upgrades).toEqual([]);
    expect(applied.after).toBe(ROUTED);
  });
});
