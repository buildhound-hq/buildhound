# buildhound

Your own computer runs your CI, and your agent sets it up.

Buildhound turns the Macs and Linux machines you already own into clean, single-use GitHub Actions runners: one virtual machine per job, destroyed after. When a machine is offline or busy, new jobs route to the healthy side, GitHub-hosted runners. Free for public repositories, flat per machine for private ones, never per minute.

## Start

Audit your workflows for wasted CI spend. Free, no account:

```bash
npx buildhound scan
```

Let your coding agent drive the rest. This installs the Buildhound skill and MCP server for Claude Code, Codex and Cursor:

```bash
npx buildhound setup
```

Or connect this machine yourself:

```bash
npx buildhound runner add --org <owner> --label macos
```

If something looks off, check this machine. It only reads, and says what to fix, one line each:

```bash
npx buildhound doctor
```

`npx buildhound --help` lists every command: `scan`, `estimate`, `route`, `rates`, `runner`, `failover`, `overview`, `jobs`, `job`, `savings`, `repos`, `plan`, `audit`, `settings`, `setup` and `doctor`.

## Built for agents

- JSON when the output is not a terminal, readable text when it is.
- Never interactive. Every error carries a `next` command to run.
- Read-only by default. Anything destructive needs `--yes`.
- When GitHub or a payment needs a person, the answer is `needs_human` with one link.

## Signing in

Commands that read your account use a GitHub token: `--token`, then `GITHUB_TOKEN`, then `gh auth token`. What you see follows your role on GitHub.

## Links

- Website: https://buildhound.sh
- Docs: https://buildhound.sh/docs
- Dashboard: https://app.buildhound.sh

MIT licensed.
