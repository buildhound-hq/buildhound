/**
 * R19 long-lived-cloud-keys (RULES.md, SECURITY.md). A job that passes stored cloud keys from secrets to an
 * official login action that supports GitHub's OIDC: an AWS key pair, a GCP service account JSON key, or
 * AZURE_CREDENTIALS. A leaked key works until someone rotates it; an OIDC login expires within the hour. Risk medium.
 *
 * Fix: `id-token: write` on the job, and the key inputs replaced with the provider's OIDC inputs, with the role or
 * provider left as a named placeholder. Changes behaviour: the cloud side needs the OIDC trust first.
 */
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import { ruleById } from "./registry";
import { canWrite, deleteKeepingComments, describePermissions, effectivePermissions, keyOf, mapAt, mergeScopes, parseUses, readWorkflow, secretsIn, SECURITY_ESTIMATE, setPermissions, severityFor, stepLabel, type RawStep, type Scopes } from "./security";
import type { Detection, Rule, RuleContext } from "./types";

interface Provider {
  name: string;
  /** Inputs that carry the long-lived key. */
  keyInputs: string[];
  /** OIDC inputs, in order, with named placeholders. The first takes the place of the first key input. */
  oidcInputs: [string, string][];
  guide: string;
}

const PROVIDERS: Record<string, Provider> = {
  "aws-actions/configure-aws-credentials": {
    name: "AWS",
    keyInputs: ["aws-access-key-id", "aws-secret-access-key", "aws-session-token"],
    oidcInputs: [["role-to-assume", "arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>"]],
    guide: "https://github.com/aws-actions/configure-aws-credentials",
  },
  "google-github-actions/auth": {
    name: "Google Cloud",
    keyInputs: ["credentials_json"],
    oidcInputs: [
      ["workload_identity_provider", "projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/providers/<PROVIDER_ID>"],
      ["service_account", "<SERVICE_ACCOUNT>@<PROJECT_ID>.iam.gserviceaccount.com"],
    ],
    guide: "https://github.com/google-github-actions/auth",
  },
  "azure/login": {
    name: "Azure",
    keyInputs: ["creds"],
    oidcInputs: [
      ["client-id", "<AZURE_CLIENT_ID>"],
      ["tenant-id", "<AZURE_TENANT_ID>"],
      ["subscription-id", "<AZURE_SUBSCRIPTION_ID>"],
    ],
    guide: "https://github.com/Azure/login",
  },
};

interface KeyedLogin {
  step: RawStep;
  provider: Provider;
  inputs: string[];
  secrets: string[];
}

function keyedLogin(s: RawStep): KeyedLogin | null {
  const ref = s.uses ? parseUses(s.uses) : null;
  const provider = ref ? PROVIDERS[ref.key] : undefined;
  if (!provider) return null;
  const inputs = provider.keyInputs.filter((k) => secretsIn(s.with[k]).length > 0);
  if (!inputs.length) return null;
  return { step: s, provider, inputs, secrets: secretsIn(inputs.map((k) => s.with[k])) };
}

/** Swap the key inputs for the OIDC inputs in place: the first key pair is renamed, so its comments stay put. */
function toOidc(doc: Document, w: YAMLMap, login: KeyedLogin): void {
  const keys = w.items.map(keyOf);
  const firstIndex = Math.min(...login.provider.keyInputs.map((k) => keys.indexOf(k)).filter((i) => i >= 0));
  const first = w.items[firstIndex]!;
  const [[name, value], ...rest] = login.provider.oidcInputs as [[string, string], ...[string, string][]];
  for (const k of login.provider.keyInputs) if (k !== keyOf(first)) deleteKeepingComments(w, k);
  if (isScalar(first.key)) first.key.value = name;
  else first.key = doc.createNode(name);
  if (isScalar(first.value)) first.value.value = value;
  else first.value = doc.createNode(value);
  let at = w.items.indexOf(first);
  for (const [k, v] of rest) {
    if (w.has(k)) continue;
    w.items.splice(++at, 0, doc.createPair(k, v));
  }
}

export const R19: Rule = {
  meta: ruleById("R19")!,
  detect(ctx: RuleContext): Detection[] {
    const wf = readWorkflow(ctx);
    const out: Detection[] = [];
    for (const job of wf.jobs) {
      const logins = job.steps.map(keyedLogin).filter((l): l is KeyedLogin => l !== null);
      if (!logins.length) continue;
      const { perms, source } = effectivePermissions(wf, job);
      // The job block replaces what the job inherited, so it carries those scopes forward plus id-token: write.
      let block: Scopes | null = null;
      if (!canWrite(perms, "id-token") || perms.kind === "default") {
        const base: Scopes = perms.kind === "scopes" ? perms.scopes : { contents: "read" };
        block = mergeScopes(base, { "id-token": "write" });
      }
      const providers = [...new Set(logins.map((l) => l.provider.name))];
      const guides = [...new Set(logins.map((l) => l.provider.guide))];
      out.push({
        jobId: job.id,
        severity: severityFor("medium"),
        evidence: {
          risk: "medium",
          logins: logins.map((l) => ({ step: stepLabel(l.step), uses: l.step.uses, provider: l.provider.name, keyInputs: l.inputs, secrets: l.secrets })),
          secrets: [...new Set(logins.flatMap((l) => l.secrets))].sort(),
          permissions: describePermissions(perms),
          permissionsSource: source,
          proposedPermissions: block,
          placeholders: logins.flatMap((l) => l.provider.oidcInputs.map(([k, v]) => `${k}: ${v}`)),
          guides,
        },
        estimate: SECURITY_ESTIMATE,
        summary: `Job "${job.id}" logs in to ${providers.join(" and ")} with long-lived keys from secrets (${[...new Set(logins.flatMap((l) => l.secrets))].join(", ")}); use OIDC instead`,
        confirmBeforeMerging: `Confirm before merging: ${providers.join(" and ")} must trust GitHub's OIDC provider for this repository, and the placeholders must hold the real role or provider, before this merges; until then the login step fails. Setup: ${guides.join(", ")}. Once it works, delete the stored keys and rotate them.${block && perms.kind !== "scopes" ? ` The job's token becomes ${Object.entries(block).map(([k, a]) => `${k}: ${a}`).join(", ")}.` : ""}`,
        fix: (doc) => {
          for (const l of logins) {
            const step = mapAt(doc, ["jobs", job.id, "steps", l.step.index]);
            const w = step?.get("with", true);
            if (isMap(w)) toOidc(doc, w, l);
          }
          if (block) setPermissions(doc, ["jobs", job.id], block);
        },
      });
    }
    return out;
  },
};
