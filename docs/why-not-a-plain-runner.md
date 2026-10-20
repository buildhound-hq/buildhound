# Why not a plain runner

> GitHub's own self-hosted runner is free. Here is what it does with your machine, and what Buildhound does instead.

What GitHub's own self-hosted runner does with your machine, and what Buildhound does differently.

## What a plain runner does

GitHub lets you register any machine as a self-hosted runner for free: download the runner, configure it, run it as a service. The job then runs straight on the host, as the user the runner runs as. Whatever it writes stays for the next job, it can reach anything the machine can reach, and if the machine is off, a job for its label waits up to 24 hours and then cancels. GitHub's own docs advise against self-hosted runners on public repositories, because a pull request from a fork would run on your machine.

## Side by side

|  | GitHub's self-hosted runner | Buildhound |
| --- | --- | --- |
| Each job | Runs straight on the host. Files, caches and leftovers carry over to the next job. | Runs in a fresh virtual machine, destroyed when the job ends; only a package cache for the repository is kept. A Linux box without KVM uses a fresh container instead and never takes secrets. |
| Your machine | The job sees the machine's files, keychain and network. | The job reaches the internet and nothing else: no host files, no local network, no cloud metadata, unless a person at the machine turns that off. |
| Secrets | Every job can use them, on any machine. | Jobs that use secrets go only to a machine a person marked Trusted. |
| Forks | On a public repository, a fork's pull request runs on your machine. GitHub advises against it. | Stays on GitHub-hosted, and so does any job a stranger can start, by the workflow expression and by the control plane. |
| Machine offline | Jobs wait up to 24 hours, then cancel. Nothing falls back. | New jobs route to the healthy side within three minutes, and with fallback on a stuck job is re-run on GitHub-hosted. |
| Laptops | Takes jobs on battery, while you work, with the lid half closed. | By default only while plugged in and not in use; turn either off, or pause it with one click. |
| Several machines | Labels, no priority: any runner with the label may take the job. | Primary, backup or off for each machine; set laptops to backup and they wait until the base machines are full. |
| Runner updates | You keep it within GitHub's 30-day window, on every machine. | The Buildhound agent updates itself and refuses to run an old runner. |
| Setup | Download, configure and register a service, per machine, in the browser. | One prompt to your coding agent, or two steps by hand. |
| Cost | Free. | Free for every public repository and one private one. Pro is $10 a machine a month, or $96 a year, for the rest. Never per minute. |

Every line on Buildhound's side is shipped behaviour. Security rules are in [Security](https://buildhound.sh/docs/security); routing in [Failover](https://buildhound.sh/docs/failover) and [Machines](https://buildhound.sh/docs/machines).

## When a plain runner is enough

A dedicated box, a private repository, no secrets beyond `GITHUB_TOKEN`, nobody working on the machine, and you are happy to keep the runner updated and to wait when it is down. That is a fine setup and it costs nothing. Buildhound is for the rest of what you own: the laptop you work on, the Mac mini that should stay clean, the team whose jobs carry secrets, and anyone who wants new jobs to route to GitHub-hosted when a machine is offline.

Source: https://buildhound.sh/docs/why-not-a-plain-runner. Last updated 18 October 2026.
