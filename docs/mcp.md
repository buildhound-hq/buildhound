# MCP server

> The same operations as the CLI, as tools for Claude Code, Cursor and Codex.

The tools a coding agent gets after npx buildhound setup, and which ones need a confirm.

## Install

One command installs the skill and the MCP server entry for the coding agents it finds on the machine:

```
npx buildhound setup
```

Claude Code, Cursor and Codex each get both; for Codex, setup adds a `[mcp_servers.buildhound]` table to `~/.codex/config.toml`. Add the server to any other coding agent by hand as a stdio server:

```
npx -y @buildhound/mcp
```

This page covers `@buildhound/mcp` 0.1.7. The server runs on your machine and uses the same GitHub login as the CLI: `GITHUB_TOKEN`, else the token from `gh auth token`.

## Tools

| Tool | What it does |
| --- | --- |
| `scan_repo` | Scan the workflow files under a local path for a CI report on wasted spend: findings with evidence, a monthly estimate and a fix as a diff. |
| `scan_fix` | Open the CI report's fixes as pull requests on GitHub with the user's GitHub login, one per rule or one for every fix with one_pr. Takes { path?, repo?, rules?, one_pr?, dry_run?, resolve?, confirm? }. Without confirm: true it returns the plan and writes nothing; a second call updates the pull requests instead of opening more. |
| `estimate_workflow_cost` | Monthly cost of one workflow from its YAML alone, with a row per job and the assumptions used. |
| `route_jobs` | Where each job should run, ranked by computed monthly cost: stay on GitHub-hosted, a connected machine or a runner vendor, with the calculation. |
| `route_apply` | Open the routing pull request with the user's GitHub login: one pull request from the branch buildhound/route that moves each job a connected machine can run to the routing expression, GitHub-hosted as the fallback, with the measured speed-up, the saving and the stay option in its body. Takes { path?, repo?, days?, dry_run?, confirm? }. Without confirm: true it returns the plan and writes nothing; a second call updates the pull request instead of opening another. |
| `explain_rule` | What a rule such as R03 checks and how its fix works. |
| `list_rules` | Every rule id with its title and severity. |
| `get_rates` | The rate tables the cost model uses, with source and verified date. |
| `doctor` | The same checks as buildhound doctor: this machine, the Buildhound agent, the account and the network, each with a fix. |
| `runner_status` | Machines, heartbeats, running jobs and the failover map for an account; without org it asks the Buildhound agent on this machine. |
| `runner_add` | Connect this machine: register it, write its config, install and start the Buildhound agent. Needs confirm: true. With check: true it only reads the machine and says whether it can run job VMs, with no confirm. |
| `runner_set` | Change a machine's routing, pause, performance, only when not in use, only when plugged in, and the repositories it serves on a personal account. |
| `runner_remove` | Remove a machine (kept 48 hours) and stop the Buildhound agent when it is this machine. Needs confirm: true. |
| `runner_cleanup` | Free up space on a machine: what Buildhound keeps there (the image in use, old images, the image build cache, package caches) and what clearing its leftovers frees. Takes { org, machine, confirm? }. Without confirm it only reads; with confirm: true the machine clears within 30 seconds, never the image in use or your own files. |
| `image_build` | The macOS image for this Mac, built in the background by the Buildhound agent. Takes { check?, rebuild?, confirm? } and returns at once with the current step; call it again to follow the build. check: true only checks the Mac. Starting a build needs confirm: true; following one does not. |
| `cache_list` | What the package caches take on the account's machines, per repository, as each machine's last check-in reported. Takes { org, machine?, repository? }. |
| `cache_clear` | Clear the package caches on the account's machines, for one repository or every one. Takes { org, machine?, repository?, confirm }. Needs confirm: true; each machine clears within 30 seconds. |
| `cache_reset` | Start the caches over on the account's machines: every repository's package caches, the tool cache and anything else in the cache folder. Takes { org, machine?, confirm }. Needs confirm: true; each machine resets within 30 seconds. |
| `failover_state` | Where new jobs go for each label, the mode and why. Changing it is buildhound failover in a terminal. |
| `overview_get` | A month at a glance: jobs on the account's machines, what they would have cost on GitHub-hosted, fallbacks, machines and what needs a person. |
| `jobs_list` | Jobs the account's machines ran, newest first, filtered by repository, machine, label or result, a page at a time. |
| `job_get` | One job's story: when it queued and started, where it ran, re-runs and its cost against GitHub-hosted. |
| `savings_get` | Month by month and per machine, what the jobs on the account's machines would have cost on GitHub-hosted. |
| `repos_list` | Repositories the GitHub App can see, whether each routes to the account's machines, and its jobs in the last 30 days. |
| `plan_get` | The plan, the price per machine billed monthly and annually, the machines connected and, on Free, its one private repository. |
| `billing_checkout` | Paddle's checkout for Pro. Takes { org, billing? }, annual unless billing is monthly, and returns needs_human with the URL where a person pays. Charges nothing by itself. Admins only. |
| `billing_period` | Switch a subscription between annual and monthly at the next renewal. Takes { org, billing, confirm? }. Charges nothing now; without confirm: true it only says what would happen. Admins only. |
| `audit_log_list` | The audit log: every admin change to machines, routing and defaults, who made it and from where. Admins only. |
| `audit_list` | The same as audit_log_list, under its earlier name. |
| `settings_get` | The account's defaults: the performance mode a newly connected machine starts with. |
| `settings_set` | Set that default to quiet, balanced or max. Machines already connected keep their own. Admins only. |

Tools for an account take `org`, the GitHub organisation or user login; `runner_set` and `runner_remove` also accept `owner` in its place. The machine and account tools, `scan_fix`, `image_build`, `billing_checkout` and `billing_period` call the CLI's own code, so a tool and its command take the same inputs, return the same JSON and fail with the same error codes.

## Read-only by default

Tools that only read need no confirm and are marked read-only. `runner_add`, `runner_remove`, `cache_clear`, `cache_reset`, `scan_fix` and `route_apply` take `confirm: true` and are marked destructive, so your coding agent asks first. Without it, `runner_add`, `runner_remove`, `cache_clear` and `cache_reset` return `CONFIRM_REQUIRED` and change nothing, and `scan_fix` and `route_apply` return their plan and write nothing. `runner_cleanup` is marked destructive too: without `confirm: true` it only says what clearing would free. `runner_add` with `check: true` only reads the machine and needs no confirm. `billing_period` without `confirm: true` only says what would happen, and is not marked destructive. `image_build` needs `confirm: true` to start a build and returns `CONFIRM_REQUIRED` without it; following a build or `check: true` needs no confirm, and it is not marked destructive. Reversible changes such as `runner_set` and `settings_set` need no confirm. Every tool that changes something except `billing_checkout` is marked idempotent, so calling it twice changes nothing more; `billing_checkout` needs no confirm, because it charges nothing, and each call opens a new checkout. `scan_fix`, `route_apply`, `billing_checkout` and `billing_period` are also marked open world, since they reach GitHub or the payment provider.

Some steps are not tools. A person marks a machine Trusted by approving it in the dashboard, which `buildhound runner set --machine <id|name> --org <login> --trusted on` links to, and failover changes with `buildhound failover`. When a step needs a person, such as installing the GitHub App, a laptop's owner agreeing to join the Fleet, paying through `billing_checkout` or the password step of `image_build`, a tool returns `needs_human` with one URL and a `next` step, the same contract as the CLI. On Free, routing a second private repository or connecting a third machine returns `needs_human` with reason `needs_plan` and the billing page as the one URL.

Source: https://buildhound.sh/docs/mcp. Last updated 19 October 2026.
