/** The skill `buildhound setup` (alias `setup agent`) installs for Claude Code, Cursor and Codex. Adapted from AGENT_FIRST.md "Skill". */
export const SKILL_MD = `---
name: buildhound
description: Scan GitHub Actions workflows for a free CI report on spend, fix wasteful workflows by pull request, and route jobs to a machine the user already owns. Use when the user asks about CI cost, slow or expensive workflows, self-hosted runners, or a spare Mac or Linux box.
---

# Buildhound

Every command prints one JSON object when stdout is not a TTY. Errors carry \`code\`, \`message\` and \`next\`: run \`next\`. On success, \`next\` is the recommended next step too: run it, unless a rule below says to ask the user first.

## When to scan

- The user asks what CI costs, why it is slow, or how to make it cheaper: \`npx buildhound scan . --json\`. Add \`--repo <owner/name>\` for run history.
- To open the report's fixes as pull requests, only when the user asks: \`npx buildhound scan --fix --json\` returns the plan (each pull request's branch, files and body) and writes nothing. Show it to the user; once they agree, run its \`next\`, which adds \`--yes\`. One pull request per rule; \`--rule R03\` picks rules and \`--one-pr\` puts every fix in one. Running it again updates the same pull requests. Tell the user about each fix's "Assumption" section before they merge.
- Before committing changes under \`.github/workflows\`: \`npx buildhound estimate <workflow-file> --json\` for each changed workflow and include the monthly cost in the PR description.
- To see where a job could run: \`npx buildhound route --repo <owner/name> --json\`. It ranks candidates by computed cost and includes "stay". \`upgrades\` lists routed jobs on a public repository whose expression lets a job a stranger starts reach the machine.
- To route a repository to the user's machines, only when they ask: \`npx buildhound route --apply --repo <owner/name> --json\` returns the plan (the jobs it routes, \`not_routed\` with reasons, the body) and writes nothing. Show it; once they agree, run its \`next\` (adds \`--yes\`) to open one pull request from \`buildhound/route\`; running it again updates it. A job that can reach secrets gets the trusted variable (\`BUILDHOUND_MACOS_TRUSTED\`), which only machines a person marked Trusted serve; it runs on GitHub-hosted until one is connected. Point the user to its Assumption section before they merge.

## needs_human

\`{ "status": "needs_human", "reason", "url", "next" }\` with exit 0 means GitHub, payment or this machine needs a person: installing the GitHub App, holding admin rights on the organisation, paying, or a password. Give the user the URL and the reason, wait for them to say it is done, then run \`next\`. Do not retry in a loop.

\`reason: "password_needed"\` (from \`image build\`) also carries \`command\` and \`why\`: give the user \`why\` and the \`command\` (a \`sudo\` line) to run in a terminal on this Mac, not the URL. Never run it yourself. The build then continues on its own; follow it with \`npx buildhound image build --json\`.


## Connecting a machine

Only when the user named a machine and asked to connect it. On that machine, a Mac:

\`\`\`
npx buildhound runner add --org <login> --yes --json
buildhound runner status --org <login> --json
\`\`\`

Without \`--label\` a Mac takes both macOS and Linux jobs; \`--label macos\` or \`--label linux\` limits it to one. A Linux host with KVM runs Linux jobs in Firecracker microVMs; one without KVM but with Sysbox installed runs them in Sysbox system containers, reported as \`isolation: "container"\` with a warning, and never gets jobs that use secrets. \`runner add --org <login> --check\` (MCP \`runner_add\` with \`check: true\`) only reads the machine and says whether it is ready (KVM, cores, memory, disk, systemd, root). Connecting a Linux host needs root once, for the system service, the job VMs' network and KVM: without it \`runner add\` answers \`needs_human\` with \`reason: "root_needed"\` and the one sudo command, which only a person runs, since it asks for their password. Never pass \`--vm-network nat\`: it turns off the job VMs' network isolation, only a person at the machine can do that, and you get \`needs_human\`.

\`runner add\` is idempotent: rerunning it on a configured machine returns the existing state. It writes ~/.buildhound/agent.json and a launchd or systemd user service. \`runner remove --machine <name> --org <login> --yes\` keeps the registration for 48 hours.

When something looks off (no jobs arrive, the machine feels slow), run \`buildhound doctor --json\`: every check has a status and, when it warns or fails, a \`fix\`. It only reads. Tell the user the fixes; never stop their simulators, containers or VMs yourself.

\`runner status\` can report \`needs_plan\`: the account is on Free, which runs every public repository and one private repository (the first one routed) on up to two machines, so its other private repositories route to GitHub-hosted. No job is blocked. Pro runs every private repository on unlimited machines, on any account, at $10 a machine a month or $96 a year, paid from the first day with no trial, never per minute; the first payment is refundable on request within 30 days. \`needs_plan.url\` is the account's billing page on the dashboard: give the user that URL and wait for them to choose Pro. \`buildhound billing checkout --org <login>\` (add \`--annual\` if they want it) answers \`needs_human\` with Paddle's checkout URL for the same step; never pay or enter card details yourself. \`runner add\` past Free's two machines answers \`needs_human\` with the same page.

## The macOS image

On a Mac, after \`runner add\`, build the macOS image macOS jobs run in (its \`next\` says so; the route step follows as \`then\`): \`npx buildhound image build --yes --json\`. It returns at once and builds in the background, about 30 to 45 minutes with about 27 GB downloaded once, and stops once for the person's password (\`needs_human\`, above). \`npx buildhound image build --json\` follows progress. Linux jobs run meanwhile; macOS jobs stay on GitHub-hosted until the image is ready.

## Failover

\`buildhound failover --org <login> --json\` shows the state per label. The wording is exact: new jobs route to the healthy side. A job stuck in the queue that a connected machine could run now is cancelled and re-run by the control plane once nothing else in its run is running; never say queued jobs are moved when GitHub itself is down. Override with \`--set auto|forced_machine|forced_hosted --yes\` only when the user asks.

## Never

- Connect a machine the user did not ask to connect.
- Route a public repository's fork pull requests, or jobs started by events anyone on GitHub can cause (\`issue_comment\`, \`issues\`, \`discussion\`, \`pull_request_target\`, \`workflow_run\`), to a machine. The public routing expression keeps them on GitHub-hosted; do not shorten it or edit it out.
- Commit to the default branch; fixes and routing changes are pull requests.
- Claim a dollar saving for a public repository; it routes for speed only.
- Paste tokens into chat, files or the PR body.
`;
