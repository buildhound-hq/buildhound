# Security

> Clean, isolated, and honest about what a host can and cannot see.

A fresh VM per job, an isolated network, trust tiers for secrets, and what a person has to decide.

## A fresh VM per job

Every job runs in a virtual machine booted from an image whose every part is checked against its published checksum, and destroyed when the job ends. The runner has admin rights inside its VM, as on GitHub-hosted, but the VM cannot see the host's files or keychain. The Buildhound agent runs as your user, uses only its own folder, ~/.buildhound, never reads your keychain, and sends us heartbeats and job metadata only, never job content.

## Nothing on your network

A job's VM reaches the internet and nothing else: not your private network, not the host's own services, not cloud metadata addresses. This is the default, `--vm-network isolated`.

## Secrets only on trusted machines

Every machine is Trusted or No secrets (stored as `trusted` or `burst`). Only a person can mark a machine Trusted: Buildhound holds the change until an admin signed in to the dashboard approves it, and only when its disk is encrypted. An API token alone cannot do it. A job that uses secrets other than `GITHUB_TOKEN`, sets an `environment`, requests `id-token: write` or inherits secrets is handed only to a trusted machine; the control plane checks the workflow when it registers the runner.

## Forks stay off

On a public repository, a job a stranger can start never runs on your machine. The routing expression sends a job there only for a push, a schedule, a manual run, the merge queue, a release or a pull request from the repository's own branches; fork pull requests, comments and discussions stay on GitHub-hosted ([Workflows](https://buildhound.sh/docs/workflows)). As a second line, the control plane reads each job's run from GitHub before any machine takes it and refuses one started by any other event, whatever the workflow says, then re-runs it on GitHub-hosted.

## People decide, agents prepare

Joining the Fleet, marking a machine as Trusted and routing a repository with secret-bearing jobs each need the owner or an admin. A coding agent prepares the step and returns `needs_human`. Network isolation is turned off only by connecting the machine again with `--vm-network nat`, and only by a person who types the machine's name at a terminal on it. Every job records the machine, its trust tier, the image and the agent and runner versions it ran with. The full picture is on the [security page](https://buildhound.sh/legal/security).

Source: https://buildhound.sh/docs/security. Last updated 16 October 2026.
