import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { prettyRepoIcon, type RepoIconResult } from "./commands/repo-icon";
import { stripAnsi } from "./lib/style";

const run = promisify(execFile);
const bin = inject("cliBin");
const emptyPath = mkdtempSync(path.join(tmpdir(), "buildhound-empty-path-"));
const files = mkdtempSync(path.join(tmpdir(), "buildhound-icons-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const pngPath = path.join(files, "icon.png");
const bigPath = path.join(files, "big.png");
const gifPath = path.join(files, "icon.gif");
writeFileSync(pngPath, PNG);
writeFileSync(bigPath, Buffer.alloc(262_145));
writeFileSync(gifPath, "GIF89a");

/** The control plane's icon state for acme/app, changed by PUT and DELETE as the API does. */
let state: { choice: string | null; custom: string | null };
const answer = (changed?: boolean) => ({
  role: "admin",
  repository: "acme/app",
  icon_url: state.choice === "custom" ? "https://api.example/v1/icons/abc" : state.choice === "owner" ? "https://github.com/acme.png?size=64" : "https://api.example/v1/icons/fav",
  icon_source: state.choice === "custom" ? "custom" : state.choice === "owner" ? "owner" : "homepage",
  choice: state.choice,
  homepage: "https://app.example.com",
  favicon: { state: "found", url: "https://api.example/v1/icons/fav", checked_at: "2026-10-18T10:00:00.000Z" },
  owner_url: "https://github.com/acme.png?size=64",
  custom_url: state.choice === "custom" ? "https://api.example/v1/icons/abc" : null,
  ...(changed === undefined ? {} : { changed }),
  next: "buildhound repo-icon --repo acme/app",
});

const requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c: string) => (text += c));
  req.on("end", () => {
    const body = text ? (JSON.parse(text) as { source?: string; image?: { data_base64: string } }) : null;
    requests.push({ method: req.method ?? "", path: req.url ?? "", body });
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { code: "UNAUTHENTICATED", message: "GitHub rejected the token", next: "run `gh auth login`" } });
    if (req.url !== "/v1/accounts/acme/repositories/app/icon") return send(404, { error: { code: "NOT_FOUND", message: "repository not found", next: "buildhound repos --org acme" } });
    if (req.method === "GET") return send(200, answer());
    const before = JSON.stringify(state);
    if (req.method === "DELETE") state = { choice: null, custom: null };
    if (req.method === "PUT") state = body?.source === "custom" ? { choice: "custom", custom: body.image!.data_base64 } : { choice: body!.source!, custom: null };
    send(200, answer(before !== JSON.stringify(state)));
  });
});
let apiUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests.length = 0;
  state = { choice: null, custom: null };
});

type Out = Record<string, unknown> & { error?: { code: string; message: string; next: string } };

/** No TTY, an empty PATH so `gh` cannot be found, and the fake control plane. */
async function cli(args: string[], token = "test-token") {
  const env = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: "", PATH: emptyPath, BUILDHOUND_API_URL: apiUrl };
  try {
    const { stdout } = await run(process.execPath, [bin, ...args, "--api-url", apiUrl], { env });
    expect(stdout.trim().split("\n"), "exactly one line of JSON on stdout").toHaveLength(1);
    return { code: 0, json: JSON.parse(stdout.trim()) as Out };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    expect(err.stdout.trim().split("\n"), "exactly one line of JSON on stdout").toHaveLength(1);
    expect(err.stdout).not.toMatch(/\n\s+at /);
    return { code: err.code, json: JSON.parse(err.stdout.trim()) as Out };
  }
}

describe("agentfirst: repo-icon", () => {
  it("agentfirst: repo-icon reads by default and changes nothing", async () => {
    const r = await cli(["repo-icon", "--repo", "acme/app"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: "read", repository: "acme/app", icon_source: "homepage", choice: null, next: "buildhound repo-icon --repo acme/app --file <icon.png>" });
    expect(requests.map((q) => q.method)).toEqual(["GET"]);
  });

  it("agentfirst: repo-icon --source and --file set it, and a repeat answers unchanged", async () => {
    const owner = await cli(["repo-icon", "--repo", "acme/app", "--source", "owner"]);
    expect(owner.json).toMatchObject({ status: "updated", choice: "owner", next: "buildhound repos --org acme" });
    expect(requests.at(-1)).toMatchObject({ method: "PUT", body: { source: "owner" } });
    expect((await cli(["repo-icon", "--repo", "acme/app", "--source", "owner"])).json).toMatchObject({ status: "unchanged" });
    const file = await cli(["repo-icon", "--repo", "acme/app", "--file", pngPath]);
    expect(file.json).toMatchObject({ status: "updated", icon_source: "custom" });
    expect(requests.at(-1)).toMatchObject({ method: "PUT", body: { source: "custom", image: { content_type: "image/png", data_base64: PNG.toString("base64") } } });
  });

  it("agentfirst: repo-icon --clear without --yes and without a TTY fails CONFIRM_REQUIRED and changes nothing", async () => {
    const r = await cli(["repo-icon", "--repo", "acme/app", "--clear"]);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatchObject({ code: "CONFIRM_REQUIRED", next: "buildhound repo-icon --repo acme/app --clear --yes" });
    expect(requests).toHaveLength(0);
    state = { choice: "custom", custom: "x" };
    expect((await cli(["repo-icon", "--repo", "acme/app", "--clear", "--yes"])).json).toMatchObject({ status: "cleared", choice: null });
    expect((await cli(["repo-icon", "--repo", "acme/app", "--clear", "--yes"])).json).toMatchObject({ status: "unchanged" });
  });

  it("agentfirst: bad usage and bad files fail with one JSON error and next, before any request", async () => {
    const cases: Array<[string[], string]> = [
      [["repo-icon"], "USAGE"],
      [["repo-icon", "--repo", "acme"], "USAGE"],
      [["repo-icon", "--repo", "acme/app", "--source", "favicon"], "USAGE"],
      [["repo-icon", "--repo", "acme/app", "--source", "custom"], "USAGE"],
      [["repo-icon", "--repo", "acme/app", "--source", "owner", "--clear"], "USAGE"],
      [["repo-icon", "--repo", "acme/app", "--file", path.join(files, "missing.png")], "FILE_NOT_FOUND"],
      [["repo-icon", "--repo", "acme/app", "--file", bigPath], "INVALID_IMAGE"],
      [["repo-icon", "--repo", "acme/app", "--file", gifPath], "INVALID_IMAGE"],
    ];
    for (const [args, code] of cases) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.json.error, args.join(" ")).toMatchObject({ code, next: expect.any(String) });
    }
    expect(requests).toHaveLength(0);
  });

  it("agentfirst: an API error keeps its code and next; no token is TOKEN_REQUIRED with exit 3", async () => {
    const missing = await cli(["repo-icon", "--repo", "acme/nope"]);
    expect(missing.json.error).toMatchObject({ code: "NOT_FOUND", next: "buildhound repos --org acme" });
    const none = await cli(["repo-icon", "--repo", "acme/app"], "");
    expect(none.code).toBe(3);
    expect(none.json.error).toMatchObject({ code: "TOKEN_REQUIRED" });
  });

  it("prints what shows and where it came from in a terminal", () => {
    state = { choice: null, custom: null };
    const text = stripAnsi(prettyRepoIcon({ ...(answer() as unknown as RepoIconResult), status: "read" }));
    expect(text).toContain("Icon for acme/app");
    expect(text).toContain("Homepage favicon (automatic)");
    expect(text).toContain("https://app.example.com, found");
  });
});
