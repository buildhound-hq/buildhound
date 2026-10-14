import { describe, expect, it } from "vitest";
import { SessionExpiredError, acquireJobs, getActionsAdmin, getMessage } from "./actions-service";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, ...(init?.body ? { body: String(init.body) } : {}) };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.s`;
const session = { messageQueueUrl: "https://broker.test/message", messageQueueAccessToken: "q" };

describe("Actions service client", () => {
  it("trades an installation token for an admin connection through a registration token", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.endsWith("/registration-token") ? new Response(JSON.stringify({ token: "reg" }), { status: 201 }) : new Response(JSON.stringify({ url: "https://pipelines.test/t/", token: jwt(1_900_000_000) }), { status: 200 }),
    );
    const admin = await getActionsAdmin("ghs_x", "https://github.com/BenyD/site", { fetch });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.github.com/repos/BenyD/site/actions/runners/registration-token", "POST https://api.github.com/actions/runner-registration"]);
    expect(calls[1]!.headers.authorization).toBe("RemoteAuth reg");
    expect(admin).toEqual({ url: "https://pipelines.test/t/", token: jwt(1_900_000_000), expiresAt: new Date(1_900_000_000_000).toISOString() });
  });

  it("parses a message's batched jobs and drops a byte order mark", async () => {
    const body = JSON.stringify([{ messageType: "JobAvailable", runnerRequestId: 7, jobDisplayName: "test" }]);
    const { fetch, calls } = fakeFetch(() => new Response("﻿" + JSON.stringify({ messageId: 3, messageType: "RunnerScaleSetJobMessages", body, statistics: { totalAvailableJobs: 1 } }), { status: 200 }));
    const message = await getMessage(session, 2, 4, { fetch });
    expect(message).toEqual({ messageId: 3, statistics: { totalAvailableJobs: 1 }, jobs: [{ messageType: "JobAvailable", runnerRequestId: 7, jobDisplayName: "test" }] });
    expect(calls[0]!.url).toBe("https://broker.test/message?lastMessageId=2");
    expect(calls[0]!.headers["x-scalesetmaxcapacity"]).toBe("4");
  });

  it("reads 202 as no message and 401 as an expired session", async () => {
    expect(await getMessage(session, 0, 1, { fetch: fakeFetch(() => new Response(null, { status: 202 })).fetch })).toBeNull();
    await expect(getMessage(session, 0, 1, { fetch: fakeFetch(() => new Response(null, { status: 401 })).fetch })).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("acquires with the session's token, not the admin token", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ count: 1, value: [7] }), { status: 200 }));
    expect(await acquireJobs({ url: "https://pipelines.test/t/" }, "q", 12, [7, 8], { fetch })).toEqual([7]);
    expect(calls[0]!.url).toBe("https://pipelines.test/t/_apis/runtime/runnerscalesets/12/acquirejobs?api-version=6.0-preview");
    expect(calls[0]!.headers.authorization).toBe("Bearer q");
  });
});
