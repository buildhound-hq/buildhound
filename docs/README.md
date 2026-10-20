# Introduction

> GitHub Actions on hardware you own, a clean VM per job, and your agent does the setup. Start here.

How Buildhound turns the Macs and Linux machines you own into clean, single-use GitHub Actions runners, set up by your coding agent.

## What Buildhound does

Buildhound turns the Macs and Linux machines you already own into clean, single-use GitHub Actions runners. Every job runs in a fresh virtual machine that is destroyed afterwards. When none of your machines can take a job, new jobs route to the healthy side, GitHub-hosted, and come back when a machine returns.

Your coding agent sets it up: one prompt into Claude Code, Codex or Cursor connects the machine, installs the GitHub App through you, and opens a pull request that changes one line in each workflow.

## How it works

1. **A machine connects.** `npx buildhound runner add` registers the machine with the control plane and starts the Buildhound agent, which takes jobs for the shared label, `buildhound-macos` or `buildhound-linux`.
2. **One line in each workflow.** `runs-on` reads a repository variable with a hosted default, so the same workflow runs on your machine when one is there and on GitHub-hosted when none is.
3. **A fresh VM per job.** The Buildhound agent boots a virtual machine from an image whose every part is checked against its published checksum, hands it the job, and destroys it when the job ends. Nothing carries over between jobs.
4. **Routing follows your machines.** The control plane keeps the variable on your label while a machine can take jobs and clears it when none can, so new jobs route to the healthy side within about two minutes of a machine going quiet.

## What you need

- A Mac with Apple silicon, or a Linux machine with KVM, that stays on. A Mac runs both macOS and Linux jobs; a Linux host runs Linux jobs.
- A GitHub account or organisation. Installing the GitHub App takes one click in the browser, which your coding agent hands to you.
- Node, for `npx buildhound`. The CLI, the skill and the MCP server install with one command:npx buildhound setup

## Plans in one line

Free runs every public repository and one private repository on up to two machines, on any account. Pro runs every private repository on as many machines as you connect, at $10 a machine a month, or $8 billed annually. Every feature is on both today, and it is never per minute. Organisations that join at launch keep $10 a machine a month for 12 months. See [plans and billing](https://buildhound.sh/docs/plans).

Source: https://buildhound.sh/docs. Last updated 19 October 2026.
