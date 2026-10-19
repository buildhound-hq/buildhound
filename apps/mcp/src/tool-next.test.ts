import { describe, expect, it } from "vitest";
import { namesCli, translateMessage, translateNext } from "./tool-next";

describe("tool next", () => {
  it("agentfirst: a command in next becomes the tool call that does the same", () => {
    const cases: Array<[string, string]> = [
      ["buildhound runner status --org acme", 'call runner_status with org: "acme"'],
      ["buildhound runner set --org acme --machine mini-01 --resume", 'call runner_set with org: "acme", machine: "mini-01", paused: false'],
      ["buildhound runner set --org acme --machine mini --add-repository acme/a,acme/b", 'call runner_set with org: "acme", machine: "mini", add_repositories: ["acme/a", "acme/b"]'],
      ["buildhound jobs --org acme --repository acme/app", 'call jobs_list with org: "acme", repository: ["acme/app"]'],
      ["buildhound job 123 --org acme", 'call job_get with id: "123", org: "acme"'],
      ['buildhound search "swift" --org acme', 'call search with q: "swift", org: "acme"'],
      ["buildhound cache clear --org acme --machine mini-03 --yes", 'call cache_clear with org: "acme", machine: "mini-03", confirm: true'],
      ["buildhound route --apply --repo dev/app --yes", 'call route_apply with repo: "dev/app", confirm: true'],
      ["buildhound route --repo <owner/name>", 'call route_jobs with repo: "<owner/name>"'],
      ["buildhound scan --fix --repo acme/app --rule R06", 'call scan_fix with repo: "acme/app", rules: ["R06"]'],
      ["buildhound settings --org acme --performance balanced", 'call settings_set with org: "acme", performance: "balanced"'],
      ["buildhound billing checkout --org acme --annual", 'call billing_checkout with org: "acme", billing: "annual"'],
      ["buildhound repo-icon --repo acme/app --clear --yes", 'call repo_icon_clear with repo: "acme/app", confirm: true'],
      ["buildhound runner status --org acme --token $(gh auth token)", 'call runner_status with org: "acme"'],
      ["buildhound billing checkout --org benyd, then the same command runs again", 'call billing_checkout with org: "benyd", then the same command runs again'],
      [
        "a person opens Manage billing at https://app.buildhound.sh/acme/settings/billing, then buildhound billing period --org acme --billing annual --yes",
        'a person opens Manage billing at https://app.buildhound.sh/acme/settings/billing, then call billing_period with org: "acme", billing: "annual", confirm: true',
      ],
      ["remove /x/config.json and run buildhound runner add --org acme again", 'remove /x/config.json and call runner_add with org: "acme" again'],
      ["a person reviews and merges https://github.com/dev/app/pull/1", "a person reviews and merges https://github.com/dev/app/pull/1"],
    ];
    for (const [cli, tool] of cases) expect(translateNext(cli), cli).toBe(tool);
  });

  it("agentfirst: a command a person runs in a terminal stays as written", () => {
    for (const next of [
      "ask a maintainer of dev/app to run npx buildhound route --apply --repo dev/app --yes",
      "a person runs sudo fdesetup enable in a terminal on laptop-01, saves the recovery key it prints, then runs buildhound runner set --machine laptop-01 --org acme --trusted on there",
    ]) expect(translateNext(next)).toBe(next);
  });

  it("agentfirst: a command or flag no tool has gives null, so the tool's own next is used", () => {
    for (const next of [
      "buildhound failover --org acme --label buildhound-linux --fallback on --yes",
      "buildhound scan --repo acme/app",
      "check the network with buildhound doctor, or pass --api-url, then buildhound jobs --org acme",
      "buildhound runner set --machine <id|name> --org <login> [--routing primary|backup|off] [--pause | --resume]",
      "buildhound estimate .github/workflows/<name>.yml",
    ]) expect(translateNext(next), next).toBeNull();
  });

  it("messages name tool arguments for the flags a tool takes", () => {
    expect(translateMessage("--repositories replaces the list: pass it, or --add-repository and --remove-repository, not both")).toBe(
      "repositories replaces the list: pass it, or add_repositories and remove_repositories, not both",
    );
    expect(translateMessage("--stay-awake must be never, plugged_in or always")).toBe("stay_awake must be never, plugged_in or always");
    expect(namesCli("call runner_status with org: \"acme\"")).toBe(false);
    expect(namesCli("buildhound runner status")).toBe(true);
  });
});
