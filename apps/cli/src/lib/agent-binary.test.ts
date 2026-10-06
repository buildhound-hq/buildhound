import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { downloadAgent } from "./agent-binary";

const binary = Buffer.from("#!/bin/sh\necho agent\n");
const sha = createHash("sha256").update(binary).digest("hex");
let latest = "0.3.0";
let corrupt = false;
const server = http.createServer((req, res) => {
  const files: Record<string, string | Buffer> = {
    "/agent/latest": `${latest}\n`,
    "/agent/v0.3.0/buildhound-agent-darwin-arm64": binary,
    "/agent/v0.3.0/buildhound-agent-darwin-arm64.sha256": corrupt ? "0".repeat(64) : `${sha}  buildhound-agent-darwin-arm64\n`,
  };
  const body = files[req.url ?? ""];
  res.writeHead(body === undefined ? 404 : 200);
  res.end(body ?? "");
});
let home = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.BUILDHOUND_DOWNLOADS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BUILDHOUND_RELEASE_URL = "";
  home = mkdtempSync(path.join(tmpdir(), "bh-agent-"));
  process.env.BUILDHOUND_AGENT_HOME = home;
});
afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  latest = "0.3.0";
  corrupt = false;
});

describe("downloadAgent", () => {
  const mac = { os: "macos", arch: "arm64" };

  it("downloads the version agent/latest names and verifies it", async () => {
    const file = await downloadAgent(mac, "buildhound runner add");
    expect(readFileSync(file)).toEqual(binary);
  });

  it("refuses a binary whose checksum differs", async () => {
    corrupt = true;
    await expect(downloadAgent(mac, "buildhound runner add")).rejects.toMatchObject({ code: "AGENT_CHECKSUM_MISMATCH" });
  });

  it("refuses an agent/latest that is not a version, with a next step", async () => {
    latest = "<html>";
    await expect(downloadAgent(mac, "buildhound runner add")).rejects.toMatchObject({ code: "AGENT_DOWNLOAD_FAILED", next: expect.stringContaining("--agent-binary") });
  });
});
