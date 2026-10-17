import { parseDocument } from "yaml";

// What a workflow takes when someone starts it by hand (`on: workflow_dispatch`), read from the YAML with the
// `yaml` parser, never by matching text: the dashboard's Run workflow, `buildhound run` and MCP `workflow_run`
// offer only workflows this finds, and check the inputs given against it before GitHub is asked.

export type DispatchInputType = "string" | "boolean" | "choice" | "number" | "environment";

export interface DispatchInput {
  name: string;
  description: string | null;
  required: boolean;
  type: DispatchInputType;
  /** The default as GitHub would send it, a string; null when the workflow sets none. */
  default: string | null;
  /** A choice input's options; empty for every other type. */
  options: string[];
}

export interface DispatchSpec {
  inputs: DispatchInput[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const TYPES = new Set<DispatchInputType>(["string", "boolean", "choice", "number", "environment"]);

/** GitHub refuses a dispatch with more inputs than this. */
export const MAX_DISPATCH_INPUTS = 25;

/**
 * The workflow's `workflow_dispatch` trigger and its inputs, or null when it has none (or the file does not parse).
 * `on` may be a string, a list or a map; a map's `workflow_dispatch:` may be empty.
 */
export function workflowDispatch(content: string): DispatchSpec | null {
  const doc = parseDocument(content, { version: "1.2" });
  if (doc.errors.length) return null;
  const raw = doc.toJS({ mapAsMap: false }) as unknown;
  if (!isObj(raw)) return null;
  const on = raw.on ?? raw["true"];
  if (on === "workflow_dispatch") return { inputs: [] };
  if (Array.isArray(on)) return on.map(String).includes("workflow_dispatch") ? { inputs: [] } : null;
  if (!isObj(on) || !("workflow_dispatch" in on)) return null;
  const trigger = on.workflow_dispatch;
  const inputs = isObj(trigger) && isObj(trigger.inputs) ? trigger.inputs : {};
  return {
    inputs: Object.entries(inputs).map(([name, v]) => {
      const spec = isObj(v) ? v : {};
      const type = typeof spec.type === "string" && TYPES.has(spec.type as DispatchInputType) ? (spec.type as DispatchInputType) : "string";
      const options = type === "choice" && Array.isArray(spec.options) ? spec.options.map(String) : [];
      const def = spec.default === undefined || spec.default === null ? null : String(spec.default);
      return { name, description: typeof spec.description === "string" ? spec.description : null, required: spec.required === true, type, default: def, options };
    }),
  };
}

/**
 * The inputs to send for a dispatch, every value a string as GitHub takes them, or the problems with what was
 * given: an input the workflow does not declare, a required one missing with no default, a boolean that is not
 * true or false, a number that is not one, a choice outside its options.
 */
export function checkDispatchInputs(spec: DispatchSpec, given: Record<string, string>): { inputs: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const declared = new Map(spec.inputs.map((i) => [i.name, i]));
  for (const name of Object.keys(given)) if (!declared.has(name)) problems.push(`the workflow has no input named ${name}`);
  const inputs: Record<string, string> = {};
  for (const input of spec.inputs) {
    const value = given[input.name];
    if (value === undefined || value === "") {
      if (input.required && input.default === null) problems.push(`${input.name} is required`);
      continue;
    }
    if (input.type === "boolean" && value !== "true" && value !== "false") problems.push(`${input.name} must be true or false`);
    else if (input.type === "number" && !Number.isFinite(Number(value))) problems.push(`${input.name} must be a number`);
    else if (input.type === "choice" && input.options.length && !input.options.includes(value)) problems.push(`${input.name} must be one of ${input.options.join(", ")}`);
    inputs[input.name] = value;
  }
  if (Object.keys(inputs).length > MAX_DISPATCH_INPUTS) problems.push(`GitHub takes at most ${MAX_DISPATCH_INPUTS} inputs`);
  return { inputs, problems };
}
