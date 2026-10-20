# Buildhound for Claude

Buildhound prices your GitHub Actions CI, opens fixes for wasteful workflows as pull requests, and runs your jobs on the Macs and Linux machines you already have, each job in a fresh virtual machine, with GitHub-hosted runners as the fallback. This plugin gives Claude the Buildhound skill and the Buildhound MCP server, so you can ask in plain words.

## Use it

Ask Claude what your CI costs, why a workflow is slow, or to route a repository to a machine you own. For example:

- "What does CI cost in this repository, and what would you change?"
- "Open the fixes from the CI report as pull requests."
- "Connect this Mac as a runner for my organisation."

The skill tells Claude when to use each tool and what to ask you first: nothing that opens a pull request, connects a machine or changes routing runs until you agree, and anything that needs a payment or GitHub admin rights comes back to you as a link.

## What it runs

The plugin starts the Buildhound MCP server, `@buildhound/mcp` from npm, at a pinned version, with `npx`, on your computer. The server runs `gh auth token` to find your GitHub token when `GITHUB_TOKEN` is not set. Three tools act on the computer, and only when you ask for them:

- `runner_add` downloads the Buildhound agent from dl.buildhound.sh, writes its settings file, and installs it as a background service. `runner_remove` undoes that.
- `image_build` builds the macOS image that macOS jobs run in on a Mac. It downloads Apple's restore image once, about 27 GB, and asks for your password once.
- `doctor` reads the machine's state, such as free disk and memory, and changes nothing.

## Data

The CI report reads your workflow files on your computer and, for run history, the GitHub API; fetched history is kept for an hour in `~/.cache/buildhound` so a second command does not fetch it again. Account tools send requests to GitHub and to the Buildhound API at api.buildhound.sh. Your GitHub token goes only to GitHub and to api.buildhound.sh, and the server never writes it to disk. A connected machine gets its own Buildhound credential, kept in the agent's settings file. The server sends no usage telemetry.

What Buildhound stores, how long it keeps it and your rights are in the privacy policy: https://buildhound.sh/legal/privacy. Security: https://buildhound.sh/legal/security.

## Links

- Docs: https://buildhound.sh/docs/mcp
- Source: https://github.com/buildhound-hq/buildhound
- Support: support@buildhound.sh

MIT licensed.
