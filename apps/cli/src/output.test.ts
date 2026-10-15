import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, fail } from "./output";

const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const argv = process.argv;
const noColor = process.env.NO_COLOR;

function capture(isTTY: boolean, args: string[] = []) {
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  process.argv = [argv[0]!, argv[1]!, ...args];
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  expect(() => fail(new CliError("USAGE", "pass --org <login>", "buildhound jobs --org <login>", 2))).toThrow("exit");
  return { stdout: out.mock.calls.map((c) => String(c[0])).join(""), stderr: err.mock.calls.map((c) => String(c[0])).join(""), code: exit.mock.calls[0]?.[0] };
}

beforeEach(() => {
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = argv;
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("fail", () => {
  it("agentfirst: prints the JSON envelope on stdout without a TTY", () => {
    const r = capture(false, ["jobs"]);
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: "USAGE", message: "pass --org <login>", next: "buildhound jobs --org <login>" } });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(2);
  });

  it("agentfirst: prints the JSON envelope in a terminal when --json is passed", () => {
    const r = capture(true, ["jobs", "--json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("USAGE");
    expect(r.code).toBe(2);
  });

  it("tells a person in a terminal what failed and what to run next, on stderr", () => {
    const r = capture(true, ["jobs"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("X pass --org <login>\n\nNext: buildhound jobs --org <login>\n");
    expect(r.code).toBe(2);
  });
});
