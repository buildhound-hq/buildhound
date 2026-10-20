# Set up with your agent

> One prompt. The agent does the rest and asks you only for the steps that need a person.

Paste one prompt into Claude Code, Codex or Cursor and your coding agent connects the machine and opens the pull request.

## The prompt

Paste this into Claude Code, Codex or Cursor, in the repository you want to run on this machine. It is the same prompt the button on the home page copies.

```
Set up Buildhound (https://buildhound.sh) so this repository's GitHub Actions jobs run on this machine.

1. Run `npx buildhound setup` to install the Buildhound skill and MCP server for you.
2. Connect this machine: `npx buildhound runner add --org <owner of this repository> --yes`. A Mac takes both macOS and Linux jobs; a Linux host takes Linux jobs. If it returns needs_human, give me the link or the command it names and wait until I say it is done. When the link installs the GitHub App, tell me to choose All repositories there, so I can pick which repositories run on my machines in the Buildhound dashboard later.
3. On a Mac, start its macOS image: `npx buildhound image build --yes`. It builds in the background and stops once for my password, so tell me to follow it with `npx buildhound image build` in a terminal. macOS jobs run on GitHub-hosted until it is ready.
4. Once the machine is connected, run `npx buildhound route --apply --repo <owner/name of this repository>`. It shows the pull request it would open and changes nothing; once I agree, run its `next`, the same command with `--yes`. That opens one pull request from the branch buildhound/route that moves each job this machine can run to the routing expression, with GitHub-hosted as the fallback, and keeps jobs that use secrets on GitHub-hosted until a Trusted machine is connected. I review and merge the pull request myself.

Docs: https://buildhound.sh/docs
```

## What your coding agent does

1. Runs `npx buildhound setup`, which installs the Buildhound skill and MCP server for the agents it finds on the machine.
2. Runs `npx buildhound runner add` for your account, which registers this machine and starts the Buildhound agent, which takes jobs.
3. On a Mac, starts the [macOS image](https://buildhound.sh/docs/macos-image) build with `npx buildhound image build --yes`.
4. Runs `npx buildhound route --apply`, shows you the pull request it would open, and opens it once you agree: one pull request from the branch `buildhound/route` that moves each job your machine can run to the routing expression, with GitHub-hosted as the fallback. Jobs that use secrets stay on GitHub-hosted until a Trusted machine is connected. Nothing is committed to your default branch; you review and merge it.

## The steps that need you

GitHub asks a person to install the GitHub App. When that is needed the command returns `needs_human` with one URL; your coding agent hands it to you, you click through, and it carries on. On GitHub's install page, choose All repositories: you then pick which ones run on your machines in the dashboard, and nothing routes until you merge a repository's pull request. On a Mac, the macOS image build stops once for a command you run with your password. Joining the Fleet, marking a machine as trusted and routing jobs that use secrets also need a person, by design.

## Check it worked

Linux jobs in that repository run on your machine within minutes of the prompt. On a Mac, macOS jobs follow once it has built its [macOS image](https://buildhound.sh/docs/macos-image): your coding agent starts the build, which took 29 to 46 minutes in our runs and stops once for a command you run with your password. Until then macOS jobs run on GitHub-hosted. To follow the build on the Mac:

```
npx buildhound image build --wait
```

To see the machine and its jobs:

```
npx buildhound runner status --org <owner>
```

Source: https://buildhound.sh/docs/setup-with-your-agent. Last updated 18 October 2026.
