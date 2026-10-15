/**
 * The GITHUB_TOKEN scopes well-known actions and commands need. R16 and R18 infer per-job permissions from it.
 *
 * To extend: add the action as `owner/repo` in lower case (no `@ref`, no subdirectory) with the scopes its README
 * documents. A function entry derives the scopes from the step's `with:` inputs. An empty object means the action
 * needs nothing beyond the token's metadata access. Actions not listed are unknown: the R16 fix still narrows a
 * missing or write-all block, and names the step in "Confirm before merging" so a reviewer checks it. For `run:`
 * steps, add a pattern to RUN_PERMISSIONS; a command that talks to the GitHub API in a way not listed there
 * (UNKNOWN_RUN) makes the step unknown.
 */
import { mergeScopes, parseUses, stepLabel, type Obj, type RawJob, type RawStep, type Scopes } from "./security";

type Entry = Scopes | ((w: Obj) => Scopes);

const has = (w: Obj, key: string): boolean => w[key] !== undefined && w[key] !== null && w[key] !== "";

export const ACTION_PERMISSIONS: Record<string, Entry> = {
  // Checkout, toolchains, caches and artifacts.
  "actions/checkout": { contents: "read" },
  "actions/setup-node": {},
  "actions/setup-python": {},
  "actions/setup-go": {},
  "actions/setup-java": {},
  "actions/setup-dotnet": {},
  "actions/cache": {},
  "actions/upload-artifact": {},
  "actions/download-artifact": (w) => (has(w, "run-id") ? { actions: "read" } : {}),
  "actions/upload-pages-artifact": {},
  "pnpm/action-setup": {},
  "oven-sh/setup-bun": {},
  "astral-sh/setup-uv": {},
  "ruby/setup-ruby": {},
  "dtolnay/rust-toolchain": {},
  "swatinem/rust-cache": {},
  "maxim-lobanov/setup-xcode": {},
  "subosito/flutter-action": {},
  "codecov/codecov-action": {},
  "docker/setup-buildx-action": {},
  "docker/setup-qemu-action": {},
  "docker/metadata-action": {},
  "docker/build-push-action": {},
  "docker/login-action": (w) => (/ghcr\.io/i.test(String(w.registry ?? "")) ? { packages: "write" } : {}),
  // Comments, labels, checks and releases.
  "actions/labeler": { contents: "read", "pull-requests": "write" },
  "actions/stale": { issues: "write", "pull-requests": "write" },
  "actions/first-interaction": { issues: "write", "pull-requests": "write" },
  "peter-evans/create-pull-request": { contents: "write", "pull-requests": "write" },
  "peter-evans/create-or-update-comment": { issues: "write", "pull-requests": "write" },
  "marocchino/sticky-pull-request-comment": { "pull-requests": "write" },
  "thollander/actions-comment-pull-request": { "pull-requests": "write" },
  "amannn/action-semantic-pull-request": { "pull-requests": "read" },
  "dorny/paths-filter": { "pull-requests": "read" },
  "dorny/test-reporter": { checks: "write" },
  "enricomi/publish-unit-test-result-action": { checks: "write", "pull-requests": "write" },
  "softprops/action-gh-release": { contents: "write" },
  "ncipollo/release-action": { contents: "write" },
  "release-drafter/release-drafter": { contents: "write", "pull-requests": "write" },
  "googleapis/release-please-action": { contents: "write", "pull-requests": "write", issues: "write" },
  "changesets/action": { contents: "write", "pull-requests": "write" },
  // Code scanning, Pages and attestations.
  "github/codeql-action": { actions: "read", contents: "read", "security-events": "write" },
  "actions/deploy-pages": { pages: "write", "id-token": "write" },
  "actions/attest-build-provenance": { attestations: "write", "id-token": "write" },
  // Cloud logins: the OIDC form needs id-token: write, the key form needs nothing.
  "aws-actions/configure-aws-credentials": (w) => (has(w, "role-to-assume") && !has(w, "aws-access-key-id") ? { "id-token": "write" } : {}),
  "google-github-actions/auth": (w) => (has(w, "workload_identity_provider") ? { "id-token": "write" } : {}),
  "azure/login": (w) => (has(w, "client-id") && !has(w, "creds") ? { "id-token": "write" } : {}),
  // AI agents (agent-actions.ts lists them for R18). Scopes from each action's README.
  "anthropics/claude-code-action": { contents: "write", "pull-requests": "write", issues: "write", "id-token": "write" },
};

/** `run:` commands that need a scope. Order does not matter; every match adds its scopes. */
export const RUN_PERMISSIONS: { pattern: RegExp; scopes: Scopes }[] = [
  { pattern: /\bgit\s+push\b/, scopes: { contents: "write" } },
  { pattern: /\bgh\s+release\s+(create|upload|edit|delete)\b/, scopes: { contents: "write" } },
  { pattern: /\bgh\s+pr\s+(comment|create|edit|merge|review|close|ready)\b/, scopes: { "pull-requests": "write" } },
  { pattern: /\bgh\s+pr\s+(view|list|diff|checks|status)\b/, scopes: { "pull-requests": "read" } },
  { pattern: /\bgh\s+issue\s+(comment|create|edit|close|reopen)\b/, scopes: { issues: "write" } },
  { pattern: /\bgh\s+issue\s+(view|list)\b/, scopes: { issues: "read" } },
  { pattern: /\bnpm\s+publish\b[^\n]*--provenance/, scopes: { "id-token": "write" } },
];

/** A `run:` step that reaches the GitHub API in a way RUN_PERMISSIONS does not cover. */
const UNKNOWN_RUN = /\bgh\s+(api|workflow|run|repo|label|secret|variable|cache)\b|api\.github\.com|GITHUB_TOKEN|github\.token/;

export interface StepNeeds {
  scopes: Scopes;
  known: boolean;
}

export function stepNeeds(s: RawStep): StepNeeds {
  if (s.uses) {
    const ref = parseUses(s.uses);
    const entry = ref ? ACTION_PERMISSIONS[ref.key] : undefined;
    if (!entry) return { scopes: {}, known: false };
    return { scopes: typeof entry === "function" ? entry(s.with) : entry, known: true };
  }
  const run = s.run ?? "";
  let scopes: Scopes = {};
  let matched = false;
  for (const r of RUN_PERMISSIONS) {
    if (!r.pattern.test(run)) continue;
    matched = true;
    scopes = mergeScopes(scopes, r.scopes);
  }
  // A token in env is expected next to a recognised gh or git command; on its own it means unknown API use.
  const unknown = matched ? /\bgh\s+api\b|api\.github\.com/.test(run) : UNKNOWN_RUN.test(run) || UNKNOWN_RUN.test(JSON.stringify(s.env));
  return { scopes, known: !unknown };
}

export interface JobNeeds {
  scopes: Scopes;
  /** Labels of steps whose scopes could not be inferred. */
  unknownSteps: string[];
  /** The job calls a reusable workflow, whose needs are not visible here. */
  reusable: boolean;
}

export function jobNeeds(job: RawJob): JobNeeds {
  if (job.uses) return { scopes: {}, unknownSteps: [], reusable: true };
  let scopes: Scopes = {};
  const unknownSteps: string[] = [];
  for (const s of job.steps) {
    const n = stepNeeds(s);
    scopes = mergeScopes(scopes, n.scopes);
    if (!n.known) unknownSteps.push(stepLabel(s));
  }
  return { scopes, unknownSteps, reusable: false };
}

/** The block a job needs: read access to its contents plus whatever its steps need. */
export function proposedScopes(needs: Scopes): Scopes {
  return mergeScopes({ contents: "read" }, needs);
}

/** Narrow an existing block: write scopes the job does not need drop to read (contents, or when read is needed) or go. Never widens. */
export function narrowScopes(p: Scopes, needs: Scopes): Scopes {
  const out: Scopes = {};
  for (const [k, a] of Object.entries(p)) {
    if (a !== "write") out[k] = a;
    else if (needs[k] === "write") out[k] = "write";
    else if (needs[k] === "read" || k === "contents") out[k] = "read";
  }
  return out;
}
