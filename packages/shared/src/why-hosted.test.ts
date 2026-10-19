import { describe, expect, it } from "vitest";
import { FailoverReason } from "./control-plane";
import { CancelCode, MACHINE_WHY, MachineWhyCode, WHY_HOSTED, WhyCode, bannerShows, cancelFromAnnotations, cancelReason, explainWhy, familyName, hostedReason, machineWhy, trustBannerSummary, WAIT_OFFLINE_AFTER_MS, waitCause, waitGroups, servingMachines, whyFromRerun, type MachineWhyInput } from "./why-hosted";

const online: MachineWhyInput = { status: "online", labels: ["buildhound-macos", "buildhound-linux"], routing: "primary", running_jobs: 0, capacity: 2, heartbeats_ok: true, listening: true };

describe("why jobs ran on GitHub-hosted: the one table", () => {
  it("has a row for every failover reason, not_served and the two job-only reasons", () => {
    for (const code of FailoverReason.options) expect(WHY_HOSTED[code], code).toBeDefined();
    expect(Object.keys(WHY_HOSTED).sort()).toEqual([...WhyCode.options].sort());
  });

  it("gives every row a summary, a one-sentence fix, who, a tone and a next step, in plain words", () => {
    for (const code of WhyCode.options) {
      const w = explainWhy(code, { owner: "acme", label: "buildhound-macos", machine_name: "mini" });
      expect(w.summary, code).toBeTruthy();
      expect(w.fix, code).toMatch(/\.$/);
      expect(w.next, code).toMatch(/^(buildhound |\/)/);
      if (w.where === "github_hosted") expect(w.job, code).toBeTruthy();
      for (const text of [w.summary, w.fix, w.job, w.next]) {
        expect(text, code).not.toMatch(/\{\w+\}/);
        expect(text, code).not.toMatch(/\u2014/);
        // docs/BRAND.md, Glossary: retired words stay out of what people read.
        expect(text, code).not.toMatch(/\b(overflow|spillover|burst|rescued?|went quiet|untrusted event)\b|\bon GitHub(?!-hosted)/i);
      }
    }
  });

  it("says the board's words for the reasons it shows", () => {
    expect(explainWhy("machines_held", { owner: "acme" })).toMatchObject({ summary: "Your machines are holding new jobs back", who: "automatic", where: "github_hosted" });
    expect(explainWhy("overflow", { owner: "acme" })).toMatchObject({ summary: "Every machine was busy too long", who: "automatic", tone: "busy" });
    expect(explainWhy("no_machine", { owner: "acme" })).toMatchObject({ summary: "No machine is connected", who: "you", next: "buildhound doctor --org acme" });
    expect(explainWhy("untrusted_event", { owner: "acme" })).toMatchObject({ who: "nobody", tone: "quiet" });
    expect(explainWhy("not_served", { owner: "acme", label: "buildhound-linux-x64" })).toMatchObject({ summary: "Your machines can't run this kind", fix: "Expected, nothing to fix; a Linux x64 machine would take them.", who: "nobody" });
    expect(explainWhy("github_self_hosted_incident", { owner: "acme" }).fix).toBe("New jobs route to the healthy side until GitHub recovers.");
  });

  it("fills in the account, the label, the plan and a machine to trust", () => {
    expect(explainWhy("needs_trusted_machine", { owner: "acme", label: "buildhound-macos-trusted", machine_name: "Benys-MacBook-Pro" })).toMatchObject({
      fix: "Set up a trusted Mac: FileVault on, then Trust this Mac.",
      job: "It uses secrets and no trusted Mac was free.",
      next: "buildhound runner set --org acme --machine Benys-MacBook-Pro --trusted on",
    });
    expect(explainWhy("needs_trusted_machine", { owner: "acme", label: "buildhound-linux" }).fix).toBe("Set up a trusted machine: disk encryption on, then Trust this machine.");
    expect(explainWhy("needs_trusted_machine", { owner: "acme" }).next).toContain("--machine <machine>");
    expect(explainWhy("needs_plan", { owner: "acme" })).toMatchObject({ fix: "Choose Pro. Free runs one private repository, and every public one keeps running here.", next: "buildhound billing checkout --org acme" });
    expect(explainWhy("waiting_for_machine", { owner: "acme", label: "buildhound-linux" }).next).toBe("buildhound failover --org acme --label buildhound-linux --fallback on --yes");
  });

  it("puts reasons that name machines on the machines and the rest on GitHub-hosted", () => {
    for (const code of ["machine_online", "machines_busy", "waiting_for_machine"] as const) expect(WHY_HOSTED[code].where).toBe("machines");
    for (const code of ["overflow", "machines_held", "no_machine", "needs_trusted_machine", "untrusted_event", "needs_plan", "manual", "github_self_hosted_incident", "not_served"] as const) expect(WHY_HOSTED[code].where).toBe("github_hosted");
  });

  it("maps a job's re-run reason to a row only when it is a reason to run on GitHub-hosted", () => {
    expect(whyFromRerun("overflow")).toBe("overflow");
    expect(whyFromRerun("host_vanished")).toBe("host_vanished");
    expect(whyFromRerun("needs_trusted_machine")).toBe("needs_trusted_machine");
    expect(whyFromRerun("stuck")).toBeNull();
    expect(whyFromRerun("machine_online")).toBeNull();
    expect(whyFromRerun("something_new")).toBeNull();
  });

  it("gives a job the sentence its page shows, or the summary where the table has none", () => {
    expect(hostedReason("needs_trusted_machine", { owner: "acme", label: "buildhound-macos" })).toMatchObject({ code: "needs_trusted_machine", job: "It uses secrets and no trusted Mac was free.", who: "you" });
    expect(hostedReason("machine_online", { owner: "acme" }).job).toBe("Your machines take new jobs");
  });

  it("names families as people say them", () => {
    expect(familyName("buildhound-macos")).toBe("macOS");
    expect(familyName("buildhound-macos-trusted")).toBe("macOS");
    expect(familyName("buildhound-linux")).toBe("Linux");
    expect(familyName("buildhound-linux-x64")).toBe("Linux x64");
    expect(familyName("buildhound-linux-arm64")).toBe("Linux arm64");
  });
});

describe("each machine's why", () => {
  it("has a phrase for every code", () => {
    for (const code of MachineWhyCode.options) expect(MACHINE_WHY[code], code).toBeTruthy();
    expect(MACHINE_WHY.in_use).toBe("in use");
    expect(MACHINE_WHY.memory_pressure).toBe("short on memory");
    expect(MACHINE_WHY.low_power).toBe("Low Power Mode");
  });

  it("is free or busy for a machine that takes jobs", () => {
    expect(machineWhy(online, "buildhound-macos")).toBe("free");
    expect(machineWhy({ ...online, running_jobs: 2 }, "buildhound-macos")).toBe("busy");
    expect(machineWhy({ ...online, slot: { capacity: 1, running: 1 } }, "buildhound-macos")).toBe("busy");
    expect(machineWhy({ ...online, exclusive: "finishing_up" }, "buildhound-macos")).toBe("busy");
  });

  it("names the owner's own rules: offline, routing off, paused, in use, on battery", () => {
    expect(machineWhy({ ...online, status: "offline" }, "buildhound-macos")).toBe("offline");
    expect(machineWhy({ ...online, status: "needs_update" }, "buildhound-macos")).toBe("needs_update");
    expect(machineWhy({ ...online, routing: "off" }, "buildhound-macos")).toBe("routing_off");
    expect(machineWhy({ ...online, status: "paused" }, "buildhound-macos")).toBe("paused");
    expect(machineWhy({ ...online, paused: true }, "buildhound-macos")).toBe("paused");
    expect(machineWhy({ ...online, idle_only: true, idle: false }, "buildhound-macos")).toBe("in_use");
    expect(machineWhy({ ...online, idle_only: false, idle: false }, "buildhound-macos")).toBe("free");
    expect(machineWhy({ ...online, plugged_in_only: true, on_battery: true }, "buildhound-macos")).toBe("on_battery");
    // In use comes before the memory strain it may cause, as the control plane decides.
    expect(machineWhy({ ...online, idle_only: true, idle: false, strain: "memory_pressure" }, "buildhound-macos")).toBe("in_use");
  });

  it("names the strain that holds new jobs back, unless it comes from the machine's own jobs", () => {
    expect(machineWhy({ ...online, strain: "memory_pressure" }, "buildhound-macos")).toBe("memory_pressure");
    expect(machineWhy({ ...online, strain: "swap_growing" }, "buildhound-macos")).toBe("swap_growing");
    expect(machineWhy({ ...online, memory_low: ["buildhound-macos"] }, "buildhound-macos")).toBe("memory_low");
    expect(machineWhy({ ...online, memory_low: ["buildhound-macos"] }, "buildhound-linux")).toBe("free");
    expect(machineWhy({ ...online, thermal: "serious" }, "buildhound-macos")).toBe("heat");
    expect(machineWhy({ ...online, strain: "thermal" }, "buildhound-macos")).toBe("heat");
    expect(machineWhy({ ...online, low_power: true }, "buildhound-macos")).toBe("low_power");
    expect(machineWhy({ ...online, strain: "comfort", running_jobs: 1 }, "buildhound-macos")).toBe("comfort");
    expect(machineWhy({ ...online, strain: "memory_pressure", running_jobs: 1 }, "buildhound-macos")).toBe("busy");
    expect(machineWhy({ ...online, strain: "something_else" }, "buildhound-macos")).toBe("strain");
  });

  it("says when a machine cannot take the label at all, or not yet", () => {
    expect(machineWhy({ ...online, removed: true }, "buildhound-macos")).toBe("removed");
    expect(machineWhy(online, "buildhound-linux-x64")).toBe("not_this_kind");
    expect(machineWhy({ ...online, not_ready: ["buildhound-macos"] }, "buildhound-macos")).toBe("not_ready");
    expect(machineWhy({ ...online, awaiting_pool_consent: true }, "buildhound-macos")).toBe("pool_consent");
    expect(machineWhy({ ...online, heartbeats_ok: false }, "buildhound-macos")).toBe("starting");
    expect(machineWhy({ ...online, listening: false }, "buildhound-macos")).toBe("not_listening");
    expect(machineWhy({ ...online, serves_repositories: false }, "buildhound-macos")).toBe("no_repositories");
  });

  it("for jobs that use secrets, names a machine that does not take them first", () => {
    expect(machineWhy(online, "buildhound-macos-trusted")).toBe("no_secrets");
    expect(machineWhy({ ...online, trust: "trusted" }, "buildhound-macos-trusted")).toBe("free");
    expect(machineWhy({ ...online, trust: "trusted", isolation: "container" }, "buildhound-macos-trusted")).toBe("container");
  });
});

describe("the trust banner", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  it("shows only with a count, and after a dismissal only once 30 days passed or the count doubled", () => {
    expect(bannerShows(0, null, at)).toBe(false);
    expect(bannerShows(3, null, at)).toBe(true);
    expect(bannerShows(5, { at, count: 3 }, new Date("2026-10-15T00:00:00Z"))).toBe(false);
    expect(bannerShows(6, { at, count: 3 }, new Date("2026-10-15T00:00:00Z"))).toBe(true);
    expect(bannerShows(4, { at, count: 3 }, new Date("2026-10-31T00:00:00Z"))).toBe(true);
    expect(bannerShows(1, { at, count: 0 }, new Date("2026-10-02T00:00:00Z"))).toBe(false);
  });

  it("counts jobs in its line", () => {
    expect(trustBannerSummary(12)).toBe("12 jobs with secrets ran on GitHub-hosted this week");
    expect(trustBannerSummary(1)).toBe("1 job with secrets ran on GitHub-hosted this week");
  });
});

describe("why a job was cancelled", () => {
  it("reads GitHub's annotations: a newer run in the concurrency group, a person, Buildhound's bot, the time limit", () => {
    expect(cancelFromAnnotations(["Canceling since a higher priority waiting request for 'ci-refs/heads/main' exists"])).toEqual({ code: "superseded", group: "ci-refs/heads/main" });
    expect(cancelFromAnnotations(["Canceling since a higher priority waiting request for ci-main exists"])).toEqual({ code: "superseded", group: "ci-main" });
    expect(cancelFromAnnotations(["The run was canceled by @BenyD."])).toEqual({ code: "cancelled_by_person", login: "BenyD" });
    expect(cancelFromAnnotations(["The run was canceled by @buildhound-ci[bot]."], "buildhound-ci")).toEqual({ code: "cancelled_by_buildhound", login: "buildhound-ci[bot]" });
    expect(cancelFromAnnotations(["The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 360 minutes."])).toEqual({ code: "timed_out", minutes: 360 });
    expect(cancelFromAnnotations(["Process completed with exit code 1."])).toEqual({ code: "cancelled_on_github" });
    expect(cancelFromAnnotations([])).toEqual({ code: "cancelled_on_github" });
  });

  it("says it in the table's shape, Buildhound's own re-run first, and never guesses", () => {
    const ctx = { workflow: "ci", branch: "main" };
    expect(cancelReason(ctx, null, { code: "superseded", group: "ci-main" })).toMatchObject({ code: "superseded", summary: "A newer run of ci on main replaced this one", who: "nobody" });
    expect(cancelReason({}, null, { code: "superseded" }).summary).toBe("A newer run replaced this one");
    expect(cancelReason(ctx, null, { code: "cancelled_by_person", login: "BenyD" })).toMatchObject({ summary: "Cancelled by @BenyD", login: "BenyD" });
    expect(cancelReason(ctx, null, { code: "timed_out", minutes: 30 })).toMatchObject({ summary: "Hit the job's time limit", who: "you", fix: "Raise the job's timeout-minutes (30 now), or make it faster." });
    expect(cancelReason(ctx, null, null)).toMatchObject({ code: "cancelled_on_github", summary: "Cancelled on GitHub", fix: "GitHub gave no reason." });
    // The control plane's record wins over what GitHub's annotation said (its bot cancelled the run).
    expect(cancelReason(ctx, { reason: "overflow", routed_to: "hosted" }, { code: "cancelled_by_buildhound" })).toMatchObject({
      code: "rerun",
      summary: "Buildhound re-ran it on GitHub-hosted: every machine was busy, and it waited 150 seconds for a free slot",
      who: "automatic",
      rerun_to: "github_hosted",
      rerun_reason: "overflow",
    });
    expect(cancelReason(ctx, { reason: "host_vanished", routed_to: "machine" }, null).summary).toBe("Buildhound re-ran it on your machines: its machine stopped responding mid-job");
    expect(cancelReason(ctx, { reason: "stuck", routed_to: "machine" }, null).summary).toBe("Buildhound re-ran it on your machines: it was stuck in GitHub's queue while a machine had room");
    for (const code of CancelCode.options) expect(code).toBeTruthy();
  });
});

describe("jobs waiting with Fall back to GitHub-hosted off", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const four = ["buildhound-linux-arm64", "buildhound-linux-arm64-trusted", "buildhound-linux", "buildhound-linux-trusted"];
  const mini = { name: "Benys-Mac-mini", os: "macos", status: "online", last_heartbeat_at: ago(5_000) };
  const pro = { name: "Benys-MacBook-Pro", os: "macos", status: "online", last_heartbeat_at: ago(5_000) };

  it("is one status item, never one that needs a person, while a machine that serves them is online", () => {
    const [g, ...rest] = waitGroups(four, [mini, pro], now, "acme");
    expect(rest).toEqual([]);
    // On an account of Macs, Linux and Linux arm64 are one thing, and twins fold into their family.
    expect(g).toMatchObject({ labels: ["buildhound-linux"], cause: "working", act: false, title: "Linux jobs wait for your Macs", next: "buildhound status --org acme" });
    expect(g!.text).toBe(`${WHY_HOSTED.waiting_for_machine.summary}. They start as soon as one is free.`);
  });

  it("needs a person once every machine has been offline a few minutes, with the cause in the title", () => {
    const off = [{ ...mini, status: "offline", last_heartbeat_at: ago(WAIT_OFFLINE_AFTER_MS + 60_000) }, { ...pro, status: "offline", last_heartbeat_at: ago(3_600_000) }];
    expect(waitGroups(four, off, now, "acme")).toEqual([
      expect.objectContaining({ cause: "offline", act: true, title: "No machine that runs Linux is online", machines: ["Benys-Mac-mini", "Benys-MacBook-Pro"], next: "buildhound failover --org acme --label buildhound-linux --fallback on --yes" }),
    ]);
    // A machine that went quiet a minute ago is a reboot or a blip, not a thing to fix yet.
    expect(waitGroups(four, [{ ...mini, status: "offline", last_heartbeat_at: ago(60_000) }], now, "acme")[0]).toMatchObject({ cause: "offline", act: false });
  });

  it("names Linux arm64 apart from Linux when a Linux machine is connected, and merges families in the same state", () => {
    const box = { name: "ci-box", os: "linux", status: "online", labels: ["buildhound-linux", "buildhound-linux-arm64"] };
    expect(waitGroups(four, [mini, box], now, "acme")[0]).toMatchObject({ labels: ["buildhound-linux", "buildhound-linux-arm64"], title: "Linux and Linux arm64 jobs wait for your machines" });
    const gone = waitGroups(four, [{ ...box, status: "offline", last_heartbeat_at: ago(3_600_000) }], now, "acme")[0]!;
    // Several families: no single label to turn the fallback on for, so the next step shows each.
    expect(gone).toMatchObject({ title: "No machine that runs Linux or Linux arm64 is online", next: "buildhound status --org acme" });
  });

  it("names paused machines, with the command that resumes one", () => {
    expect(waitGroups(["buildhound-macos"], [{ ...mini, status: "paused" }], now, "acme")[0]).toMatchObject({ cause: "paused", act: true, title: "Benys-Mac-mini is paused", next: "buildhound runner set --org acme --machine Benys-Mac-mini --resume" });
    expect(waitGroups(["buildhound-macos"], [{ ...mini, status: "paused" }, { ...pro, status: "paused" }], now, "acme")[0]!.title).toBe("Your Macs are paused");
    const mixed = waitGroups(["buildhound-macos"], [{ ...mini, status: "paused" }, { ...pro, status: "offline", last_heartbeat_at: ago(3_600_000) }], now, "acme")[0]!;
    expect(mixed).toMatchObject({ cause: "down", act: true, title: "No machine that runs macOS can take jobs" });
    expect(mixed.text).toMatch(/^Each one is paused or offline\./);
  });

  it("keeps families in different states apart, in Fleet's order", () => {
    const linuxBox = { name: "ci-box", os: "linux", status: "offline", last_heartbeat_at: ago(3_600_000), labels: ["buildhound-linux-x64"] };
    const g = waitGroups(["buildhound-linux-x64", "buildhound-macos"], [mini, linuxBox], now, "acme");
    expect(g.map((x) => [x.names, x.cause, x.act])).toEqual([
      ["macOS", "working", false],
      ["Linux x64", "offline", true],
    ]);
    for (const x of g) expect(`${x.title} ${x.text}`).not.toMatch(/\u2014|no machine can take a job/);
  });

  it("finds the serving machines by their labels, else by kind", () => {
    expect(servingMachines("buildhound-linux-arm64", [mini, { name: "x", os: "linux", status: "online" }]).map((m) => m.name)).toEqual(["Benys-Mac-mini", "x"]);
    expect(servingMachines("buildhound-linux-x64", [mini]).length).toBe(0);
    expect(servingMachines("buildhound-macos", [{ name: "y", os: "macos", status: "online", labels: ["buildhound-linux-trusted"] }]).length).toBe(0);
    expect(waitCause([], now)).toEqual({ cause: "down", act: true });
  });
});
