# @buildhound/mcp

The Buildhound MCP server: the operations of the `buildhound` CLI as tools for your coding agent. Get a free CI report on your GitHub Actions workflows, connect the Macs and Linux machines you own as single-use runners, and see where every job ran.

## Add it

`npx buildhound setup` adds it to Claude Code, Codex and Cursor for you. To add it by hand, register a stdio server:

```json
{ "command": "npx", "args": ["-y", "@buildhound/mcp"] }
```

## Tools

- The CI report, free and without an account: `scan_repo`, `scan_fix`, `estimate_workflow_cost`, `list_rules`, `explain_rule`, `get_rates`.
- Your machines and routing: `runner_status`, `runner_add`, `runner_set`, `runner_remove`, `doctor`, `image_build`, `cache_list`, `cache_clear`, `cache_reset`, `failover_state`, `route_jobs`, `route_apply`.
- Your account: `overview_get`, `jobs_list`, `job_get`, `savings_get`, `repos_list`, `plan_get`, `billing_checkout`, `billing_period`, `audit_log_list` (alias `audit_list`), `settings_get`, `settings_set`.

Every tool returns JSON. Tools are read-only unless their name says otherwise, and anything destructive needs `confirm: true`. When GitHub or a payment needs a person, the answer is `needs_human` with one link.

## Signing in

Account tools use a GitHub token: `GITHUB_TOKEN`, then `gh auth token`. What you see follows your role on GitHub.

## Links

- Website: https://buildhound.sh
- Docs: https://buildhound.sh/docs/mcp

MIT licensed.
