/** The skill `buildhound setup` (alias `setup agent`) installs for Claude Code, Cursor and Codex. Adapted from AGENT_FIRST.md "Skill". */
export const SKILL_MD = `---
name: buildhound
description: Scan GitHub Actions workflows for a free CI report on spend, fix wasteful workflows by pull request, and route jobs to a machine the user already owns. Use when the user asks about CI cost, slow or expensive workflows, self-hosted runners, or a spare Mac or Linux box.
---

# Buildhound

Every command prints one JSON object when stdout is not a TTY. Errors carry \`code\`, \`message\` and \`next\`: run \`next\`.

## When to scan

- The user asks what CI costs, why it is slow, or how to make it cheaper: \`npx buildhound scan . --json\`. Add \`--repo <owner/name>\` for run history.
- Before committing changes under \`.github/workflows\`: \`npx buildhound diff main..HEAD --json\` and include the cost delta in the PR description.
- To see where a job could run: \`npx buildhound route --repo <owner/name> --json\`. It ranks candidates by computed cost and includes "stay". Write a job's \`runs_on\` exactly as given. \`upgrades\` lists routed jobs on a public repository whose expression lets a job a stranger starts reach the machine, with the diff that fixes it; propose it as a pull request.
- To open the routing pull request: \`--apply\`, only when the user asks. It never commits to the default branch.

## needs_human

\`{ "status": "needs_human", "reason", "url", "next" }\` with exit 0 means GitHub or payment needs a person: installing the GitHub App, holding admin rights on the organisation, or paying. Give the user the URL and the reason, wait for them to say it is done, then run \`next\`. Do not retry in a loop.

## Connecting a machine

Only when the user named a machine and asked to connect it. On that machine, a Mac:

\`\`\`
npx buildhound runner add --org <login> --yes --json
buildhound runner status --org <login> --json
\`\`\`

Without \`--label\` a Mac takes both macOS and Linux jobs; \`--label macos\` or \`--label linux\` limits it to one. Linux hosts are not supported yet: \`runner add\` there fails \`NOT_SUPPORTED\`, so tell the user and connect a Mac instead. Never pass \`--vm-network nat\`: it turns off the job VMs' network isolation, only a person at the machine can do that, and you get \`needs_human\`.

\`runner add\` is idempotent: rerunning it on a configured machine returns the existing state. It writes ~/.buildhound/agent.json and a launchd or systemd user service. \`runner remove --machine <name> --org <login> --yes\` keeps the registration for 48 hours.

When something looks off (no jobs arrive, the machine feels slow), run \`buildhound doctor --json\`: every check has a status and, when it warns or fails, a \`fix\`. It only reads. Tell the user the fixes; never stop their simulators, containers or VMs yourself.

\`runner status\` can report \`needs_plan\`: the account has no subscription, so its private repositories route to GitHub-hosted while public ones keep running on the machines. No job is blocked. Private repositories need Personal on a personal account or Team on an organisation, paid from the first day with no trial, never per minute (the first payment is refundable on request within 30 days); \`buildhound billing checkout --plan personal|team --json\` returns the checkout URL as \`needs_human\` for the user.

## Failover

\`buildhound failover --org <login> --json\` shows the state per label. The wording is exact: new jobs route to the healthy side. A job stuck in the queue that a connected machine could run now is cancelled and re-run by the control plane once nothing else in its run is running; never say queued jobs are moved when GitHub itself is down. Override with \`--set auto|forced_machine|forced_hosted --yes\` only when the user asks.

## Never

- Connect a machine the user did not ask to connect.
- Route a public repository's fork pull requests, or jobs started by events anyone on GitHub can cause (\`issue_comment\`, \`issues\`, \`discussion\`, \`pull_request_target\`, \`workflow_run\`), to a machine. The public routing expression keeps them on GitHub-hosted; do not shorten it or edit it out.
- Commit to the default branch; fixes and routing changes are pull requests.
- Claim a dollar saving for a public repository; it routes for speed only.
- Paste tokens into chat, files or the PR body.
`;
