import { describe, expect, it } from "vitest";
import { auditWorkflows } from "../rules/audit";
import { selectRoutingMoves } from "./route-select";

// Which jobs the routing pull request moves, shared by `buildhound route --apply` and the control plane's routing endpoint.

const CI = `name: CI
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: macos-15
    steps:
      - run: xcodebuild
  arm:
    runs-on: ubuntu-24.04-arm
    steps:
      - run: make
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
  alone:
    runs-on: buildhound-macos-exclusive
    steps:
      - run: echo alone
  matrix:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: echo
  routed:
    runs-on: \${{ vars.BUILDHOUND_LINUX || 'ubuntu-latest' }}
    steps:
      - run: echo
`;

async function select(content: string, extra: Partial<Parameters<typeof selectRoutingMoves>[0]> = {}) {
  const workflows = [{ path: ".github/workflows/ci.yml", content }];
  const audited = await auditWorkflows({ workflows, repository: { fullName: "acme/app", private: true, defaultBranch: "main" }, history: null, rules: [] });
  return selectRoutingMoves({ audited: audited.workflows, workflows, repositoryPrivate: true, history: null, defaultTokenPermission: "read", ...extra });
}

describe("selectRoutingMoves", () => {
  it("moves each job a machine can run to its family's variable, and secret-bearing jobs to the trusted one", async () => {
    const s = await select(CI);
    expect(s.moves.map((m) => [m.jobId, m.from, m.variable])).toEqual([
      ["build", "macos-15", "BUILDHOUND_MACOS"],
      ["arm", "ubuntu-24.04-arm", "BUILDHOUND_LINUX_ARM64"],
      ["deploy", "ubuntu-latest", "BUILDHOUND_LINUX_TRUSTED"],
    ]);
    expect(s.moves.find((m) => m.jobId === "deploy")!.secrets!.length).toBeGreaterThan(0);
    expect(s.secretRouted).toBe(true);
    expect(s.arm64Routed).toBe(true);
    expect(s.kept.map((k) => k.jobId)).toEqual(["alone", "matrix"]);
    expect(s.already).toEqual([{ workflow: ".github/workflows/ci.yml", job: "routed", variable: "BUILDHOUND_LINUX" }]);
    expect(s.moves.every((m) => m.ranking === null)).toBe(true);
  });

  it("keeps every job where it is when routing is turned off, and ranks with the caller's function", async () => {
    expect((await select(CI, { routingEnabled: false })).moves).toEqual([]);
    const ranked = await select(CI, { rank: (j) => ({ stayCents: 100, cheapest: { provider: "github", label: j.label, cents: 100 } }) });
    expect(ranked.moves.find((m) => m.jobId === "build")!.ranking).toEqual({ stayCents: 100, cheapest: { provider: "github", label: "macos-15", cents: 100 } });
  });
});
