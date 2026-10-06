import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import type { RateOverrides, RuleConfig } from "@buildhound/core";
import { EXIT } from "@buildhound/shared";
import { CliError } from "../output";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Account-level costs a provider adds on top of the per-minute rate ([runners.*] in buildhound.toml). */
export interface FixedCost {
  monthlyFixedCents: number;
  includedMinutes: number;
}

export interface CliConfig {
  /** Absolute path of the file that was read, or null when there was none. */
  path: string | null;
  rules: Partial<RuleConfig>;
  overrides: RateOverrides;
  fixedCosts: Record<string, FixedCost>;
  check: { failOnSeverity: "high" | "medium" | "low" | null };
  routingEnabled: boolean;
}

export const EMPTY_CONFIG: CliConfig = { path: null, rules: {}, overrides: {}, fixedCosts: {}, check: { failOnSeverity: null }, routingEnabled: true };

/** Walk up from `start` looking for buildhound.toml. A missing file is not an error. */
export function findConfigFile(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(dir, "buildhound.toml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Map the TOML document from CLI_AND_MCP.md onto RuleConfig and RateOverrides. Unknown keys are ignored. */
export function parseConfig(text: string, filePath: string): CliConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new CliError("CONFIG_INVALID", `${filePath}: ${e instanceof Error ? e.message : String(e)}`, "fix the TOML syntax and rerun, or remove the file", EXIT.usage);
  }
  const doc = isObj(raw) ? raw : {};
  const rules: Partial<RuleConfig> = {};
  const attribution = isObj(doc.attribution) ? doc.attribution : {};
  const prefixes = strings(attribution.agent_prefixes);
  if (prefixes) rules.agentPrefixes = prefixes;
  const rulesSection = isObj(doc.rules) ? doc.rules : {};
  const disabled = strings(rulesSection.disabled);
  if (disabled) rules.disabledRules = disabled;

  const routing = isObj(doc.routing) ? doc.routing : {};
  const providers = strings(routing.providers);
  const installed = strings(routing.installed);
  const minSaving = num(routing.min_saving_percent);
  const minJobUsd = num(routing.min_job_usd_per_month);
  if (providers || installed || minSaving !== undefined || minJobUsd !== undefined) {
    rules.routing = {
      providers: providers ?? ["github", "blacksmith", "depot", "warpbuild", "ubicloud", "buildhound"],
      installed: installed ?? [],
      minSavingPercent: minSaving ?? 25,
      minJobCentsPerMonth: minJobUsd !== undefined ? Math.round(minJobUsd * 100) : 2000,
    };
  }

  const overrides: RateOverrides = {};
  const fixedCosts: Record<string, FixedCost> = {};
  const runners = isObj(doc.runners) ? doc.runners : {};
  for (const [provider, section] of Object.entries(runners)) {
    if (!isObj(section)) continue;
    const perMinute = num(section.usd_per_minute);
    if (perMinute !== undefined) overrides[provider] = perMinute;
    const fee = num(section.license_usd_per_month) ?? num(section.plan_usd_per_month);
    const included = num(section.included_minutes);
    if (fee !== undefined || included !== undefined) fixedCosts[provider] = { monthlyFixedCents: Math.round((fee ?? 0) * 100), includedMinutes: included ?? 0 };
    const profiles = isObj(section.profiles) ? section.profiles : {};
    for (const [profile, p] of Object.entries(profiles)) {
      const rate = isObj(p) ? num(p.usd_per_minute) : undefined;
      if (rate !== undefined) overrides[`${provider}:namespace-profile-${profile}`] = rate;
    }
  }

  const check = isObj(doc.check) ? doc.check : {};
  const failOn = check.fail_on_severity;
  const failOnSeverity = failOn === "high" || failOn === "medium" || failOn === "low" ? failOn : null;
  const routingEnabled = routing.enabled !== false;
  return { path: filePath, rules, overrides, fixedCosts, check: { failOnSeverity }, routingEnabled };
}

/** Read buildhound.toml for a directory (searching upwards). Returns EMPTY_CONFIG when there is none. */
export function loadConfig(start: string): CliConfig {
  const file = findConfigFile(start);
  if (!file) return EMPTY_CONFIG;
  return parseConfig(readFileSync(file, "utf8"), file);
}
