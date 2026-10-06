import type { ActorKind } from "../model/types";

export const KNOWN_AGENT_LOGINS: Record<string, string> = {
  "claude": "claude",
  "claude[bot]": "claude",
  "copilot-swe-agent[bot]": "copilot",
  "copilot": "copilot",
  "codex": "codex",
  "chatgpt-codex-connector[bot]": "codex",
  "cursor": "cursor",
  "cursoragent": "cursor",
  "devin-ai-integration[bot]": "devin",
};
export const KNOWN_BOTS: Record<string, string> = { "dependabot[bot]": "dependabot", "renovate[bot]": "renovate", "github-actions[bot]": "github-actions" };
export const DEFAULT_AGENT_PREFIXES = ["claude/", "codex/", "copilot/", "cursor/", "devin/"];

export interface AttributionInput {
  actorLogin: string | null;
  headBranch: string | null;
  event: string;
  labels?: string[];
  coAuthors?: string[];
  agentPrefixes?: string[];
  agentLabels?: string[];
}

export interface Attribution {
  kind: ActorKind;
  agentName: string | null;
}

/** Order from DATA_MODEL.md: scheduled runs first, then bot suffix and known bots, known agent logins, branch prefixes, PR labels, co-author trailers. */
export function attribute(input: AttributionInput): Attribution {
  if (input.event === "schedule") return { kind: "scheduled", agentName: null };
  const login = (input.actorLogin ?? "").toLowerCase();
  if (login && KNOWN_AGENT_LOGINS[login]) return { kind: "agent", agentName: KNOWN_AGENT_LOGINS[login]! };
  if (login && KNOWN_BOTS[login]) return { kind: "bot", agentName: KNOWN_BOTS[login]! };
  if (login.endsWith("[bot]")) return { kind: "bot", agentName: login.replace(/\[bot\]$/, "") };
  const prefixes = input.agentPrefixes ?? DEFAULT_AGENT_PREFIXES;
  const branch = input.headBranch ?? "";
  for (const p of prefixes) if (branch.startsWith(p)) return { kind: "agent", agentName: p.replace(/\/$/, "") };
  const agentLabels = input.agentLabels ?? ["agent"];
  if (input.labels?.some((l) => agentLabels.includes(l))) return { kind: "agent", agentName: "unknown" };
  for (const ca of input.coAuthors ?? []) {
    const l = ca.toLowerCase();
    for (const [k, v] of Object.entries(KNOWN_AGENT_LOGINS)) if (l.includes(k.replace("[bot]", ""))) return { kind: "agent", agentName: v };
    if (/noreply@anthropic\.com|claude/.test(l)) return { kind: "agent", agentName: "claude" };
  }
  return login ? { kind: "human", agentName: null } : { kind: "unknown", agentName: null };
}
