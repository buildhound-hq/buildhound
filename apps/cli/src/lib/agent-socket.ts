import http from "node:http";

/** One answer from the Buildhound agent's Unix socket: the HTTP status and the parsed JSON body. */
export interface AgentAnswer {
  status: number;
  body: unknown;
}

/** One JSON request on the agent's Unix socket. Rejects when the agent does not answer or answers with something that is not JSON. */
export function agentRequest(socketPath: string, method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 60_000): Promise<AgentAnswer> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath, path: route, method, headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch {
            // An agent from before an endpoint existed answers Go's plain "404 page not found".
            resolve({ status: res.statusCode ?? 0, body: { text: text.slice(0, 200) } });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`the Buildhound agent did not answer in ${Math.round(timeoutMs / 1000)} seconds`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
