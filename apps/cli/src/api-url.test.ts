import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API_URL, resolveApiUrl } from "./lib/api";
import { CliError } from "./output";

const saved = { buildhound: process.env.BUILDHOUND_API_URL, generic: process.env.API_URL };

afterEach(() => {
  for (const [key, value] of [["BUILDHOUND_API_URL", saved.buildhound], ["API_URL", saved.generic]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Every request carries the person's GitHub token, so where it goes is checked (found in an abuse review).
describe("the control plane URL the CLI and MCP server send the GitHub token to", () => {
  it("never reads a project's generic API_URL", () => {
    delete process.env.BUILDHOUND_API_URL;
    process.env.API_URL = "https://api.someone-elses-app.com";
    expect(resolveApiUrl(undefined)).toBe(DEFAULT_API_URL);
  });

  it("takes --api-url, then BUILDHOUND_API_URL, without a trailing slash", () => {
    process.env.BUILDHOUND_API_URL = "https://staging.buildhound.sh/";
    expect(resolveApiUrl(undefined)).toBe("https://staging.buildhound.sh");
    expect(resolveApiUrl("https://api.buildhound.sh")).toBe("https://api.buildhound.sh");
  });

  it("allows http only on this machine", () => {
    expect(resolveApiUrl("http://localhost:3011")).toBe("http://localhost:3011");
    expect(resolveApiUrl("http://127.0.0.1:3011")).toBe("http://127.0.0.1:3011");
    expect(() => resolveApiUrl("http://api.example.com")).toThrow(CliError);
    expect(() => resolveApiUrl("not a url")).toThrow(CliError);
  });
});
