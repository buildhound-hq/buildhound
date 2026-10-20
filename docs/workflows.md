# Workflows

> One line per job. The rest routes itself.

The one line that routes a job to your machine, with a hosted default, and how a public repository keeps strangers off it.

## The routing line

A job's `runs-on` reads a repository variable, `BUILDHOUND_MACOS` or `BUILDHOUND_LINUX` (`BUILDHOUND_LINUX_ARM64` for a job that must stay on arm64, which `route` proposes for jobs on `ubuntu-24.04-arm`), with GitHub's hosted label as the default:

```
runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}
```

The control plane writes the variable when a machine can take jobs for that label and clears it when none can. Your workflow never changes again; where the job runs follows your machines.

## Public repositories

On a public repository anyone on GitHub can open a pull request from a fork, comment on an issue or start a discussion, and each of those can start a workflow. Use the longer expression. It sends a job to your machine only for a push, a schedule, a manual run, the merge queue, a release, or a pull request from a branch of the repository itself. Everything else stays on GitHub-hosted, whatever the variable says:

```
runs-on: ${{ ((github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'release') && vars.BUILDHOUND_MACOS || 'macos-latest' }}
```

A pull request whose fork was deleted, `pull_request_target`, `workflow_run` and comment events all stay on GitHub-hosted. `npx buildhound route --repo owner/name` gives the line to write for each job and lists any routed job on a public repository that still uses an older expression, with the change to make. `npx buildhound route --apply --repo owner/name` opens one pull request that makes every change, from the branch `buildhound/route`; closing it is how you stay, and it is not opened again.

## Several jobs and machines

Every machine on the account registers under the shared label, so a matrix fans out across whichever machines have room. A machine runs one macOS job at a time, plus up to four 8 GB Linux jobs as its memory allows; laptops run one job at a time. Jobs that use secrets run only on machines marked Trusted ([Security](https://buildhound.sh/docs/security)).

## Run a workflow by hand

The dashboard's Run workflow on Jobs starts a workflow the way GitHub's own Run workflow button does, so it lists only workflows that have `workflow_dispatch` in their `on:` block. Add it to make one startable, with any inputs it should ask for:

```
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      channel:
        type: choice
        options: [beta, stable]
```

The run routes like any other: each job follows its `runs-on` line, to your machines or to GitHub-hosted when none can take it, and jobs that use secrets still run only on Trusted machines. Re-run on a failed job works the same way.

Source: https://buildhound.sh/docs/workflows. Last updated 18 October 2026.
