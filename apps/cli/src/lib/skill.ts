/** The skill `buildhound setup` (alias `setup agent`) installs for Claude Code, Cursor and Codex. Adapted from AGENT_FIRST.md "Skill". */
export const SKILL_MD = `---
name: buildhound
description: Audit GitHub Actions spend, fix wasteful workflows by pull request, and route jobs to a machine the user already owns. Use when the user asks about CI cost, slow or expensive workflows, self-hosted runners, or a spare Mac or Linux box.
---

# Buildhound

Every command prints one JSON object when stdout is not a TTY. Errors carry \`code\`, \`message\` and \`next\`: run \`next\`.

## When to run the audit

- The user asks what CI costs, why it is slow, or how to make it cheaper: \`npx buildhound scan . --json\`. Add \`--repo <owner/name>\` for run history.
- Before committing changes under \`.github/workflows\`: \`npx buildhound diff main..HEAD --json\` and include the cost delta in the PR description.
- To see where a job could run: \`npx buildhound route --repo <owner/name> --json\`. It ranks candidates by computed cost and includes "stay".
- To open the routing pull request: \`--apply\`, only when the user asks. It never commits to the default branch.

## needs_human

\`{ "status": "needs_human", "reason", "url", "next" }\` with exit 0 means GitHub or payment needs a person: installing the GitHub App, holding admin rights on the organisation, or paying. Give the user the URL and the reason, wait for them to say it is done, then run \`next\`. Do not retry in a loop.

## Connecting a machine

Only when the user named a machine and asked to connect it. On that machine:

\`\`\`
npx buildhound runner add --org <login> --label macos|linux --yes --json
buildhound runner status --org <login> --json
\`\`\`

\`runner add\` is idempotent: rerunning it on a configured machine returns the existing state. It writes ~/.buildhound/agent.json and a launchd or systemd user service. \`runner remove --machine <name> --org <login> --yes\` keeps the registration for 48 hours.

\`runner status\` can report \`needs_plan\`: the account has no subscription or trial, so its private repositories route to GitHub-hosted while public ones keep running on the machines. No job is blocked. Private repositories need Personal on a personal account or Team on an organisation, never per minute; \`buildhound billing checkout --plan personal|team --json\` returns the checkout URL as \`needs_human\` for the user.

## Failover

\`buildhound failover --org <login> --json\` shows the state per label. The wording is exact: new jobs route to the healthy side. Already-queued jobs are not rescued. Override with \`--set auto|forced_machine|forced_hosted --yes\` only when the user asks.

## Never

- Connect a machine the user did not ask to connect.
- Route a public repository's fork pull requests to a machine. The routing expression keeps them on GitHub-hosted; do not edit it out.
- Commit to the default branch; fixes and routing changes are pull requests.
- Claim a dollar saving for a public repository; it routes for speed only.
- Paste tokens into chat, files or the PR body.
`;
