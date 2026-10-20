# Machines

> Which machine takes which job, and when a laptop stays out of the way.

Routing roles, pause, performance and policy for each connected machine, from the CLI or the menu bar.

## Primary and Backup

Each machine has a routing role, Primary, Backup or Off, which decides the order your machines take new jobs in. The dashboard, the CLI and the menu bar use the same three words.

| Role | Takes jobs |
| --- | --- |
| Primary | Takes new jobs first; several primaries share them. |
| Backup | Only when no primary can take a job: all busy, offline, paused or holding back. |
| Off | Takes no jobs, stays connected, so it still shows in status. |

With two machines, a common setup is a desktop Mac as Primary and a laptop as Backup: the laptop only runs CI when the desktop is busy or away. Set it on the machine's panel on Fleet, or from a terminal:

```
npx buildhound runner set --machine <id|name> --org <owner> --routing backup
```

## Pause, policy and performance

Since agent 0.1.26 a new laptop takes jobs only when plugged in and only when not in use, since a job pins the cores for minutes and a lid that closes mid-job strands it. It also takes no new job under memory pressure, when memory is short for the next VM, while swap grows, when it runs hot or in Low Power Mode, and starts again two minutes after that clears. Running jobs always finish. A laptop's job VMs use at most 40% of its memory, so a 16 GB laptop takes Linux jobs only. Turn either default off when you want to. Any machine can be paused.

```
npx buildhound runner set --machine <id|name> --org <login> --plugged-in-only off
npx buildhound runner set --machine <id|name> --org <login> --idle-only on
npx buildhound runner set --machine <id|name> --org <login> --performance quiet
npx buildhound runner set --machine <id|name> --org <login> --pause
```

Performance is `quiet`, `balanced` or `max`. A machine outside its policy reports no free slots, so GitHub hands its jobs to the others.

## Capacity

By default a machine runs one macOS job at a time and up to four 8 GB Linux jobs as its memory allows; laptops run one job at a time. Pin it with `--capacity`, or size every guest with `--vm-cpus` and `--vm-memory-mib` when connecting.

## Package caches

Linux jobs keep a package cache for each repository on the machine, so what one job downloaded is there for the next job of the same repository: npm, pnpm, Yarn, Bun, Corepack, pip, Go modules and build cache, and Playwright's browsers. There is nothing to set up; the Buildhound agent points each tool at it. Other build output, such as Rust's, still starts from scratch, and macOS jobs do not have package caches yet.

Measured on our Mac mini, this repository's `pnpm install` took 5.4 s with no cache and 3.1 s warm, with all 461 packages reused, and a Next.js app's `npm ci` took 19.1 s and 15.0 s. npm gains less on a fast connection; the cache helps most on a slower one, and when several jobs would download the same packages at once.

Each repository has its own cache, never shared with another, and credential files a job leaves in it, such as `.npmrc`, are removed after every job. A repository's cache is capped at 10 GiB, and the machine always keeps at least 20 GiB of its disk free, removing the least recently used caches first.

## Linux machines

Linux hosts run Linux jobs too. On a Debian or Ubuntu machine with KVM, every job runs in its own Firecracker microVM with an isolated network, and is wiped after: it reaches the internet and nothing on your network, like a job VM on a Mac. An x86-64 host takes `buildhound-linux` and `buildhound-linux-x64` jobs, an arm64 host `buildhound-linux` and `buildhound-linux-arm64`.

Linux hosts are new. A real job has run end to end on an arm64 host; x86-64 hosts are built and pass their automated checks, and have not yet run a job on physical hardware.

Check the host first. This reads the machine and registers nothing: x86-64 or arm64, KVM, cores, memory, free disk, cgroups, systemd, the kernel, and the `ip` and `nft` tools, each with a fix when it fails.

```
npx buildhound runner add --org <owner> --check
```

Then connect it. The same command without `--check` registers the machine and installs the Buildhound agent as a system service under `/var/lib/buildhound`, which fetches the Linux image and Firecracker and updates itself. Root is needed once, for the service, the job VMs' network and KVM: run it as root, or run it as yourself and it prints the one command to run with `sudo`, with your GitHub token carried in the environment. Logs are in the journal: `journalctl -u buildhound-agent`.

```
npx buildhound runner add --org <owner> --yes
```

## Remove a machine

```
npx buildhound runner remove --machine <id|name> --org <owner> --yes
```

The registration is kept for 48 hours, so a machine that comes back keeps its name. Run on the machine itself, it also stops the agent.

Source: https://buildhound.sh/docs/machines. Last updated 19 October 2026.
