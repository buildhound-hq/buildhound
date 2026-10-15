# buildhound

Your own computer runs your CI, and your agent sets it up.

Buildhound turns the Macs and Linux machines you already own into clean, single-use GitHub Actions runners: one virtual machine per job, destroyed after. When a machine is offline or busy, new jobs route to the healthy side, GitHub-hosted runners. Free for public repositories, flat per machine for private ones, never per minute.

## Start

Get a CI report on your workflows: wasted CI spend and risky settings, each finding with a fix. Free, no account:

```bash
npx buildhound scan
```

Open the fixes as pull requests, one per rule, with your own GitHub login. It shows the plan and asks first; `--dry-run` only prints the branches, files and pull request bodies, `--rule R03` picks rules and `--one-pr` puts every fix in one:

```bash
npx buildhound scan --fix
```

Let your coding agent drive the rest. This installs the Buildhound skill and MCP server for Claude Code, Codex and Cursor:

```bash
npx buildhound setup
```

Or connect this Mac yourself. It takes both macOS and Linux jobs (`--label macos` or `--label linux` limits it to one); Linux hosts are coming:

```bash
npx buildhound runner add --org <owner>
```

Linux jobs run on it within minutes. For macOS jobs, build the macOS image on this Mac: Apple does not allow macOS or Xcode to be redistributed, so each Mac builds its own from Apple's restore image and its own Xcode, in the background, in about 30 minutes, with your password asked once. `runner add` offers it; macOS jobs run on GitHub-hosted until it is ready, then switch over on their own:

```bash
npx buildhound image build
```

If something looks off, check this machine. It only reads, and says what to fix, one line each:

```bash
npx buildhound doctor
```

`npx buildhound --help` lists every command: `scan`, `estimate`, `route`, `rates`, `runner`, `failover`, `overview`, `jobs`, `job`, `savings`, `repos`, `plan`, `audit-log` (alias `audit`), `settings`, `setup`, `doctor` and `image`.

## Built for agents

- JSON when the output is not a terminal, readable text when it is.
- Never interactive. Every error carries a `next` command to run.
- Read-only by default. Anything that writes needs `--yes`: `scan --fix` without it returns the plan, with the `--yes` command as `next`.
- When GitHub or a payment needs a person, the answer is `needs_human` with one link.

## Signing in

Commands that read your account use a GitHub token: `--token`, then `GITHUB_TOKEN`, then `gh auth token`. What you see follows your role on GitHub.

## Links

- Website: https://buildhound.sh
- Docs: https://buildhound.sh/docs
- Dashboard: https://app.buildhound.sh

MIT licensed.
