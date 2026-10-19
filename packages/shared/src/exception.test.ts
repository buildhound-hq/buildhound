import { describe, expect, it } from "vitest";
import { exceptionList, scrubErrorText, stackFrames } from "./exception";

describe("server error text", () => {
  it("drops query parameters and everything after the first line", () => {
    expect(scrubErrorText("Failed query: select * from accounts where login = $1\nparams: octocat")).toBe("Failed query: select * from accounts where login = $1");
    expect(scrubErrorText("first\nsecond")).toBe("first");
  });

  it("redacts tokens, credentials, addresses and URL paths", () => {
    expect(scrubErrorText("bad ghs_abc123DEF456 for app")).toBe("bad [token] for app");
    expect(scrubErrorText("github_pat_11ABCDEF_xyz")).toBe("[token]");
    expect(scrubErrorText("sent Bearer abc.def-ghi")).toBe("sent Bearer [token]");
    expect(scrubErrorText("jwt eyJhbGciOi.eyJzdWIi.c2ln failed")).toBe("jwt [token] failed");
    expect(scrubErrorText("mail to octo@example.com bounced")).toBe("mail to [email] bounced");
    expect(scrubErrorText("GET https://api.github.com/repos/acme/secret-app/actions failed")).toBe("GET https://api.github.com/… failed");
    expect(scrubErrorText("connect postgres://user:pw@db.example.com:5432/x refused")).toBe("connect postgres://db.example.com:5432/… refused");
    expect(scrubErrorText(`key ${"a".repeat(40)} rejected`)).toBe("key [redacted] rejected");
  });

  it("keeps ordinary messages and shortens long ones", () => {
    expect(scrubErrorText("Unexpected token < in JSON at position 0")).toBe("Unexpected token < in JSON at position 0");
    expect(scrubErrorText("x ".repeat(400))).toHaveLength(300);
  });
});

describe("exception list", () => {
  it("parses V8 frames innermost last", () => {
    const frames = stackFrames("Error: boom\n    at inner (src/app.ts:10:5)\n    at async outer (node_modules/hono/dist/x.js:3:1)\n    at file:///w/index.js?v=1:7:2");
    expect(frames.map((f) => [f.function, f.filename, f.lineno, f.in_app])).toEqual([
      ["?", "file:///w/index.js", 7, true],
      ["async outer", "node_modules/hono/dist/x.js", 3, false],
      ["inner", "src/app.ts", 10, true],
    ]);
  });

  it("lists the error and its causes, scrubbed", () => {
    const error = new Error("query failed\nparams: acme", { cause: new TypeError("token ghp_abc leaked") });
    const list = exceptionList(error, "onError");
    expect(list.map((e) => [e.type, e.value])).toEqual([
      ["Error", "query failed"],
      ["TypeError", "token [token] leaked"],
    ]);
    expect(list[0]?.mechanism).toEqual({ type: "onError", handled: false, synthetic: false });
    expect(list[0]?.stacktrace?.type).toBe("raw");
  });

  it("handles a thrown string", () => {
    expect(exceptionList("nope", "onError")).toEqual([{ type: "Error", value: "nope", mechanism: { type: "onError", handled: false, synthetic: false } }]);
  });
});
