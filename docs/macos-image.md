# The macOS image

> macOS jobs run in an image your Mac builds once. Linux jobs do not wait for it, and macOS jobs stay on GitHub-hosted until it is ready.

Each Mac builds its own macOS image once, from Apple's restore image and its own Xcode, with one password step.

## Why each Mac builds its own

Apple's licence does not allow passing macOS or Xcode around as a ready-made image, so the macOS image cannot be downloaded like the Linux one. Each Mac builds its own, once, from Apple's restore image and the Xcode and simulator runtimes already on it. Linux jobs run on the Mac as soon as it is connected; macOS jobs run on GitHub-hosted until the image is ready, then switch over on their own.

## Build it

```
npx buildhound image build
```

`runner add` offers this right after it connects a Mac, and gives it to your coding agent as `next`. The build runs in the background in the Buildhound agent. It downloads Apple's restore image once (about 27 GB) and took 29 to 46 minutes in our runs. Running the command again follows the build, or continues one that stopped; a restart or an update of the Buildhound agent resumes it too.

| Flag | Does |
| --- | --- |
| `--check` | Only checks this Mac and says what to fix. Changes nothing. |
| `--wait` | Follows the build until it is ready, fails or needs your password. |
| `--rebuild` | Builds a new image even when the one in use already has this Mac's Xcode. |
| `--yes` | Starts the build without asking. Needed without a terminal. |

`npx buildhound runner status --local` on the Mac shows the build's step in one line. Your coding agent can use the MCP tool `image_build`, which starts the build with `confirm: true` and returns at once.

## What it checks first

Apple silicon, a recent enough macOS, Xcode in `/Applications`, an iOS simulator runtime, free disk, and power: a laptop on battery does not start the build. FileVault is noted for the Trusted tier. Each problem comes with one fix, such as `xcodebuild -downloadPlatform iOS`. To check without building:

```
npx buildhound image build --check
```

## The password step

The build stops once and asks you to run one command with `sudo` in a terminal on the Mac. It prints the command, which looks like this:

```
sudo ~/.buildhound/bin/buildhound-agent image prepare --bundle <build folder>
```

It writes a first-boot script, its launch file and the marker that skips macOS's setup screens onto the new image's disk, which has to be owned by root. Nothing else on your Mac changes. The build then continues on its own. Your coding agent cannot run it for you: it gets `needs_human` with the command and hands it to you.

## The nine steps

1. Checks, as above.
2. Apple's restore image, downloaded once, resumed after a cut connection and checked against its SHA-256.
3. macOS installed into the new image.
4. The password step.
5. Each Xcode on the Mac and each ready simulator runtime copied in, licences accepted.
6. The GitHub runner, Node and Go for the tool cache, Homebrew and CocoaPods installed.
7. Each iPhone of the newest iOS booted once, so simulators start warm.
8. The image checked, so a missing Xcode, runtime or iPhone fails the build instead of reaching your jobs.
9. macOS jobs turn on, without restarting anything. The previous image is kept.

## Disk and laptops

The image takes about 22 GB, plus your Xcodes as installed, plus twice the simulator runtimes: 53.7 GB with Xcode 27.0 and the iOS and watchOS 27.0 runtimes. The check asks for that plus 10 GB left free for jobs, and 26.6 GB more for Apple's restore image until it is downloaded.

On a laptop the build waits for power between steps, and a step that is running keeps the Mac from idle sleep and holds off updates to the Buildhound agent.

## When Xcode changes

An image that already has this Mac's Xcode versions is not built again. After you install or update Xcode, run the same command: the rebuild starts from the macOS install kept after the password step, so it needs no download and no password. macOS jobs keep using the current image until the new one is ready.

```
npx buildhound image build
```

Source: https://buildhound.sh/docs/macos-image. Last updated 16 October 2026.
