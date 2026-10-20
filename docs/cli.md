# CLI

> Everything the dashboard can do, from a terminal, by you or by your coding agent.

Every buildhound command and its main flags, its output for people and for coding agents, and its exit codes.

## Install

The CLI is the `buildhound` package on npm. Run it with `npx`, no install step:

```
npx buildhound --help
```

This page covers version 0.1.8.

## Commands

| Command | What it does |
| --- | --- |
| `setup` | Install the Buildhound skill and the MCP server entry for Claude Code, Cursor and Codex, when they are present. setup agent is the same command. |
| `doctor` | Check this machine, the Buildhound agent, the account and the network, one line each with a fix. Read-only. |
| `runner add` | Connect this machine as a single-use runner: register, write its config, install and start the Buildhound agent. A Mac takes macOS and Linux jobs; a Linux host with KVM takes Linux jobs. |
| `image build` | Build the macOS image on this Mac in the background through the Buildhound agent, or follow the build already running. --check only checks the Mac. |
| `runner status` | Machines, heartbeats, running jobs and the failover map for an account with --org; --local asks the Buildhound agent on this machine. |
| `runner set` | Change a machine's routing and settings: pause, performance mode, only when not in use or plugged in, Trusted, and the repositories it serves. |
| `runner remove` | Remove a machine (kept 48 hours) and stop the local Buildhound agent when it is this machine. |
| `runner cleanup` | Free up space on a machine: shows what Buildhound keeps there and what clearing its leftovers (old images, the image build cache, package caches over their limits) frees; with --yes the machine clears them within 30 seconds. |
| `cache list` | What the package caches take on each machine, per repository, as its last check-in reported. Read-only. cache status is the same command. |
| `cache clear` | Clear the package caches on your machines, for one repository with --repository or every one, on one machine with --machine or every one. Needs --yes; each machine clears within 30 seconds. |
| `cache reset` | Start the caches over on your machines when clearing one repository's did not help: every repository's package caches, the tool cache and anything else in the cache folder go. Needs --yes; each machine resets within 30 seconds. |
| `failover` | Inspect routing per label; turn falling back to GitHub-hosted on or off with --fallback, or override with --set. |
| `scan [path]` | Scan workflow files for a CI report: findings on wasted CI spend, each with a fix, priced from run history when the git remote and a GitHub login are found. --fix opens the fixes as pull requests. |
| `estimate <workflow-file>` | Monthly cost of one workflow file, with the assumptions listed. |
| `route [path]` | Runner candidates for every job over the spend threshold, ranked by computed cost, with the monthly saving on a machine you already have. --apply opens the routing pull request. |
| `rates` | The rate tables the cost model uses, with source and verified date. |
| `overview` | This month at a glance: jobs on your machines, what they would have cost on GitHub-hosted, fallbacks, machines and what needs you. |
| `jobs` | Jobs your machines ran, newest first, with wait, run time and what GitHub-hosted would have cost. |
| `job <id>` | One job's story: waiting, where it ran, re-runs and its cost against GitHub-hosted. |
| `savings` | Month by month, what the jobs on your machines would have cost on GitHub-hosted, with the calculation. |
| `repos` | Repositories the GitHub App can see, whether each routes to your machines, and its jobs in the last 30 days. |
| `plan` | The account's plan, the price per machine, the machines connected and, on Free, its one private repository. |
| `billing checkout` | Paddle's checkout for Pro: answers needs_human with the URL where a person pays. Charges nothing by itself. Admins only. |
| `billing period` | Switch between annual and monthly billing at the next renewal. Charges nothing now; without --yes it only says what would happen. Admins only. |
| `audit-log` | The audit log: every admin change to machines, routing and defaults, newest first. Admins only. audit is the same command. |
| `settings` | The account's defaults for new machines; --performance sets the mode a newly connected machine starts with. Admins only. |

Every command takes `--json` and `--help`. Commands for an account or a machine take `--org <login>`, the GitHub organisation or user.

## Connect a machine

`runner add` connects the machine you run it on. `--org` is required, and on a Mac the machine takes macOS and Linux jobs unless `--label` says otherwise:

```
npx buildhound runner add --org <login> --yes
npx buildhound runner add --org <login> --label macos --yes
```

| Flag | What it does |
| --- | --- |
| `[object Object] <login>` | Required. The GitHub organisation or user that owns the machine. |
| `[object Object] <os>` | What the machine runs: `macos`, `linux` or `macos,linux`. On a Mac it defaults to `macos,linux`. |
| `[object Object] <machine>` | The machine's name. Defaults to the hostname. |
| `[object Object] <list>` | On a personal account, serve only these repositories, as owner/name separated by commas. Kept on later runs. |
| `[object Object] <n>` | Jobs at once, or auto, the default: one macOS job and as many 8 GB Linux jobs as memory holds, and laptops one at a time. |
| `[object Object] <n>` | Pin every job VM to this many cores, or auto. By default the Buildhound agent sizes VMs from the machine. |
| `[object Object] <n>` | Pin every job VM to this much memory in MiB, or auto. |
| `[object Object] <n>` | macOS jobs at once: 1, 2 or auto. Apple allows two macOS VMs per Mac. |
| `[object Object] <mode>` | isolated, the default, lets job VMs reach the internet and never your network. nat lets them reach your network, for CI that must reach a service on it, and needs a person to type the machine's name at a terminal, even with --yes. |
| `[object Object] <on\|off>` | Count, per weekday hour, the minutes this machine is awake, plugged in and free, and share only those counts. |
| `[object Object] <path>` | Use this buildhound-agent binary instead of locating or downloading one. |
| `[object Object]` | Only check whether this machine can run job VMs, and say what to fix. Registers and writes nothing. |
| `[object Object]` | Connect without asking. Required when there is no terminal. |

Running it again on a connected machine returns the existing state, with each step reported. A laptop joining an organisation's Fleet waits for its owner to type the laptop's name at a terminal on it; without one, the command returns `needs_human`.

On a Mac, Linux jobs run as soon as it connects, and macOS jobs follow once the macOS image is built on it. In a terminal `runner add` offers to build the image right away; without one, its `next` is `buildhound image build --yes`.

On a Debian or Ubuntu host with KVM, `runner add` connects it as a system service, and every job runs in its own Firecracker microVM with an isolated network and is wiped after. The host checks run first; a failure stops the command with `HOST_NOT_READY` and the fix. Root is needed once, for the service, the job VMs' network and KVM: run as root it does everything, otherwise it answers `needs_human` with reason `root_needed` and the one command to run with `sudo`, which carries your GitHub token in the environment and never on the command line. An x86-64 host takes `buildhound-linux` and `buildhound-linux-x64` jobs, an arm64 host `buildhound-linux` and `buildhound-linux-arm64`. The config is `~/.buildhound/agent.json` on a Mac and `/var/lib/buildhound/agent.json` on Linux, where the agent logs to the journal (`journalctl -u buildhound-agent`).

`--check` reads the machine and registers nothing. On Linux it checks the architecture, KVM, cores, memory, disk, cgroups, systemd, the kernel, `ip` and `nft`, and whether it runs as root, each with a fix; on a Mac, Apple silicon, cores, memory and disk. It answers `{ status: "checked", ready, can_connect, isolation, checks, next }` and exits 1 when a check failed. A Linux machine without KVM can still connect when Sysbox is installed: its jobs then run in containers that share its kernel, `isolation` is `container` with a warning, and jobs that use secrets never run there.

```
npx buildhound runner add --org <login> --check
```

`runner status` lists an account's machines with `--org`. With `--local`, or with neither flag on a connected machine, it asks the Buildhound agent on this machine:

```
npx buildhound runner status --org <login>
npx buildhound runner status --local
```

## Build the macOS image

`image build` builds the macOS image that macOS jobs run in, on this Mac, from Apple's restore image and this Mac's Xcode. The Buildhound agent runs it in the background in nine steps: checks, Apple's restore image (about 27 GB, downloaded once), the macOS install, one step that needs your password, Xcode and simulators, tools, a simulator warm-up and a check of the image, and then macOS jobs turn on. It took 29 to 46 minutes in our runs, and macOS jobs run on GitHub-hosted until it finishes. More on the [macOS image](https://buildhound.sh/docs/macos-image) page.

```
npx buildhound image build --check
npx buildhound image build
npx buildhound image build --yes --wait --json
```

| Flag | What it does |
| --- | --- |
| `[object Object]` | Only check this Mac and say what to fix, such as Xcode, the iOS simulator runtime, disk space or power. Changes nothing, and works before the Buildhound agent runs. |
| `[object Object]` | Build a new image even when the one in use already has this Mac's Xcode. |
| `[object Object]` | Follow the build until it is ready, fails or needs your password. Without a terminal it prints one JSON progress line per change, then the result. In a terminal the command always follows the build live. |
| `[object Object]` | Start the build without asking. Required when there is no terminal. |

At the password step the command prints the exact `sudo` line to run in a terminal on this Mac; once a person has run it, the build continues on its own. Without a terminal it returns `needs_human` with reason `password_needed`, that command and a URL. A laptop on battery pauses between steps until it is plugged in.

Running it again follows or continues the build, and never starts a second one. Stopping the command leaves the build running in the background. An image that already matches this Mac's Xcode is not rebuilt: the command answers `ready` with `already_built` and asks nothing. `runner status --local` and `doctor` show the build's current step. On a machine that is not a Mac it fails with `NOT_A_MAC`, and before the Buildhound agent is set up, with `NOT_CONNECTED`.

## Change a machine

`runner set` needs `--machine`, `--org` and at least one change. Every change can be undone, so it takes no `--yes`. Settings reach the machine within 30 seconds, and a later change made on the machine wins.

```
npx buildhound runner set --machine <id|name> --org <login> --routing backup
npx buildhound runner set --machine <id|name> --org <login> --idle-only on --plugged-in-only on
npx buildhound runner set --machine <id|name> --org <login> --add-repository <owner/name>
```

| Flag | What it does |
| --- | --- |
| `[object Object] <id\|name>` | Required. The machine to change. |
| `[object Object] <login>` | Required. The GitHub organisation or user that owns the machine. |
| `[object Object] <role>` | primary, the default, takes jobs whenever it can, backup only when no primary can, off stays connected and visible but takes none. |
| `[object Object] --resume` | Stop taking new jobs, or take jobs again. Running jobs always finish. |
| `[object Object] <mode>` | quiet, balanced or max. |
| `[object Object] <mode>` | adaptive eases a running job off (lower priority, a smaller next job) before the Mac refuses new jobs, or off. |
| `[object Object] <on\|off>` | Only when not in use, so the machine takes jobs only while nobody is using it. |
| `[object Object] <on\|off>` | Take jobs only while plugged in. |
| `[object Object] <on\|off>` | on makes the machine Trusted, so it takes jobs that use secrets; a person approves it in the dashboard. off sets No secrets. |
| `[object Object] <list>` | On a personal account, serve only these repositories, as owner/name separated by commas, or all for every repository the GitHub App covers. |
| `[object Object] <list>` | On a personal account, also serve these repositories, as owner/name separated by commas. |
| `[object Object] <list>` | On a personal account, stop serving these repositories. |

`--trusted on` lets a machine take jobs that use secrets, deployment environments and cloud logins. Buildhound holds the change until a person signed in to the dashboard as an admin approves it, within 10 minutes. At a terminal the command prints the link and waits; your coding agent gets `needs_human` with the link to hand over. `--yes` does not count. `--trusted off` sets No secrets at any time.

The repository flags are for machines on a personal account. `--repositories` replaces the list, and `all` serves every repository the GitHub App covers. `--add-repository` and `--remove-repository` change the list and cannot be combined with `--repositories`. The machine applies the change at its next check-in. A repository the GitHub App does not cover returns `needs_human` with the GitHub page where a person adds it.

## Remove a machine

`runner remove` needs `--machine`, `--org` and `--yes`. New jobs route to the healthy side and the registration is kept 48 hours. When it is this machine, the Buildhound agent's service stops and `~/.buildhound/agent.json` is kept.

```
npx buildhound runner remove --machine <id|name> --org <login> --yes
```

## Routing and fallback

`failover` shows, per label, where new jobs go and why. When your machines are offline or busy, new jobs route to the healthy side. Pass `--fallback` or `--set` to change it, not both:

```
npx buildhound failover --org <login>
npx buildhound failover --org <login> --fallback off --yes
npx buildhound failover --org <login> --label buildhound-macos --set forced_hosted --yes
```

| Flag | What it does |
| --- | --- |
| `[object Object] <login>` | Required. The GitHub organisation or user. |
| `[object Object] <label>` | The label to change. `--set` defaults to `buildhound-macos`; `--fallback` without it changes every label. |
| `[object Object] <on\|off>` | on, the default, falls back to GitHub-hosted when no machine can take a job. off is without fallback: jobs always wait for your machines. |
| `[object Object] <mode>` | Set the mode directly: auto, forced_machine or forced_hosted. |
| `[object Object] <text>` | Why the change was made. |
| `[object Object]` | Change routing without asking. Required when there is no terminal. |

## Check a machine

`doctor` checks this machine, the Buildhound agent on it, the account and the network at once, and prints one line per check with a fix under each one to act on. It only reads, and never stops or changes anything.

```
npx buildhound doctor
npx buildhound doctor --org <login> --json
```

It checks Node, the GitHub sign-in, the Buildhound API, the account and its plan, the Buildhound agent and when the control plane last heard from it, the repositories this machine serves, its images, power, memory, free disk space, simulators, Docker and other VMs, disk encryption, the server images and updates download from, GitHub's API and routing. `--org` defaults to the account this machine is connected to, else the signed-in user.

The JSON is `{ ok, checks: [{ id, status, title, detail?, fix? }], next }`, with each status `ok`, `warn`, `fail` or `skip`. `ok` is false, and the exit code 1, only when a check failed. A check that has no answer in 15 seconds is reported as a warning, not waited for.

## CI report and cost

`scan`, `estimate`, `route` and `rates` work from workflow files and need no account. `scan` and `route` read run history when they find the git remote and a GitHub login, or when `--repo` names the repository. `route` only reads: each job's `runs_on` is the exact line to write, and `route --apply` writes it for you as a pull request.

```
npx buildhound scan .
npx buildhound scan . --repo <owner/name> --fail-on high
npx buildhound scan . --fix
npx buildhound scan . --fix --rule R03 --one-pr --yes
npx buildhound estimate .github/workflows/ios.yml --runs-per-month 200
npx buildhound route . --repo <owner/name>
npx buildhound route . --apply --repo <owner/name>
npx buildhound rates --provider github
```

`scan --fix` opens the fixes as pull requests on GitHub with your own GitHub login, one per rule, or one for every fix with `--one-pr`. Without `--yes` and without a terminal it writes nothing and returns the plan, with `next` set to the same command with `--yes`; in a terminal it shows the plan and asks once. The fixes are made against the default branch on GitHub, never against uncommitted changes. A rerun updates its own pull requests or reports them `unchanged`, and never opens a duplicate; a fix whose pull request was closed without merging is not opened again. A classic `gh` token needs the workflow scope to change workflow files: `gh auth refresh -s workflow`.

`route --apply` opens the routing pull request the same way, one pull request from the branch `buildhound/route` against the default branch. Every job a connected machine can run moves to the routing expression for the repository's visibility, keeping its label as the GitHub-hosted fallback, and on a public repository older expressions are upgraded; only `runs-on` changes, so comments and formatting stay. A job that can reach secrets, an environment or a write token moves to its family's Trusted variable instead, which only machines a person marked Trusted serve, and runs on GitHub-hosted until one is connected. A job on an arm64 runner such as `ubuntu-24.04-arm` moves to `BUILDHOUND_LINUX_ARM64`, which only arm64 machines serve, so an x86-64 host never takes a native arm64 build. The pull request body shows the speed-up measured from run history, or "not measured yet" until each side has three runs, the monthly saving with its calculation and no saving claimed on a public repository, the ranking with the stay option, and what takes effect when. Closing the pull request is how you stay; a closed one is not opened again, and a rerun updates it or reports `unchanged`.

| Flag | Command | What it does |
| --- | --- | --- |
| `[object Object] <owner/name>` | scan, route | Read this repository's workflows and its last --days of runs from GitHub instead of the checkout. |
| `[object Object] <n>` | scan, route | Days of run history to fetch, 30 by default. |
| `[object Object] <ids>` | scan | Run only these rules, separated by commas, such as R01,R03. |
| `[object Object] <severity>` | scan | Exit 1 when a finding at or above this severity exists: high, medium or low. |
| `[object Object]` | scan | Workflow files only, with no run history and no network. |
| `[object Object]` | scan | Do not look up action tags on GitHub, so R17 findings come without a diff. |
| `[object Object]` | scan | Open the CI report's fixes as pull requests on GitHub, one per rule. Plans only until --yes. |
| `[object Object] <id>` | scan --fix | A rule to open a pull request for, repeatable, such as `--rule R03 --rule R06`. Without it, every rule with a fix. |
| `[object Object]` | scan --fix | One pull request for every fix instead of one per rule. |
| `[object Object]` | scan --fix | Print the branches, files and pull request bodies without writing to GitHub, even with --yes. |
| `[object Object]` | scan --fix | Open the pull requests without asking. Without it and without a terminal, the command returns the plan and writes nothing. |
| `[object Object]` | route | Open a pull request that routes each job a connected machine can run, with GitHub-hosted as the fallback. Plans only until --yes. |
| `[object Object]` | route --apply | Print the pull request without writing to GitHub, even with --yes. |
| `[object Object]` | route --apply | Open the pull request without asking. Without it and without a terminal, the command returns the plan and writes nothing. |
| `[object Object] <n>` | estimate | Override the runs per month for every event. |
| `[object Object] <names>` | route | Only these providers, separated by commas, such as blacksmith,ubicloud. |
| `[object Object] <name>` | rates | Only this provider. |

## Jobs and the account

These commands read what the dashboard shows. What you see follows your role on GitHub: a member of an organisation sees only the repositories they can read. `settings --performance` is the one change here, and it can be undone.

```
npx buildhound overview --org <login>
npx buildhound jobs --org <login> --result failure
npx buildhound job <id> --org <login>
npx buildhound savings --org <login> --months 12
npx buildhound repos --org <login>
npx buildhound plan --org <login>
npx buildhound billing checkout --org <login> --annual
npx buildhound billing period --org <login> --billing annual --yes
npx buildhound audit-log --org <login>
npx buildhound settings --org <login> --performance quiet
```

| Flag | Command | What it does |
| --- | --- | --- |
| `[object Object] <login>` | every command | Required. The GitHub organisation or user. |
| `[object Object] <owner/name>` | jobs | Only this repository. |
| `[object Object] <name\|id>` | jobs | Only this machine. |
| `[object Object] <label>` | jobs | Only this label, such as `buildhound-macos`. |
| `[object Object] <result>` | jobs | One of success, failure, cancelled or running. |
| `[object Object] <n>` | jobs | Jobs per page, up to 200, 50 by default. |
| `[object Object] <time>` | jobs, audit-log | The next page, from the previous page's next_before. |
| `[object Object] <YYYY-MM>` | overview | Another month, in UTC. |
| `[object Object] <n>` | savings | How many months back, up to 24, 6 by default. |
| `[object Object] <mode>` | settings | The mode a newly connected machine starts with, quiet, balanced or max. Machines already connected keep their own. |
| `[object Object] <period>` | billing period | Required. annual or monthly. The period billed now drops a switch already scheduled. |
| `[object Object]` | billing period | Make the switch. Without it the command only says what would happen. |
| `[object Object]` | billing checkout | Billed annually, $96 a machine a year, instead of monthly, $10 a machine a month. |

Paying is a person's step. `billing checkout` asks for a Paddle checkout for Pro, on any account, monthly unless `--annual`, for the machines connected now and at least one. It answers `needs_human` with the checkout URL and exits 0, and its `next` is `buildhound plan`, which shows the subscription once Paddle confirms the payment. The first payment is refundable on request within 30 days. An account that already pays fails with `ALREADY_SUBSCRIBED`.

`billing period` switches a subscription between annual and monthly at its next renewal, on the same plan and machines, and charges nothing when you ask. Without `--yes` it changes nothing and says what would happen: the new price, the payment at the renewal and the day it applies. Asking for the period billed now drops a switch already scheduled. An account without a subscription fails with `NO_SUBSCRIPTION`, and one that is past due, paused or set to end with `SUBSCRIPTION_NOT_ACTIVE`.

## Output for people and for coding agents

In a terminal, commands print plain tables and a few quiet progress lines. When stdout is not a terminal, or with `--json`, every command prints one JSON object on stdout and keeps logs on stderr, and never asks a question. With `--wait`, `image build` also prints a JSON progress line per change before the result. `runner add`, `runner remove`, a `failover` change and starting an `image build` take `--yes`; without a terminal they fail with `CONFIRM_REQUIRED` until it is passed. `scan --fix` and `billing period` without `--yes` say what they would do instead.

Marking a machine Trusted needs a person to approve it in the dashboard, and a laptop joining an organisation's Fleet needs its owner to type its name at a terminal on it; `--yes` does not count for either. When GitHub, paying, the password step of `image build` or one of these needs a person, the command returns `needs_human` with one URL and a `next` step, and exits 0. On Free, routing a second private repository or connecting a third machine answers the same way with reason `needs_plan` and the billing page as the one URL.

Every error carries a code, a message and what to do next:

```
{ "error": { "code": "CONFIRM_REQUIRED", "message": "...", "next": "buildhound runner remove --machine mini-01 --org acme --yes" } }
```

## Exit codes and tokens

`0` success, `1` a finding at `--fail-on`, a failed check in `doctor` or `runner add --check`, or an `image build` that failed, is blocked or has a failed check, `2` usage error, including a missing `--yes`, `3` auth error, `4` network or GitHub error.

Commands that talk to GitHub or the control plane take `--token`, else `GITHUB_TOKEN`, else the token from `gh auth token`. Fetched run history is cached for an hour under `~/.cache/buildhound/history`.

Source: https://buildhound.sh/docs/cli. Last updated 19 October 2026.
