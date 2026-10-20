# Buildhound

[![CI](https://github.com/buildhound-hq/buildhound/actions/workflows/ci.yml/badge.svg)](https://github.com/buildhound-hq/buildhound/actions/workflows/ci.yml)

Buildhound turns the Macs and Linux machines a team already has into clean, single-use GitHub Actions runners, set up by the team's coding agent. Every job runs in a fresh virtual machine that is destroyed when it ends. Jobs go to your machines first and GitHub-hosted stays as the fallback: when a machine is busy or offline, new jobs route to the healthy side. Free for every public repository and one private repository on up to two machines; Pro is $10 a connected machine a month or $96 a year, flat, never per minute.

Site and docs: https://buildhound.sh

## What is in this repository

The parts of Buildhound that run on your machine or in your editor, under the MIT licence:

| Path | Package | What it is |
| --- | --- | --- |
| `apps/cli` | [`buildhound`](https://www.npmjs.com/package/buildhound) | The command line: the free CI report, fixes as pull requests, connecting a machine, routing jobs. JSON when not in a terminal, built for coding agents |
| `apps/mcp` | [`@buildhound/mcp`](https://www.npmjs.com/package/@buildhound/mcp) | The MCP server: the same operations as the CLI as tools for Claude Code, Codex and Cursor |
| `packages/core` | `@buildhound/core` | The rules behind the CI report, the cost model with every vendor's list price and its source, and the YAML editing that keeps comments |
| `packages/shared` | `@buildhound/shared` | The control plane's request and response schemas, shared by the CLI and the dashboard |
| `packages/github` | `@buildhound/github` | The GitHub client the CLI uses: run history, workflow files, pull requests |
| `docs` | | The docs site as markdown, the same text buildhound.sh serves at `/docs/<page>.md` |

The control plane, the dashboard and the machine agent are not in this repository. This is a read-only mirror of a private monorepo, refreshed on every change to its main branch; see `CONTRIBUTING.md` for how issues and pull requests work here.

## Try it

The free CI report, in any repository with GitHub Actions workflows:

```bash
npx buildhound scan
```

It reads the workflow files, and the run history when you are logged in with `gh`, and prices every job. Each finding carries its evidence, an estimate, a confidence and a diff; `npx buildhound scan --fix` opens the fixes as pull requests once you agree.

To set up with your coding agent, paste the prompt from https://buildhound.sh into Claude Code, Codex or Cursor. By hand: https://buildhound.sh/docs/setup-by-hand.

The skill and the MCP server for your agent, from this repository:

```bash
npx skills add buildhound-hq/buildhound
```

In Claude Code, `/plugin marketplace add buildhound-hq/buildhound`, then `/plugin install buildhound@buildhound`.

## Develop

Node 22 and pnpm 11.

```bash
pnpm install
pnpm test
pnpm typecheck
```

Tests sit next to the code. The rule fixtures under `packages/core/fixtures` are real workflow files with secrets stripped.

## Licence

MIT. Each package carries its own `LICENSE` file.
