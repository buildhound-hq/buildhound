# Set up by hand

> Every step the coding agent takes is one command you can run. In order, with what to expect from each.

Connect a machine, open the routing pull request and check it worked yourself, one command per step.

## Get the CLI

Nothing to install first: `npx buildhound` runs the current release on any machine with Node 22. Sign in to GitHub with `gh auth login`, or put a token in `GITHUB_TOKEN`. To keep the command around:

```
npm install -g buildhound
```

Every command prints what to run next, and JSON when a coding agent runs it instead of you.

## Connect the machine

On the machine that will run jobs:

```
npx buildhound runner add --org <owner> --yes
```

A Mac takes both macOS and Linux jobs, and a Linux host with KVM takes Linux jobs; `--label` narrows it. `--check` says whether the machine is ready before you connect. The command registers the machine, writes its config (`~/.buildhound/agent.json` on a Mac, `/var/lib/buildhound/agent.json` on Linux), installs the Buildhound agent and starts it. If GitHub needs the App installed first, the command prints one URL and stops; install the App, then run the same command again.

On a Linux host it needs root once. Check first, then connect as root with your GitHub token in the environment, never on the command line; the check prints this exact command when you are not root:

```
npx buildhound runner add --org <owner> --check
```

```
GITHUB_TOKEN="$(gh auth token)" sudo --preserve-env=GITHUB_TOKEN,PATH npx buildhound runner add --org <owner> --yes
```

The checks, the service, the logs and the labels a Linux host serves are in [Machines](https://buildhound.sh/docs/machines#linux). On a personal account you can limit a machine to some repositories with `--repositories owner/name,owner/other`. By default a job's VM reaches the internet and nothing on your network.

What to expect: the command ends with the machine's name and the next command, and the Buildhound agent checks in within a minute. The dashboard's setup window, if it is open, says the machine is registered, then turns green when it is connected. On a Mac, Buildhound for Mac is a separate download from the [Download page](https://buildhound.sh/download); unzip it into Applications and open it to see what runs on this Mac and pause it. The agent runs without it.

## On a Mac, build the macOS image

Linux jobs run on a Mac as soon as it connects. macOS jobs need the [macOS image](https://buildhound.sh/docs/macos-image), which each Mac builds once. `runner add` offers it at the end; to start it yourself:

```
npx buildhound image build
```

It downloads Apple's restore image once (about 27 GB), took 29 to 46 minutes in our runs, and stops once for a command you run with your password. `--check` only says what to fix first. Until it is ready, macOS jobs run on GitHub-hosted.

## Open the routing pull request

In a checkout of the repository, or anywhere with `--repo`:

```
npx buildhound route --apply --repo <owner/name>
```

It prints the pull request it would open and changes nothing: each job that moves to your machine, what stays on GitHub-hosted and why, and the monthly saving with its calculation. Run the command it gives as `next`, the same one with `--yes`, and it opens one pull request from the branch `buildhound/route`. Only `runs-on` changes, to the routing expression for the repository's visibility, with the old label kept as the fallback:

```
runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}
```

Jobs that use secrets get the Trusted variable and stay on GitHub-hosted until a machine is marked Trusted. Review and merge the pull request; nothing routes before that. You can also make the change yourself, one line per job, with the expressions in [Workflows](https://buildhound.sh/docs/workflows), which has the longer form a public repository needs.

## Check it worked

On the machine, any time, and the first thing to run when something looks off:

```
npx buildhound doctor
```

One line per check, `✓`, `!` or `X`, with a `Fix:` line under anything that needs you: the Mac or Linux host, the Buildhound agent and its version, the images, the GitHub App, the account and the network. It changes nothing. From anywhere, to see machines, heartbeats and running jobs:

```
npx buildhound runner status --org <owner>
```

## What you are live looks like

The dashboard's setup window lands on “You’re live” once the machine has checked in: the machine connected with its trust tier, the Linux image ready, on a Mac the macOS image ready or building with how long is left, and the routing pull request with a link to it. The next job from a routed repository runs on your machine; it shows up in Jobs with how long it waited, how long it took and what GitHub-hosted would have charged, and from a terminal:

```
npx buildhound jobs --org <owner>
```

When the machine is busy or offline, new jobs route to GitHub-hosted on their own, and back to your machine once it is free; macOS jobs stay on GitHub-hosted until the macOS image is ready. The defaults chosen in setup, the repositories that route, the fallback and whether the machine stays awake between jobs, can be changed later on the dashboard's Fleet page, in the machine's panel and under Where new jobs run; the repositories and the fallback also with `buildhound runner set` and `buildhound failover`.

Source: https://buildhound.sh/docs/setup-by-hand. Last updated 19 October 2026.
