import path from "node:path";
import { ago, count } from "../style";
import { labelName } from "../../commands/runner-status";
import { compareVersions, gb, INSTALL_APP_URL, parseSize, type Doctor } from "./context";
import type { Check } from "./types";
import { ENCRYPTION_WHY, LUKS_DOCS, readEncryption } from "../trust-step";

// One function per check (docs/CLI_AND_MCP.md, buildhound doctor). Each reads, never changes anything, and says
// in plain words what it found; a warning or failure carries the exact fix. Thresholds are documented there too.

const ok = (id: string, title: string, detail?: string): Check => ({ id, status: "ok", title, ...(detail ? { detail } : {}) });
const warn = (id: string, title: string, fix: string, detail?: string): Check => ({ id, status: "warn", title, fix, ...(detail ? { detail } : {}) });
const fail = (id: string, title: string, fix: string, detail?: string): Check => ({ id, status: "fail", title, fix, ...(detail ? { detail } : {}) });
const skip = (id: string, title: string, fix?: string): Check => ({ id, status: "skip", title, ...(fix ? { fix } : {}) });

/** Free disk below this fails (images cannot update, a job disk can fill up); below WARN it warns. */
export const DISK_FAIL_BYTES = 10 * 2 ** 30;
export const DISK_WARN_BYTES = 30 * 2 ** 30;
/** Containers using this much memory together, or two or more local database stacks, are worth naming. */
export const DOCKER_WARN_BYTES = 2 * 2 ** 30;
/** Swap above a quarter of RAM is the line the Buildhound agent backs off at once it keeps growing (RUNNERS.md). */
export const SWAP_WARN_SHARE = 0.25;
/** Other VMs worth naming: each is a process per running VM. */
const OTHER_VMS: Array<{ name: string; re: RegExp; stop: string }> = [
  { name: "Parallels", re: /prl_vm_app/, stop: "prlctl stop <name>" },
  { name: "UTM", re: /QEMULauncher/, stop: "utmctl stop <name>" },
  { name: "VirtualBox", re: /VBoxHeadless|VirtualBoxVM/, stop: "VBoxManage controlvm <name> acpipowerbutton" },
  { name: "VMware Fusion", re: /vmware-vmx/, stop: "vmrun stop <path to .vmx>" },
  { name: "QEMU", re: /qemu-system/, stop: "stop the qemu-system process" },
];
/** Docker's own VM, by engine: its memory is held whatever the containers use. */
const DOCKER_ENGINES: Array<{ name: string; re: RegExp }> = [
  { name: "OrbStack", re: /OrbStack Helper/ },
  { name: "Docker Desktop", re: /com\.docker\.(virtualization|krun|hyperkit)|Docker Desktop/ },
  { name: "Colima", re: /colima|limactl/ },
];

const LOG_FIX = "See what the Buildhound agent says: tail -n 50 ~/.buildhound/agent.log";

export async function nodeCheck(d: Doctor): Promise<Check> {
  const v = d.sys.nodeVersion;
  const major = Number.parseInt(v, 10);
  if (!(major >= 22)) return fail("node", `Node ${v} is too old: Buildhound needs Node 22 or later`, "Install Node 22 or later from https://nodejs.org, then run npx buildhound doctor again");
  if (!d.sys.which("npx")) return warn("node", `Node ${v}, but npx is not on PATH`, "Reinstall Node from https://nodejs.org so npx comes with it");
  return ok("node", `Node ${v}`);
}

const SOURCE = { flag: "--token", env: "GITHUB_TOKEN", gh: "gh" } as const;

export async function githubCheck(d: Doctor): Promise<Check> {
  const t = await d.token();
  if (!t) return fail("github", "Not signed in to GitHub", "Run gh auth login, or set GITHUB_TOKEN");
  const u = await d.user();
  if (u && "login" in u) return ok("github", `Signed in to GitHub as ${u.login}, from ${SOURCE[t.source]}`);
  if (u && "status" in u && u.status === 401) {
    const fix = t.source === "gh" ? "Run gh auth refresh, or gh auth login" : t.source === "env" ? "Set GITHUB_TOKEN to a valid token, or unset it to use gh auth token" : "Pass a valid --token";
    return fail("github", `The GitHub token from ${SOURCE[t.source]} is not valid`, fix);
  }
  if (u && "status" in u) return warn("github", `GitHub answered HTTP ${u.status} when checking the token`, "Run npx buildhound doctor again in a minute");
  return warn("github", `Could not check the GitHub token: ${u && "error" in u ? u.error : "no answer"}`, "Check that GitHub's API is reachable (the network check below)");
}

export async function apiCheck(d: Doctor): Promise<Check> {
  const url = d.apiUrl();
  const host = new URL(url).host;
  const r = await d.sys.http(`${url}/v1/status`, { timeoutMs: 5000 });
  if (!r.ok) return fail("api", `Cannot reach the Buildhound API at ${host}: ${r.error}`, `Check the network, proxy or firewall for ${url}, or pass --api-url`);
  const status = r.status === 200 ? (r.body as { status?: unknown } | null)?.status : undefined;
  if (status === "operational") return ok("api", `Buildhound API is up (${host})`);
  if (status === "degraded") return warn("api", `Buildhound API is up but reports degraded service (${host})`, "See https://buildhound.sh/status");
  if (status === "outage") return fail("api", `Buildhound API reports an outage (${host})`, "See https://buildhound.sh/status");
  const health = await d.sys.http(`${url}/health`, { timeoutMs: 5000 });
  if (health.ok && health.status === 200) return ok("api", `Buildhound API is up (${host})`);
  return fail("api", `The Buildhound API at ${host} answered HTTP ${health.ok ? health.status : r.status}`, "See https://buildhound.sh/status");
}

type Plan = { plan?: string; effective?: string; checkout_next?: string };
type Repo = { full_name: string; state: string; archived?: boolean; private?: boolean };

function repoList(body: unknown): Repo[] {
  const list = (body as { repositories?: unknown } | null)?.repositories;
  return Array.isArray(list) ? (list as Repo[]).filter((r) => r && typeof r.full_name === "string" && !r.archived) : [];
}

/** Why an account check cannot run, or null when it can. */
async function accountGate(d: Doctor, id: string, what: string): Promise<Check | string> {
  if (!(await d.token())) return skip(id, `${what} not checked: needs GitHub sign-in`);
  const owner = await d.owner();
  if (!owner) return skip(id, `${what} not checked: pass --org <login>`);
  return owner;
}

export async function accountCheck(d: Doctor): Promise<Check> {
  const gate = await accountGate(d, "account", "Account");
  if (typeof gate !== "string") return gate;
  const owner = gate;
  const r = await d.plan(owner);
  if (!r?.ok) return skip("account", "Account not checked: the Buildhound API did not answer");
  if (r.status === 401) return skip("account", "Account not checked: the GitHub token is not valid");
  if (r.status === 404) return fail("account", `The Buildhound GitHub App is not installed on ${owner}`, `Install it at ${INSTALL_APP_URL}, then run npx buildhound doctor again`);
  const err = (r.body as { error?: { message?: unknown; next?: unknown } } | null)?.error;
  if (r.status === 403) return fail("account", typeof err?.message === "string" ? `Cannot read ${owner}: ${err.message}` : `Cannot read ${owner}`, typeof err?.next === "string" ? err.next : `Sign in to GitHub as a member of ${owner}`);
  if (r.status !== 200) return warn("account", `The Buildhound API answered HTTP ${r.status} for ${owner}'s plan`, "Run npx buildhound doctor again in a minute, or see https://buildhound.sh/status");
  const plan = (r.body ?? {}) as Plan;
  const name = plan.effective === "none" ? "Free" : plan.effective === "enterprise" ? "Enterprise" : "Pro";
  const title = `GitHub App installed on ${owner}, ${name} plan`;
  const repos = await d.repos(owner);
  const held = repos?.ok && repos.status === 200 ? repoList(repos.body).filter((x) => x.state === "needs_plan") : [];
  if (held.length) {
    return warn(
      "account",
      `${title}; ${count(held.length, "private repository", "private repositories")} ${held.length === 1 ? "runs" : "run"} on GitHub-hosted until the account has Pro`,
      plan.checkout_next || `buildhound plan --org ${owner}`,
      held.map((x) => x.full_name).join(", "),
    );
  }
  return ok("account", title);
}

export async function routingCheck(d: Doctor): Promise<Check> {
  const gate = await accountGate(d, "routing", "Routing");
  if (typeof gate !== "string") return gate;
  const owner = gate;
  const r = await d.repos(owner);
  if (!r?.ok || r.status !== 200) return skip("routing", `Routing not checked: the Buildhound API ${r?.ok ? `answered HTTP ${r.status}` : "did not answer"}`);
  const repos = repoList(r.body);
  const routed = repos.filter((x) => x.state === "routed");
  if (!routed.length) {
    const first = repos.find((x) => x.state === "not_routed");
    return warn("routing", "No repository routes to your machines yet", `buildhound route --repo ${first?.full_name ?? `${owner}/<name>`}`);
  }
  const names = routed.slice(0, 3).map((x) => x.full_name).join(", ") + (routed.length > 3 ? ` and ${routed.length - 3} more` : "");
  return ok("routing", `${count(routed.length, "repository", "repositories")} ${routed.length === 1 ? "routes" : "route"} to your machines: ${names}`);
}

export async function agentCheck(d: Doctor): Promise<Check> {
  const { config, invalid } = d.config();
  const owner = config?.owner ?? (await d.owner());
  if (invalid) return fail("agent", `The Buildhound agent's settings file is not valid: ${invalid}`, `Remove ${path.join(d.home, "agent.json")}, then run ${d.runnerAdd(owner)}`);
  // A Linux host with KVM connects like a Mac (B12); `--check` says whether this one is ready and names the sudo step.
  if (!config && d.sys.os === "linux") return skip("agent", "Buildhound agent: not set up on this Linux host", `Check this machine with npx buildhound runner add --org ${owner ?? "<login>"} --check, then connect it with the command it names`);
  if (!config) return skip("agent", `Buildhound agent: not set up on ${d.here}`, d.runnerAdd(owner));
  const a = await d.agent();
  if ("error" in a) {
    const title = a.socket ? `The Buildhound agent does not answer: ${a.error}` : "The Buildhound agent is installed but not running";
    return fail("agent", title, `Start it again: ${d.runnerAdd(config.owner)}`);
  }
  const s = a.status;
  const v = typeof s.version === "string" ? s.version : "unknown";
  const min = typeof s.minAgentVersion === "string" ? s.minAgentVersion : "";
  const latest = await d.latestAgent();
  const newest = latest.ok && latest.status === 200 && /^\d+\.\d+\.\d+$/.test(latest.text.trim()) ? latest.text.trim() : null;
  const state = typeof s.state === "string" ? s.state : "unknown";
  const running = typeof s.runningJobs === "number" && s.runningJobs > 0 ? `, running ${count(s.runningJobs, "job")}` : "";
  const detail = [`version ${v}`, min && `minimum ${min}`, newest && `newest ${newest}`, `state ${state}`].filter(Boolean).join(", ");
  if (state === "needs_update" || (min && v !== "unknown" && compareVersions(v, min) < 0)) {
    return warn("agent", `Buildhound agent ${v} is below the minimum ${min || "version"}: it updates itself between jobs`, `If it stays this way: ${LOG_FIX.charAt(0).toLowerCase()}${LOG_FIX.slice(1)}`, detail);
  }
  if (state === "paused") return warn("agent", `Buildhound agent ${v} is paused: it takes no new jobs`, `buildhound runner set --machine ${config.machine_name} --org ${config.owner} --resume`, detail);
  if (state === "offline") return fail("agent", `Buildhound agent ${v} is running but cannot reach the control plane`, `Check the network. ${LOG_FIX}`, detail);
  if (s.awaitingPoolConsent === true) {
    return warn("agent", `Buildhound agent ${v} waits for this laptop's owner to agree to join ${config.owner}'s Fleet`, `The owner runs this at this laptop: ${d.runnerAdd(config.owner)}`, detail);
  }
  const newer = newest && v !== "unknown" && compareVersions(newest, v) > 0 ? `; ${newest} is out and installs when the control plane asks for it` : "";
  if (state === "draining") return ok("agent", `Buildhound agent ${v} is finishing up: running jobs finish, new jobs go elsewhere${newer}`, detail);
  return ok("agent", `Buildhound agent ${v} is ${state}${running}${newer}`, detail);
}

export async function machineCheck(d: Doctor): Promise<Check> {
  const config = d.config().config;
  if (!config) return skip("machine", "Control plane not checked: this machine is not connected");
  if (!(await d.token())) return skip("machine", "Control plane not checked: needs GitHub sign-in");
  const owner = config.owner;
  const r = await d.machines(owner);
  if (!r?.ok) return skip("machine", "Control plane not checked: the Buildhound API did not answer");
  if (r.status === 403) return skip("machine", `Control plane not checked: only admins of ${owner} can see its machines`);
  if (r.status === 404) return fail("machine", `The control plane does not know ${owner}`, d.runnerAdd(owner));
  if (r.status !== 200) return warn("machine", `The Buildhound API answered HTTP ${r.status} for ${owner}'s machines`, "Run npx buildhound doctor again in a minute");
  const m = await d.thisMachine();
  if (!m) return fail("machine", `${config.machine_name} is not registered with ${owner}; it may have been removed`, d.runnerAdd(owner));
  const name = String(m.name ?? config.machine_name);
  const hb = typeof m.last_heartbeat_at === "string" ? Date.parse(m.last_heartbeat_at) : NaN;
  const age = Number.isFinite(hb) ? Math.max(0, (d.sys.now() - hb) / 1000) : null;
  const labels = [...new Set((Array.isArray(m.labels) ? m.labels : []).map((l) => labelName(String(l).replace(/-trusted$/, ""))))];
  const trust = m.trust === "trusted" ? "Trusted" : "No secrets";
  const routing = m.routing === "backup" ? "backup" : m.routing === "off" ? "routing off" : "primary";
  const seen = age === null ? "never" : ago(d.sys.now() - age * 1000, d.sys.now());
  const detail = `status ${String(m.status ?? "unknown")}, labels ${labels.join(", ") || "none"}, trust ${trust}, routing ${String(m.routing ?? "primary")}`;
  if (age === null || age > 600) return fail("machine", `The control plane last heard from ${name} ${seen}`, `Check that the Buildhound agent is online (above). ${LOG_FIX}`, detail);
  if (age > 90) return warn("machine", `The control plane last heard from ${name} ${seen}`, `Check that the Buildhound agent is online (above). ${LOG_FIX}`, detail);
  if (m.routing === "off") return warn("machine", `${name} is connected, but its routing is off: it takes no jobs`, `buildhound runner set --machine ${name} --org ${owner} --routing primary`, detail);
  return ok("machine", `${name} checked in ${seen}: ${labels.length ? labels.join(" and ") : "no labels"}, ${trust}, ${routing}`, detail);
}

/**
 * On a personal account each machine serves chosen repositories, one scale set each (RUNNERS.md, Repositories).
 * A repository the Buildhound GitHub App covers that this machine does not serve gets no machine: its jobs run on
 * GitHub-hosted, or wait if their workflow names the label. A warning, since serving a subset can be intended.
 */
export async function repositoriesCheck(d: Doctor): Promise<Check> {
  const config = d.config().config;
  if (!config) return skip("repositories", "Repositories not checked: this machine is not connected");
  if (!(await d.token())) return skip("repositories", "Repositories not checked: needs GitHub sign-in");
  const owner = config.owner;
  const m = await d.thisMachine();
  if (!m) return skip("repositories", "Repositories not checked: the control plane does not list this machine");
  const name = String(m.name ?? config.machine_name);
  const plan = await d.plan(owner);
  const kind = plan?.ok && plan.status === 200 ? (plan.body as Plan | null)?.plan : undefined;
  const served = Array.isArray(m.repositories) ? m.repositories.filter((r): r is string => typeof r === "string") : [];
  const filter = (m.repository_filter ?? null) as { all?: boolean; repositories?: string[]; pending?: boolean } | null;
  if (kind === "team" || (kind === undefined && !served.length && !filter)) return ok("repositories", `${name} serves every repository the Buildhound app covers on ${owner}`);
  const r = await d.repos(owner);
  if (!r?.ok || r.status !== 200) return skip("repositories", `Repositories not checked: the Buildhound API ${r?.ok ? `answered HTTP ${r.status}` : "did not answer"}`);
  const covered = repoList(r.body).map((x) => x.full_name);
  const serving = new Set(served.map((x) => x.toLowerCase()));
  const missing = covered.filter((x) => !serving.has(x.toLowerCase()));
  const set = filter ? (filter.all ? "set to every repository" : `set to ${(filter.repositories ?? []).join(", ") || "none"}`) : "list not reported (Buildhound agent before 0.1.27)";
  const detail = `serves ${served.join(", ") || "none"}; ${set}${filter?.pending ? "; a change is on its way to the machine" : ""}`;
  if (!missing.length) return ok("repositories", `${name} serves all ${count(covered.length, "repository", "repositories")} the Buildhound app covers`, detail);
  const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? ` and ${missing.length - 3} more` : "");
  const fix = filter?.all
    ? `It serves at most 25 at once; choose them: buildhound runner set --machine ${name} --org ${owner} --repositories <owner/a,owner/b>`
    : `buildhound runner set --machine ${name} --org ${owner} --add-repository ${missing.join(",")}`;
  return warn("repositories", `The Buildhound app covers ${count(covered.length, "repository", "repositories")}; ${name} serves ${served.length} (missing ${shown})`, fix, detail);
}

function manifest(d: Doctor, dir: string): { image_id?: string; xcode?: string } | null {
  const text = d.sys.readText(path.join(dir, "manifest.json"));
  if (!text) return null;
  try {
    return JSON.parse(text) as { image_id?: string; xcode?: string };
  } catch {
    return null;
  }
}

/** The Buildhound agent's macOS image build, as /status carries it (B06.2). */
interface ImageBuildSummary {
  state?: string;
  step_number?: number;
  steps?: number;
  title?: string;
  percent?: number;
  total_seconds_left?: number;
  waiting?: string;
  command?: string;
  error?: string;
}

/** No macOS image yet: what the build is doing, in plain words, and the one command (`buildhound image build`). */
export function macImageBuildCheck(raw: unknown, started: boolean): Check {
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as ImageBuildSummary;
  const where = `step ${b.step_number ?? 1} of ${b.steps ?? 9}`;
  switch (b.state) {
    case "running": {
      const left = typeof b.total_seconds_left === "number" && b.total_seconds_left >= 0 ? `, about ${Math.max(1, Math.round(b.total_seconds_left / 60))} min left` : "";
      return warn("images", `The macOS image is building (${where}: ${b.title ?? ""}, ${b.percent ?? 0}%${left}): macOS jobs run on GitHub-hosted until it is ready`, "Nothing to do: it continues on its own; follow it with: buildhound image build");
    }
    case "waiting":
      return warn("images", `The macOS image build is paused at ${where}: ${b.waiting ?? "waiting"}`, b.waiting ?? "Plug in this Mac");
    case "needs_human":
      return warn("images", "The macOS image build needs your password once, to skip macOS's setup screens", b.command ? `Run this in a terminal on this Mac: ${b.command}` : "buildhound image build");
    case "blocked":
      return warn("images", `The macOS image build cannot start: ${b.error ?? "a check failed"}`, "See what to fix: buildhound image build --check");
    case "failed":
      return warn("images", `The macOS image build stopped at ${where}: ${b.error ?? "it failed"}`, "Run it again, it continues where it stopped: buildhound image build --yes");
  }
  if (started) return warn("images", "The macOS image build did not finish: macOS jobs run on GitHub-hosted until it is ready", "Continue it where it stopped: buildhound image build --yes");
  return warn("images", "No macOS image on this Mac yet: macOS jobs run on GitHub-hosted", "Build it on this Mac: buildhound image build");
}

export async function imagesCheck(d: Doctor): Promise<Check> {
  const config = d.config().config;
  if (!config) return skip("images", "Images not checked: this machine is not connected");
  const labels = config.scale_sets.map((s) => s.label);
  const status = await d.agentState();
  const notReady = Array.isArray(status?.notReady) ? (status.notReady as unknown[]).map(String) : [];
  const parts: Check[] = [];
  const images = path.join(d.home, "images");
  if (labels.some((l) => l.startsWith("buildhound-linux"))) {
    const dir = config.vm?.linux_image_dir ?? path.join(images, `linux-${d.sys.arch === "x64" ? "x64" : "arm64"}`, "current");
    const m = manifest(d, dir);
    if (m) parts.push(ok("images", "Linux image ready", m.image_id));
    else if (notReady.some((l) => l.startsWith("buildhound-linux"))) parts.push(warn("images", "Linux image is downloading: Linux jobs run on GitHub-hosted until it is ready", "Nothing to do: the Buildhound agent finishes the download on its own"));
    else parts.push(warn("images", "No Linux image yet: Linux jobs run on GitHub-hosted", `Start the Buildhound agent so it downloads it: ${d.runnerAdd(config.owner)}`));
  }
  if (d.sys.os === "macos" && labels.some((l) => l.startsWith("buildhound-macos"))) {
    const root = path.join(images, "macos-arm64");
    const m = manifest(d, path.join(root, "current"));
    const helper = (config.vm?.helper as string | undefined) ?? path.join(d.home, "bin", "buildhound-vz");
    if (m && !d.sys.exists(helper)) parts.push(warn("images", "macOS image ready, but the virtualisation helper is missing", `Install it again: ${d.runnerAdd(config.owner)}`));
    else if (m) parts.push(ok("images", `macOS image ready${m.xcode ? ` with Xcode ${m.xcode}` : ""}`, m.image_id));
    else parts.push(macImageBuildCheck(status?.imageBuild, d.sys.listDir(root).some((n) => n.startsWith("build-") || n.startsWith("macos-"))));
  }
  if (!parts.length) return skip("images", "No images needed for the labels this machine serves");
  const worst = parts.find((p) => p.status === "warn") ?? parts[0]!;
  const title = parts.map((p) => p.title).join("; ");
  const detail = parts.map((p) => p.detail).filter(Boolean).join(", ") || undefined;
  return worst.status === "warn" ? warn("images", title, worst.fix!, detail) : ok("images", title, detail);
}

const MINUTE = 60_000;

/** HIDIdleTime from ioreg, in milliseconds; null when unknown. */
async function idleMs(d: Doctor): Promise<number | null> {
  if (d.sys.os !== "macos") return null;
  const out = await d.sys.exec("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r"]);
  const m = out ? /"HIDIdleTime"\s*=\s*(\d+)/.exec(out) : null;
  return m ? Number(m[1]) / 1e6 : null;
}

export async function powerCheck(d: Doctor): Promise<Check> {
  if (!(await d.laptop())) return skip("power", "Power: not a laptop, so no battery settings apply");
  const config = d.config().config;
  const policy = d.policy() ?? {};
  const pluggedOnly = policy.plugged_in_only === true;
  const idleOnly = policy.idle_only === true;
  let onBattery: boolean | null = null;
  let percent = "";
  let lowPower = false;
  if (d.sys.os === "macos") {
    const batt = await d.battery();
    if (batt) {
      onBattery = batt.includes("'Battery Power'");
      percent = /(\d+)%/.exec(batt)?.[1] ?? "";
    }
    const g = await d.sys.exec("pmset", ["-g"]);
    lowPower = Boolean(g && /^\s*(lowpowermode|powermode)\s+1\s*$/m.test(g));
  } else {
    const supplies = d.sys.listDir("/sys/class/power_supply");
    const ac = supplies.find((n) => /^(AC|ADP|ACAD)/.test(n));
    const online = ac ? d.sys.readText(`/sys/class/power_supply/${ac}/online`) : null;
    if (online !== null) onBattery = online.trim() === "0";
  }
  const idle = idleOnly ? await idleMs(d) : null;
  const inUse = idle !== null && idle < 5 * MINUTE;
  const set = (flag: string) => (config ? `buildhound runner set --machine ${config.machine_name} --org ${config.owner} ${flag}` : `buildhound runner set --machine <name> --org <login> ${flag}`);
  const source = onBattery === null ? "Power source unknown" : onBattery ? `On battery${percent ? ` (${percent}%)` : ""}` : `Plugged in${percent ? ` (${percent}%)` : ""}`;
  const rules = [pluggedOnly && "only when plugged in", idleOnly && "only when not in use"].filter(Boolean).join(" and ");
  const detail = `plugged_in_only ${pluggedOnly}, idle_only ${idleOnly}${idle !== null ? `, idle ${Math.round(idle / 1000)} s` : ""}, low power mode ${lowPower}`;
  if (lowPower) return warn("power", `${source}, Low Power Mode is on: the Buildhound agent takes no new jobs until it is off`, "Turn off Low Power Mode in System Settings, Battery", detail);
  if (onBattery && pluggedOnly) return warn("power", `${source}: jobs wait until ${d.here} is plugged in, as set (Only when plugged in)`, `Plug in. To take jobs on battery too: ${set("--plugged-in-only off")}`, detail);
  if (inUse) return warn("power", `${source}, in use: jobs wait until nobody has used ${d.here} for 5 minutes, as set (Only when not in use)`, `Nothing is wrong. To take jobs while you work: ${set("--idle-only off")}`, detail);
  return ok("power", `${source}${rules ? `; takes jobs ${rules}` : ""}`, detail);
}

/** "vm.swapusage: total = 10240.00M  used = 8708.38M  free = ..." as bytes used. */
function swapUsedMac(out: string | null): number | null {
  const m = out ? /used\s*=\s*([\d.]+)([KMG])/.exec(out) : null;
  if (!m) return null;
  return Math.round(Number(m[1]) * 1024 ** (m[2] === "K" ? 1 : m[2] === "M" ? 2 : 3));
}

function meminfo(text: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * 1024;
  }
  return out;
}

export async function memoryCheck(d: Doctor): Promise<Check> {
  const ram = d.sys.memoryBytes;
  const problems: string[] = [];
  const facts: string[] = [];
  const status = await d.agentState();
  const waiting = typeof status?.waiting === "string" ? status.waiting : "";
  const reason = typeof status?.waitingReason === "string" ? status.waitingReason : "";
  if (["memory", "thermal", "low_power"].includes(waiting) && reason) problems.push(reason);
  let swap: number | null = null;
  if (d.sys.os === "macos") {
    const [level, swapOut] = await Promise.all([d.sys.exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]), d.sys.exec("sysctl", ["vm.swapusage"])]);
    const pressure = Number(level);
    if (pressure === 4) problems.push("Memory pressure is critical");
    else if (pressure === 2) problems.push("Memory pressure is high");
    else if (level !== null) facts.push("memory pressure normal");
    swap = swapUsedMac(swapOut);
  } else if (d.sys.os === "linux") {
    const info = meminfo(d.sys.readText("/proc/meminfo"));
    if (info.SwapTotal !== undefined && info.SwapFree !== undefined) swap = info.SwapTotal - info.SwapFree;
    if (info.MemAvailable !== undefined) {
      if (info.MemAvailable < 2 * 2 ** 30) problems.push(`Only ${gb(info.MemAvailable)} of memory available`);
      else facts.push(`${gb(info.MemAvailable)} available`);
    }
  } else return skip("memory", "Memory not checked on this system");
  if (swap !== null) {
    if (swap > ram * SWAP_WARN_SHARE) problems.push(`swap at ${gb(swap)} of ${gb(ram)} RAM`);
    else facts.push(`swap ${gb(swap)}`);
  }
  const detail = [waiting && `waiting ${waiting}`, swap !== null && `swap_bytes ${swap}`, `ram_bytes ${ram}`].filter(Boolean).join(", ");
  if (problems.length) {
    const title = problems.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toLowerCase() + p.slice(1))).join(", ");
    // Only the Buildhound agent's own reason means it is holding jobs (agent 0.1.26, RUNNERS.md, Resource use).
    const effect = reason && problems[0] === reason ? `the Buildhound agent takes no new jobs until ${d.here} has room again` : `${d.here} is short of memory`;
    return warn("memory", `${title}: ${effect}`, "Quit what you are not using; the simulator, Docker and VM checks below name what is heavy", detail);
  }
  return ok("memory", `Memory is fine: ${facts.join(", ") || `${gb(ram)} RAM`}`, detail);
}

export async function diskCheck(d: Doctor): Promise<Check> {
  const where = d.sys.exists(d.home) ? d.home : d.sys.env("HOME") || "/";
  const s = await d.sys.diskFree(where);
  if (!s) return skip("disk", "Free disk space not checked");
  const detail = `free_bytes ${s.free}, total_bytes ${s.total}, path ${where}`;
  const fix = d.sys.os === "macos" ? "Empty the Trash, and remove simulators Xcode no longer uses: xcrun simctl delete unavailable" : "Remove old Docker images and caches: docker image prune";
  if (s.free < DISK_FAIL_BYTES) return fail("disk", `Only ${gb(s.free)} free on the disk: images cannot update and job disks can fill up`, fix, detail);
  if (s.free < DISK_WARN_BYTES) return warn("disk", `${gb(s.free)} free on the disk: under 30 GB, image updates and job disks get tight`, fix, detail);
  return ok("disk", `${gb(s.free)} free on the disk`, detail);
}

export async function simulatorsCheck(d: Doctor): Promise<Check> {
  if (d.sys.os !== "macos") return skip("simulators", "Simulators: not a Mac");
  if (!d.sys.which("xcrun")) return skip("simulators", "Simulators not checked: Xcode's command line tools are not installed");
  const out = await d.sys.exec("xcrun", ["simctl", "list", "devices", "booted", "-j"], 8000);
  if (out === null) return skip("simulators", "Simulators not checked: simctl did not answer");
  let names: string[] = [];
  try {
    const devices = (JSON.parse(out) as { devices?: Record<string, Array<{ name?: string; state?: string }>> }).devices ?? {};
    names = Object.values(devices).flat().filter((x) => x.state === "Booted").map((x) => x.name ?? "simulator");
  } catch {
    return skip("simulators", "Simulators not checked: simctl answered something unexpected");
  }
  if (!names.length) return ok("simulators", "No simulators running");
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return warn("simulators", `${count(names.length, "simulator")} running (${shown}), each holding 1 to 2 GB of memory`, "If you are not using them: xcrun simctl shutdown all", names.join(", "));
}

type Container = { name: string; mem: number; project: string | null; supabase: boolean; db: boolean };

function labelsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(?:^|,)([^=,]+)=([^,]*)/g)) out[m[1]!] = m[2]!;
  return out;
}

export async function dockerCheck(d: Doctor): Promise<Check> {
  if (!d.sys.which("docker")) return skip("docker", "Docker: not installed");
  const [ps, stats, procs] = await Promise.all([
    d.sys.exec("docker", ["ps", "--format", "{{json .}}"], 5000),
    d.sys.exec("docker", ["stats", "--no-stream", "--format", "{{json .}}"], 10_000),
    d.processes(),
  ]);
  const engine = DOCKER_ENGINES.find((e) => procs?.some((p) => e.re.test(p.name)));
  const engineMem = engine ? (procs ?? []).filter((p) => engine.re.test(p.name)).reduce((n, p) => n + p.rss, 0) : 0;
  const label = engine ? `Docker (${engine.name})` : "Docker";
  if (ps === null) return ok("docker", `${label} is not running`);
  const meta = new Map<string, { project: string | null; supabase: boolean; db: boolean }>();
  for (const line of ps.split("\n")) {
    try {
      const c = JSON.parse(line) as { Names?: string; Labels?: string; Image?: string };
      const l = labelsOf(c.Labels ?? "");
      const supabase = Boolean(l["com.supabase.cli.project"]);
      meta.set(c.Names ?? "", { project: l["com.supabase.cli.project"] ?? l["com.docker.compose.project"] ?? null, supabase, db: /postgres|mysql|mariadb|mongo|redis|supabase/i.test(c.Image ?? "") });
    } catch {
      /* a line that is not JSON is skipped */
    }
  }
  const containers: Container[] = [];
  for (const line of (stats ?? "").split("\n")) {
    try {
      const c = JSON.parse(line) as { Name?: string; MemUsage?: string };
      const name = c.Name ?? "";
      const m = meta.get(name) ?? { project: null, supabase: false, db: false };
      containers.push({ name, mem: parseSize((c.MemUsage ?? "").split("/")[0] ?? ""), ...m });
    } catch {
      /* a line that is not JSON is skipped */
    }
  }
  if (!containers.length) {
    const n = meta.size;
    return ok("docker", n ? `${label}: ${count(n, "container")} running` : `${label}: no containers running`, engineMem ? `engine_bytes ${engineMem}` : undefined);
  }
  const groups = new Map<string, { key: string; mem: number; names: string[]; project: string | null; supabase: boolean; db: boolean }>();
  for (const c of containers) {
    const key = c.project ? (c.supabase ? `Supabase stack ${c.project}` : c.project) : c.name;
    const g = groups.get(key) ?? { key, mem: 0, names: [], project: c.project, supabase: c.supabase, db: false };
    g.mem += c.mem;
    g.names.push(c.name);
    g.db ||= c.db;
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.mem - a.mem);
  const total = containers.reduce((n, c) => n + c.mem, 0);
  const dbStacks = sorted.filter((g) => g.db && g.project);
  const top = sorted.slice(0, 3).map((g) => `${g.key} ${gb(g.mem)}`).join(", ");
  const detail = [`containers ${containers.length}`, `container_bytes ${total}`, engineMem && `engine_bytes ${engineMem}`, `top ${sorted.slice(0, 5).map((g) => `${g.key}=${g.mem}`).join(" ")}`].filter(Boolean).join(", ");
  const title = `${label}: ${count(containers.length, "container")} using ${gb(total)}${dbStacks.length > 1 ? `, including ${count(dbStacks.length, "local database stack")}` : ""} (${top})`;
  if (total < DOCKER_WARN_BYTES && dbStacks.length < 2) return ok("docker", title, detail);
  const stops = sorted.slice(0, 3).map((g) => (g.project ? `docker stop $(docker ps -q --filter label=${g.supabase ? "com.supabase.cli.project" : "com.docker.compose.project"}=${g.project})` : `docker stop ${g.names.join(" ")}`));
  return warn("docker", title, `Stop what you are not using, for example: ${stops.join("; ")}`, detail);
}

export async function vmsCheck(d: Doctor): Promise<Check> {
  if (d.sys.os === "other") return skip("vms", "Other VMs not checked on this system");
  const procs = await d.processes();
  if (!procs) return skip("vms", "Other VMs not checked: ps did not answer");
  const found = OTHER_VMS.map((v) => {
    const ps = procs.filter((p) => v.re.test(p.name));
    return { ...v, count: ps.length, mem: ps.reduce((n, p) => n + p.rss, 0) };
  }).filter((v) => v.count > 0);
  if (!found.length) return ok("vms", "No other VMs running");
  const list = found.map((v) => `${v.name} (${count(v.count, "VM")}, ${gb(v.mem)})`).join(", ");
  return warn("vms", `Other VMs running: ${list}`, `Shut down the VMs you are not using: ${found.map((v) => `${v.stop} (${v.name})`).join(", ")}`, found.map((v) => `${v.name}=${v.mem}`).join(" "));
}

/**
 * Full-disk encryption: FileVault on a Mac, LUKS under the root file system on Linux (trust-step.ts). Needed only for
 * jobs that use secrets, so off is fine on a No secrets machine and says why in one line; on a Trusted one it warns.
 */
export async function filevaultCheck(d: Doctor): Promise<Check> {
  const what = d.sys.os === "macos" ? "FileVault" : "Disk encryption";
  const on = d.sys.os === "other" ? null : await readEncryption(d.sys.os, (bin, args) => d.sys.exec(bin, args));
  if (on === null) return skip("filevault", `${what} not checked`);
  if (on) return ok("filevault", `${what} is on: ${d.here} can be Trusted`);
  const m = await d.thisMachine();
  const turnOn = d.sys.os === "macos" ? "sudo fdesetup enable, and save the recovery key it prints somewhere safe" : `A Linux disk is encrypted with LUKS when it is installed: ${LUKS_DOCS}`;
  if (m?.trust === "trusted") return warn("filevault", `${what} is off, but ${d.here} is Trusted: jobs that use secrets need an encrypted disk`, turnOn);
  return ok("filevault", `${what} is off. ${ENCRYPTION_WHY}`, d.sys.os === "macos" ? `Turn it on with ${turnOn}.` : turnOn);
}

export async function downloadsCheck(d: Doctor): Promise<Check> {
  const host = new URL(d.downloads()).host;
  const r = await d.latestAgent();
  if (r.ok && r.status < 500) return ok("downloads", `${host} is reachable for images and updates`);
  return fail("downloads", `Cannot reach ${host}: images and Buildhound agent updates cannot download${r.ok ? ` (HTTP ${r.status})` : ` (${r.error})`}`, `Check the network, proxy or firewall for ${d.downloads()}`);
}

export async function githubApiCheck(d: Doctor): Promise<Check> {
  const url = d.githubApi();
  const host = new URL(url).host;
  const r = await d.sys.http(`${url}/rate_limit`, { timeoutMs: 5000 });
  if (r.ok && r.status < 500) return ok("github_api", `${host} is reachable`);
  return fail("github_api", `Cannot reach ${host}: jobs cannot reach GitHub from ${d.here}${r.ok ? ` (HTTP ${r.status})` : ` (${r.error})`}`, `Check the network, proxy or firewall for ${url}, or https://www.githubstatus.com`);
}

/** The checks in the order they print. Each has a title for when it runs out of time. */
export const CHECKS: Array<{ id: string; title: string; run: (d: Doctor) => Promise<Check> }> = [
  { id: "node", title: "Node", run: nodeCheck },
  { id: "github", title: "GitHub sign-in", run: githubCheck },
  { id: "api", title: "Buildhound API", run: apiCheck },
  { id: "account", title: "Account", run: accountCheck },
  { id: "agent", title: "Buildhound agent", run: agentCheck },
  { id: "machine", title: "Control plane", run: machineCheck },
  { id: "repositories", title: "Repositories", run: repositoriesCheck },
  { id: "images", title: "Images", run: imagesCheck },
  { id: "power", title: "Power", run: powerCheck },
  { id: "memory", title: "Memory", run: memoryCheck },
  { id: "disk", title: "Free disk space", run: diskCheck },
  { id: "simulators", title: "Simulators", run: simulatorsCheck },
  { id: "docker", title: "Docker", run: dockerCheck },
  { id: "vms", title: "Other VMs", run: vmsCheck },
  { id: "filevault", title: "FileVault", run: filevaultCheck },
  { id: "downloads", title: "Downloads", run: downloadsCheck },
  { id: "github_api", title: "GitHub's API", run: githubApiCheck },
  { id: "routing", title: "Routing", run: routingCheck },
];
