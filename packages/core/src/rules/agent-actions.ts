/**
 * AI agent actions and command-line tools that read untrusted text and act on the repository (R18).
 *
 * To extend: add the action as `owner/repo` in lower case (no `@ref`) to AGENT_ACTIONS, or a pattern that
 * matches the tool's invocation in a `run:` step to AGENT_COMMANDS. If the action needs GITHUB_TOKEN scopes,
 * add them to action-permissions.ts too so the R18 fix can narrow the job's permissions to exactly those.
 */
import { parseUses, type RawStep } from "./security";

export const AGENT_ACTIONS: Record<string, string> = {
  "anthropics/claude-code-action": "Claude Code",
  "anthropics/claude-code-base-action": "Claude Code",
  "openai/codex-action": "Codex",
  "google-github-actions/run-gemini-cli": "Gemini CLI",
  "google-gemini/gemini-cli-action": "Gemini CLI",
  "coderabbitai/ai-pr-reviewer": "CodeRabbit",
  "qodo-ai/pr-agent": "Qodo PR-Agent",
  "codium-ai/pr-agent": "Qodo PR-Agent",
};

export const AGENT_COMMANDS: { pattern: RegExp; agent: string }[] = [
  { pattern: /@anthropic-ai\/claude-code\b|\bclaude\s+(-p|--print)\b/, agent: "Claude Code" },
  { pattern: /@openai\/codex\b|\bcodex\s+exec\b/, agent: "Codex" },
  { pattern: /@google\/gemini-cli\b|\bgemini\s+(-p|--prompt)\b/, agent: "Gemini CLI" },
  { pattern: /\bcopilot\s+(-p|--prompt)\b|@github\/copilot\b/, agent: "Copilot CLI" },
];

/** The agent a step runs, or null. */
export function agentOf(s: RawStep): string | null {
  if (s.uses) {
    const ref = parseUses(s.uses);
    return ref ? AGENT_ACTIONS[ref.key] ?? null : null;
  }
  const run = s.run ?? "";
  return AGENT_COMMANDS.find((c) => c.pattern.test(run))?.agent ?? null;
}
