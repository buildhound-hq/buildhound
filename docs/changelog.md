# Changelog

> What shipped, newest first. Releases reach npm and dl.buildhound.sh; this page says what they changed.

What shipped in Buildhound, newest first: CLI and MCP releases, agent releases, and changes to the dashboard and the site.

## 17 October 2026: CLI 0.1.8 and MCP 0.1.7

CLI 0.1.5 to 0.1.7 and MCP 0.1.5 and 0.1.6 reached npm without a working build, so `npx buildhound` could answer "command not found". Those versions are deprecated on npm. `npx buildhound` and `npx -y @buildhound/mcp` now get the fixed releases, and everything in the entries below works in them.

## 17 October 2026: six more comparisons

[Compare](https://buildhound.sh/compare) and [Alternatives](https://buildhound.sh/alternatives) now cover Bitrise Build Hub, AWS CodeBuild, Codemagic, CircleCI, Buildkite and Actions Runner Controller, each at the vendor's own list price with the day we checked it. Bitrise's monthly tiers join the pricing chart.

## 17 October 2026: Linux hosts

CLI 0.1.8, MCP 0.1.7 and agent 0.1.33. A Debian or Ubuntu machine with KVM connects with `npx buildhound runner add` and runs Linux jobs, each in its own Firecracker microVM with an isolated network, wiped after. Root is needed once, and the command says how. Host images are out for arm64 and x86-64, and `route` moves jobs on arm64 runners to `BUILDHOUND_LINUX_ARM64`. See [Machines](https://buildhound.sh/docs/machines#linux).

## 17 October 2026: alternatives to every option, priced

[Alternatives](https://buildhound.sh/alternatives) has a page for each way to run GitHub Actions: every other option at its vendor's list price, the day we checked it, cheapest first, with staying where you are on the list. Each comparison page links to its own.

## 17 October 2026: the code on your machine is public

The CLI, the MCP server, the rules and cost model behind the CI report, and these docs now live in a public repository, [buildhound-hq/buildhound](https://github.com/buildhound-hq/buildhound), under the MIT licence, with the history of each part. It mirrors our monorepo on every change; issues are welcome there.

## 17 October 2026: the routing pull request from one command

CLI 0.1.5 and MCP 0.1.4. `npx buildhound route --apply --repo owner/name` shows the pull request it would open and, once you agree, opens one from the branch `buildhound/route`: every job a connected machine can run moves to the routing expression, with GitHub-hosted as the fallback, and jobs that use secrets wait for a Trusted machine. The body carries the measured speed-up, the monthly saving with its calculation, and how to stay. The MCP tool `route_apply` is the same operation, and the setup prompt uses it.

## 16 October 2026: check a machine first, switch billing period

CLI 0.1.4 and MCP 0.1.3. `npx buildhound runner add --org owner --check` reads a machine and says what to fix before anything is written. `buildhound billing period`, and the dashboard's Plan card, switch a subscription between annual and monthly at its next renewal, charging nothing now. The dashboard also gained one banner for a failed payment or a plan that is ending, and its pages fold into phone layouts.

## 16 October 2026: package caches for Linux jobs

Agent 0.1.29 keeps a package cache per repository for Linux jobs on a Mac: npm, pnpm, Yarn, Bun, Corepack, pip, Go and Playwright. Measured on our Mac mini, a warm `pnpm install` took 3.1 s against 5.4 s without the cache. Each repository has its own cache, and credential files are removed after every job. Details on [Machines](https://buildhound.sh/docs/machines#caches).

## 16 October 2026: the macOS image builds inside the product, fixes as pull requests

CLI 0.1.3 and MCP 0.1.2. `npx buildhound image build` builds the macOS image on a Mac in the background, with one password step, and macOS jobs switch over when it is ready ([The macOS image](https://buildhound.sh/docs/macos-image)). `npx buildhound scan --fix` opens the CI report's fixes as pull requests, one per rule, after you agree.

## 16 October 2026: comparisons with dated prices

[Compare](https://buildhound.sh/compare) sets Buildhound beside GitHub-hosted and twelve runner vendors, with each vendor's list price, the day it was checked, what a month of CI costs at three volumes, and the stay option. The same pages are served as markdown for assistants.

## 15 October 2026: the docs

These pages: set up with your coding agent or by hand, workflows, machines, failover, the CLI and MCP references, security, plans and billing. Every page has a markdown twin at the same address with `.md`, listed in [llms.txt](https://buildhound.sh/llms.txt).

Source: https://buildhound.sh/docs/changelog. Last updated 17 October 2026.
