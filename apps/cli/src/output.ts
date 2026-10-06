import { EXIT } from "@buildhound/shared";

/** JSON when stdout is not a TTY or --json is passed; one object on stdout, logs on stderr (AGENT_FIRST.md rule 1). */
export function wantsJson(opts: { json?: boolean | undefined } = {}): boolean {
  return Boolean(opts.json) || !process.stdout.isTTY;
}

export function emit(value: unknown, opts: { json?: boolean | undefined } = {}, pretty?: (v: never) => string): void {
  if (wantsJson(opts) || !pretty) {
    process.stdout.write(JSON.stringify(value) + "\n");
  } else {
    process.stdout.write(pretty(value as never) + "\n");
  }
}

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly next: string,
    public readonly exitCode: number = EXIT.usage,
    public readonly example?: string,
  ) {
    super(message);
  }
}

/** Every error carries code, message and the next command (AGENT_FIRST.md rule 5). Never a stack trace. */
export function fail(err: unknown): never {
  const e = err instanceof CliError ? err : new CliError("INTERNAL", err instanceof Error ? err.message : String(err), "buildhound --help", EXIT.usage);
  const envelope = { error: { code: e.code, message: e.message, next: e.next, ...(e.example ? { example: e.example } : {}) } };
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(e.exitCode);
}
