import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-memory GitHub for tests of `scan --fix`: repositories, refs, commits, trees, the Contents API and pull
 * requests, enough of the REST API that the fix flow runs end to end with nothing reaching github.com. Use `fetch`
 * in-process, or `listen()` and point GITHUB_API_URL at it for a CLI child process. Only tests import this file.
 */

interface Commit { sha: string; tree: string; parents: string[]; message: string }
interface Pull { number: number; title: string; body: string | null; head: string; base: string; state: "open" | "closed"; merged_at: string | null; html_url: string }

export interface FakeRepoInit {
  owner: string;
  name: string;
  defaultBranch?: string;
  private?: boolean;
  push?: boolean;
  archived?: boolean;
  /** Files on the default branch, by path. */
  files: Record<string, string>;
}

export interface FakeCall { method: string; path: string; body?: unknown }

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub {
  readonly calls: FakeCall[] = [];
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly pulls: Pull[] = [];
  /** Set to make writes fail like a token without the workflow scope. */
  refuseWorkflowWrites = false;
  repo: Required<Omit<FakeRepoInit, "files">>;
  private seq = 0;

  constructor(init: FakeRepoInit) {
    this.repo = { owner: init.owner, name: init.name, defaultBranch: init.defaultBranch ?? "main", private: init.private ?? true, push: init.push ?? true, archived: init.archived ?? false };
    const tree = this.putTree(new Map(Object.entries(init.files)));
    const commit = this.putCommit(tree, [], "Initial commit");
    this.refs.set(this.repo.defaultBranch, commit);
  }

  private putTree(files: Map<string, string>): string {
    const sha = sha1(`tree ${[...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => `${p}\0${c}`).join("\0")}`);
    this.trees.set(sha, files);
    return sha;
  }

  private putCommit(tree: string, parents: string[], message: string): string {
    const sha = sha1(`commit ${tree} ${parents.join(",")} ${message} ${this.seq++}`);
    this.commits.set(sha, { sha, tree, parents, message });
    return sha;
  }

  /** Move the default branch on, as if someone merged something. */
  commitToDefault(files: Record<string, string>, message = "Change"): string {
    const head = this.commits.get(this.refs.get(this.repo.defaultBranch)!)!;
    const next = new Map(this.trees.get(head.tree)!);
    for (const [p, c] of Object.entries(files)) next.set(p, c);
    const sha = this.putCommit(this.putTree(next), [head.sha], message);
    this.refs.set(this.repo.defaultBranch, sha);
    return sha;
  }

  /** A file's content at a branch or commit, or undefined. */
  fileAt(refOrSha: string, path: string): string | undefined {
    const commit = this.commits.get(this.refs.get(refOrSha) ?? refOrSha);
    return commit ? this.trees.get(commit.tree)?.get(path) : undefined;
  }

  addPull(p: Omit<Pull, "number" | "html_url">): Pull {
    const number = this.pulls.length + 1;
    const pull = { ...p, number, html_url: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${number}` };
    this.pulls.push(pull);
    return pull;
  }

  /** The writes, in order, as `METHOD path`. */
  writes(): string[] {
    return this.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  }

  handle(method: string, url: URL, body: unknown): { status: number; json: unknown } {
    const path = decodeURIComponent(url.pathname);
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const prefix = `/repos/${this.repo.owner}/${this.repo.name}`;
    const nf = { status: 404, json: { message: "Not Found" } };
    if (!path.startsWith(prefix)) return nf;
    const rest = path.slice(prefix.length);
    const b = (body ?? {}) as Record<string, unknown>;
    const write = method !== "GET";
    if (write && !this.repo.push) return { status: 404, json: { message: "Not Found" } };

    if (rest === "" && method === "GET") {
      return { status: 200, json: { full_name: `${this.repo.owner}/${this.repo.name}`, default_branch: this.repo.defaultBranch, private: this.repo.private, archived: this.repo.archived, permissions: { admin: false, maintain: false, push: this.repo.push, pull: true } } };
    }
    // Run history: the workflows on the default branch and no runs, so a scan with --repo prices from defaults.
    if (rest === "/actions/workflows" && method === "GET") {
      const files = [...this.trees.get(this.commits.get(this.refs.get(this.repo.defaultBranch)!)!.tree)!.keys()].filter((p) => p.startsWith(".github/workflows/"));
      return { status: 200, json: { total_count: files.length, workflows: files.map((p, i) => ({ id: i + 1, name: p, path: p, state: "active" })) } };
    }
    if (rest === "/actions/runs" && method === "GET") return { status: 200, json: { total_count: 0, workflow_runs: [] } };
    if (rest.startsWith("/git/ref/heads/") && method === "GET") {
      const sha = this.refs.get(rest.slice("/git/ref/heads/".length));
      return sha ? { status: 200, json: { ref: `refs/heads/${rest.slice(15)}`, object: { sha, type: "commit" } } } : nf;
    }
    if (rest.startsWith("/git/commits/") && method === "GET") {
      const c = this.commits.get(rest.slice("/git/commits/".length));
      return c ? { status: 200, json: { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) } } : nf;
    }
    if (rest === "/git/trees" && method === "POST") {
      const entries = (b.tree ?? []) as Array<{ path: string; content: string }>;
      if (this.refuseWorkflowWrites && entries.some((e) => e.path.startsWith(".github/workflows/"))) {
        return { status: 404, json: { message: "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope" } };
      }
      const files = new Map(this.trees.get(String(b.base_tree)) ?? []);
      for (const e of entries) files.set(e.path, e.content);
      return { status: 201, json: { sha: this.putTree(files) } };
    }
    if (rest === "/git/commits" && method === "POST") {
      return { status: 201, json: { sha: this.putCommit(String(b.tree), (b.parents ?? []) as string[], String(b.message)) } };
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(b.ref).replace(/^refs\/heads\//, "");
      if (this.refs.has(name)) return { status: 422, json: { message: "Reference already exists" } };
      this.refs.set(name, String(b.sha));
      return { status: 201, json: { ref: b.ref, object: { sha: b.sha } } };
    }
    if (rest.startsWith("/git/refs/heads/") && method === "PATCH") {
      const name = rest.slice("/git/refs/heads/".length);
      if (!this.refs.has(name)) return { status: 422, json: { message: "Reference does not exist" } };
      this.refs.set(name, String(b.sha));
      return { status: 200, json: { object: { sha: b.sha } } };
    }
    if (rest.startsWith("/contents/") && method === "GET") {
      const p = rest.slice("/contents/".length);
      const ref = url.searchParams.get("ref") ?? this.repo.defaultBranch;
      const commit = this.commits.get(this.refs.get(ref) ?? ref);
      const files = commit ? this.trees.get(commit.tree)! : null;
      if (!files) return nf;
      const content = files.get(p);
      if (content !== undefined) return { status: 200, json: { type: "file", path: p, name: p.split("/").pop(), encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") } };
      const inDir = [...files.keys()].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes("/"));
      return inDir.length ? { status: 200, json: inDir.map((f) => ({ type: "file", path: f, name: f.split("/").pop() })) } : nf;
    }
    // Three-dot compare: the files the head changed since its merge base with the base.
    const cmp = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
    if (cmp && method === "GET") {
      const ancestors = new Set<string>();
      for (const stack = [cmp[1]!]; stack.length; ) {
        const c = this.commits.get(stack.pop()!);
        if (c && !ancestors.has(c.sha)) { ancestors.add(c.sha); stack.push(...c.parents); }
      }
      let mb = this.commits.get(cmp[2]!);
      while (mb && !ancestors.has(mb.sha)) mb = this.commits.get(mb.parents[0] ?? "");
      const head = this.commits.get(cmp[2]!);
      if (!mb || !head) return nf;
      const from = this.trees.get(mb.tree)!, to = this.trees.get(head.tree)!;
      const names = [...new Set([...from.keys(), ...to.keys()])].filter((p) => from.get(p) !== to.get(p)).sort();
      return { status: 200, json: { merge_base_commit: { sha: mb.sha }, files: names.map((filename) => ({ filename, status: from.has(filename) ? (to.has(filename) ? "modified" : "removed") : "added" })) } };
    }
    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const state = url.searchParams.get("state") ?? "open";
      const found = this.pulls.filter((p) => (!head || p.head === head) && (state === "all" || p.state === state)).reverse();
      return { status: 200, json: found };
    }
    if (rest === "/pulls" && method === "POST") {
      if (!this.refs.has(String(b.head))) return { status: 422, json: { message: "head does not exist" } };
      if (this.pulls.some((p) => p.head === b.head && p.state === "open")) return { status: 422, json: { message: "A pull request already exists" } };
      const p = this.addPull({ title: String(b.title), body: (b.body as string) ?? null, head: String(b.head), base: String(b.base), state: "open", merged_at: null });
      return { status: 201, json: p };
    }
    const m = /^\/pulls\/(\d+)$/.exec(rest);
    if (m && method === "PATCH") {
      const p = this.pulls.find((x) => x.number === Number(m[1]));
      if (!p) return nf;
      if (typeof b.title === "string") p.title = b.title;
      if (typeof b.body === "string") p.body = b.body;
      return { status: 200, json: p };
    }
    return nf;
  }

  /** A Fetch API function over this fake, for the GitHub client in-process. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const r = this.handle(init?.method ?? "GET", url, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  /** Serve over HTTP on 127.0.0.1 for a child process; returns the base URL and a close function. */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const r = this.handle(req.method ?? "GET", url, raw ? (JSON.parse(raw) as unknown) : undefined);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }
}
