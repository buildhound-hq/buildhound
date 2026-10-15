import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ago, color, colorEnabled, duration, fields, money, monthName, needed, next, resultSymbol, stripAnsi, table } from "./style";

const env = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(v: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
}

beforeEach(() => {
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
});

afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("colour", () => {
  it("colours only in a terminal, never with NO_COLOR or TERM=dumb", () => {
    setTTY(true);
    expect(colorEnabled()).toBe(true);
    expect(color.green("✓")).toBe("\x1b[32m✓\x1b[39m");
    process.env.NO_COLOR = "1";
    expect(color.green("✓")).toBe("✓");
    expect(resultSymbol("failure")).toBe("X");
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    expect(next("buildhound jobs")).toBe("Next: buildhound jobs");
    process.env.TERM = "xterm";
    setTTY(false);
    expect(color.dim("x")).toBe("x");
  });
});

describe("resultSymbol", () => {
  it("maps results to gh's symbols", () => {
    setTTY(false);
    expect(resultSymbol("success")).toBe("✓");
    expect(resultSymbol("failure")).toBe("X");
    expect(resultSymbol("cancelled")).toBe("-");
    expect(resultSymbol("skipped")).toBe("-");
    expect(resultSymbol("running")).toBe("*");
    expect(resultSymbol("waiting")).toBe("*");
    expect(resultSymbol(null)).toBe("-");
  });

  it("colours success green, failure red, running yellow and leaves cancelled plain", () => {
    setTTY(true);
    expect(resultSymbol("success")).toContain("\x1b[32m");
    expect(resultSymbol("failure")).toContain("\x1b[31m");
    expect(resultSymbol("running")).toContain("\x1b[33m");
    expect(resultSymbol("cancelled")).toBe("-");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const before = (s: number) => now - s * 1000;
  it("words relative times the way gh does", () => {
    expect(ago(before(20), now)).toBe("just now");
    expect(ago(before(60), now)).toBe("about 1 minute ago");
    expect(ago(before(3 * 60 + 30), now)).toBe("about 3 minutes ago");
    expect(ago(before(3600 + 1200), now)).toBe("about 1 hour ago");
    expect(ago(before(5 * 3600), now)).toBe("about 5 hours ago");
    expect(ago(before(2 * 86400 + 100), now)).toBe("about 2 days ago");
    expect(ago(before(95 * 86400), now)).toBe("about 3 months ago");
    expect(ago(before(800 * 86400), now)).toBe("about 2 years ago");
    expect(ago("2026-10-15T11:57:00Z", now)).toBe("about 3 minutes ago");
    expect(ago(null, now)).toBe("");
    expect(ago(now + 5000, now)).toBe("just now");
  });
});

describe("formats", () => {
  it("prints durations, money and months for people", () => {
    expect(duration(4)).toBe("4s");
    expect(duration(145)).toBe("2m 25s");
    expect(duration(3720)).toBe("1h 2m");
    expect(duration(null)).toBe("");
    expect(money(2)).toBe("$0.02");
    expect(money(-5760)).toBe("-$57.60");
    expect(money(null)).toBe("");
    expect(monthName("2026-10")).toBe("October 2026");
    expect(monthName("2026-10-01T00:00:00.000Z")).toBe("October 2026");
  });

  it("aligns key and value lines and leaves out empty values", () => {
    expect(fields([["Plan", "Personal"], ["Waited", ""], ["Status", "Active"]])).toEqual(["Plan    Personal", "Status  Active"]);
  });

  it("says why a person is needed, then what to act on, indented", () => {
    setTTY(false);
    expect(needed("Install the GitHub App.", "https://github.com/apps/x", "")).toEqual(["! Install the GitHub App.", "  https://github.com/apps/x"]);
  });
});

describe("table", () => {
  it("uppercases headers, separates columns by two spaces and right-aligns numbers", () => {
    setTTY(false);
    const lines = table(["", "job", "took"], [["✓", "go", "4s"], ["X", "typescript", "2m 25s"]], { right: [2] });
    expect(lines).toEqual(["   JOB           TOOK", "✓  go              4s", "X  typescript  2m 25s"]);
  });

  it("keeps empty cells empty and trims the end of each line", () => {
    const lines = table(["a", "b"], [["x", ""]]);
    expect(lines).toEqual(["A  B", "x"]);
  });

  it("measures coloured cells by what shows", () => {
    setTTY(true);
    const lines = table(["", "job"], [[resultSymbol("success"), "go"]], { width: 200 });
    expect(stripAnsi(lines[1]!)).toBe("✓  go");
  });

  it("truncates the widest text column so a row fits the width", () => {
    setTTY(false);
    const long = "a-very-long-repository-name-that-goes-on-and-on";
    const lines = table(["repo", "machine", "cost"], [[long, "mini", "$1.00"]], { width: 40, right: [2] });
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    expect(lines[1]).toBe("a-very-long-repositor...  mini     $1.00");
  });

  it("does not truncate outside a terminal unless a width is given", () => {
    setTTY(false);
    const long = "x".repeat(300);
    expect(table(["a"], [[long]])[1]).toBe(long);
  });
});
