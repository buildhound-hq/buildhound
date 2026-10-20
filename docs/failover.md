# Failover

> New jobs route to the healthy side. Here is exactly what that means.

What happens when a machine stops responding, when every machine is offline or busy, and when a job waits too long.

## The rule

New jobs route to the healthy side. While a machine can take jobs for a label, the routing variable names that label. When none can, the control plane clears the variable, within a minute for a machine you pause or unplug and within about two minutes for one that stops responding, and new jobs run on GitHub-hosted. When a machine returns, the variable comes back and jobs come home. A job already queued for a label cannot be re-targeted by GitHub; see below for what the control plane does about it.

## Situation by situation

| Situation | What happens |
| --- | --- |
| The primary goes offline, a backup is online | Queued and new jobs go to the backup. |
| Every machine is offline | New jobs route to GitHub-hosted within about two minutes. |
| A machine dies during a job | After 3 minutes without a heartbeat the control plane cancels the run and re-runs the job on another machine or GitHub-hosted; GitHub can take a few more minutes to finish the cancel. |
| A job sits queued although a machine has room | After 3 minutes the control plane cancels its run and re-runs the job, once nothing else in the run is running. |
| GitHub-hosted runners are degraded, yours are fine | Nothing changes; your jobs already run on your machines. |
| GitHub's control plane is down | No runner anywhere receives jobs. Buildhound resumes on its own. |

## Turn the fallback off

Falling back to GitHub-hosted is your choice. Off, jobs wait for one of your machines and never run on GitHub-hosted; a queued job waits up to GitHub's 24-hour limit.

```
npx buildhound failover --org <owner> --fallback off --yes
```

Add `--label buildhound-linux` to change one label only. Without flags the command shows routing per label.

Source: https://buildhound.sh/docs/failover. Last updated 15 October 2026.
