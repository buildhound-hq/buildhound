# Questions

> The questions teams ask before they connect a Mac, each answered in its first line.

Running GitHub Actions on your own Mac, the macOS queue, what hosted minutes cost, the cheapest macOS runners, faster iOS builds, Linux jobs, the alternatives, public repositories, laptops and hosted vendors, answered.

## How do I run GitHub Actions on my own Mac?

Connect the Mac as a runner, then point each job at it. With Buildhound that is one prompt in Claude Code, Codex or Cursor, or two steps by hand. On the Mac:

```
npx buildhound runner add --org <owner> --yes
```

Then, in each workflow, replace the hosted label with the routing line. This is the form for a private repository; a public one uses the longer line in [Workflows](https://buildhound.sh/docs/workflows), which keeps strangers' jobs on GitHub-hosted.

```
runs-on: ${{ vars.BUILDHOUND_MACOS || 'macos-latest' }}
```

Every job then runs in a fresh virtual machine on the Mac, destroyed when it ends, and falls back to GitHub-hosted whenever the Mac cannot take it. Linux jobs run within minutes; macOS jobs start once the Mac has built its [macOS image](https://buildhound.sh/docs/macos-image) with `npx buildhound image build`, which took 29 to 46 minutes in our runs and asks for your password once. The steps in full: [Set up by hand](https://buildhound.sh/docs/setup-by-hand).

## Why do my macOS jobs wait in the GitHub Actions queue?

Because GitHub runs at most five hosted macOS jobs at a time on its Free, Pro and Team plans, shared with larger runners ([GitHub's Actions limits](https://docs.github.com/en/actions/reference/limits)). When your agents open more pull requests than that, the rest wait before they start. One team reported a 25m 56s wait for a hosted macOS runner against 12s on its own Mac mini for the same commit ([SlyWombat/MegaPDF #614](https://github.com/SlyWombat/MegaPDF/issues/614)).

A Mac you own adds slots beside those five. Buildhound sends jobs to your Macs first and keeps GitHub-hosted as the fallback, so new jobs route to the healthy side when every Mac is busy or offline.

## How much do GitHub-hosted macOS runners cost?

$0.062 a minute for GitHub's standard macOS runner and $0.006 for Linux, each job rounded up to the whole minute ([GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), checked 15 October 2026). At 5,000 macOS minutes a month that is $310. Public repositories run free on GitHub's standard runners.

Buildhound charges per machine instead, never per minute: free for public repositories and one private one, and $10 a machine a month on Pro for the rest, on any account, less paid annually. See [Pricing](https://buildhound.sh/pricing).

## What is the cheapest way to run macOS jobs on GitHub Actions?

A Mac you already have. As a Buildhound runner it costs $10 a machine a month on Pro, on any account, whatever the minutes, and nothing for public repositories and one private one. At 5,000 macOS minutes a month GitHub-hosted costs $310 at list price.

Without a Mac to spare, the cheapest listed options at 5,000 minutes are Xcode Cloud at $49.99, MacRun at $139 and Manzanita at $149, each from the vendor's own page. Xcode Cloud is Apple's own CI rather than GitHub Actions. Every option, ranked and dated: [Alternatives to GitHub-hosted runners](https://buildhound.sh/alternatives/github-hosted).

## How do I make iOS builds faster on GitHub Actions?

Give them more cores than GitHub's standard macOS runner, and keep them out of its queue. A native iOS build took 7m 11s in a fresh 8-core VM on an M4 Pro MacBook Pro against 23m 18s on GitHub's standard 3-core macOS runner, 3.2x faster, measured on 8 October 2026 with Expo prebuild, CocoaPods and xcodebuild for the simulator, on Xcode 27.0 on both sides.

GitHub also runs at most five hosted macOS jobs at a time on its Free, Pro and Team plans, so when agents open more pull requests than that, the rest wait before they start. A Mac you own adds slots beside those five. Caching CocoaPods and Swift packages helps on either side; the free CI report flags a dependency install with no cache. Run it with `npx buildhound scan`.

## Can I run Linux GitHub Actions jobs on my own machine?

Yes. A Mac with Apple silicon runs Linux jobs in a fresh VM for each job, and a Debian or Ubuntu machine with KVM runs each in its own Firecracker microVM, wiped after; either way a job reaches the internet and nothing on your network. Linux hosts are new; what has been tested on each architecture is in [Machines](https://buildhound.sh/docs/machines#linux).

## What are the alternatives to GitHub-hosted runners?

Four kinds. Hosted runner vendors such as Blacksmith, Depot, WarpBuild, Namespace, Ubicloud, StarSling, Vercel Daemons and Bitrise Build Hub run jobs on their own machines, most by the minute. Services such as RunsOn, Cirun and AWS CodeBuild run them in your own cloud account for a licence or a fee. Xcode Cloud, Manzanita and MacRun cover macOS only. And runners on machines you already have: Buildhound, ushr, Actions Runner Controller and GitHub’s own self-hosted runner. Each one is priced and dated, with staying on GitHub-hosted on the list, in [Alternatives to GitHub-hosted runners](https://buildhound.sh/alternatives/github-hosted).

## Is a self-hosted runner safe for a public repository?

Not a plain one. GitHub advises against self-hosted runners on public repositories, because a pull request from a fork can run its code on your machine.

Buildhound keeps those jobs on GitHub-hosted. On a public repository the routing line sends a job to your machine only for `push`, `schedule`, `workflow_dispatch`, `merge_group`, `release` and pull requests from the repository's own branches, and the control plane refuses anything else as a second line. Every job also runs in a fresh VM that reaches the internet and nothing on your network. See [Security](https://buildhound.sh/docs/security).

## Can I use a MacBook as a CI runner?

Yes. By default a laptop takes jobs only while it is plugged in and not in use, runs one job at a time and gives jobs at most 40% of its memory, so it never slows you down; for a team, an always-on machine such as a spare Mac mini is the steadiest base. When the laptop closes or leaves, new jobs route to the healthy side. See [Machines](https://buildhound.sh/docs/machines).

## How is Buildhound different from Blacksmith, Depot or WarpBuild?

Those vendors run your jobs on their machines and bill by the minute, macOS from $0.000 a minute at list price. Buildhound runs them on Macs you already own and bills per machine. If you have no Mac to spare, or need many macOS jobs at once without buying hardware, a hosted vendor is the simpler choice. Every vendor's list price, ranked: [Pricing](https://buildhound.sh/pricing#vendors).

## Does Buildhound replace GitHub-hosted runners?

No. Your machines run beside GitHub's: jobs go to your machines first, new jobs route to the healthy side when no machine can take them, and a job that waits too long for a busy machine is re-run on GitHub-hosted, so a machine never holds a pull request up. Windows jobs stay on GitHub-hosted.

Source: https://buildhound.sh/docs/questions. Last updated 19 October 2026.
