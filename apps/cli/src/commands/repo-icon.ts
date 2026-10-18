import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Command } from "commander";
import { EXIT, ICON_MAX_BYTES, type RepositoryIconResponse } from "@buildhound/shared";
import { ApiClient } from "../lib/api";
import { confirm } from "../lib/confirm";
import { CliError, emit } from "../output";
import { color, done, fields, next } from "../lib/style";

// A repository's icon in the dashboard (DASHBOARD.md, Repository icons; CONTROL_PLANE_API.md). Read only by default;
// `--source` or `--file` sets it (admins), `--clear --yes` drops what was set, uploaded image included, and goes back to
// the homepage's favicon, else the owner's picture. Setting the same thing again changes nothing and records nothing.

export interface RepoIconOptions {
  repo?: string | undefined;
  source?: string | undefined;
  file?: string | undefined;
  clear?: boolean | undefined;
  apiUrl?: string | undefined;
  token?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
}

export type RepoIconResult = RepositoryIconResponse & { status: "read" | "updated" | "unchanged" | "cleared" };

const REPOSITORY = /^([^/\s]+)\/([\w.-]+)$/;
const enc = encodeURIComponent;
const TYPES: Record<string, string> = { ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function parse(opts: RepoIconOptions): { owner: string; name: string; full: string } {
  const m = REPOSITORY.exec(opts.repo ?? "");
  if (!m) throw new CliError("USAGE", opts.repo ? `--repo must be owner/name, not ${opts.repo}` : "pass --repo <owner/name>", "buildhound repo-icon --repo <owner/name>", EXIT.usage);
  const full = `${m[1]}/${m[2]}`;
  const set = [opts.source !== undefined, opts.file !== undefined, opts.clear === true].filter(Boolean).length;
  if (set > 1 && !(opts.file !== undefined && opts.source === "custom" && !opts.clear)) {
    throw new CliError("USAGE", "pass one of --source, --file or --clear", `buildhound repo-icon --repo ${full} --file <icon.png>`, EXIT.usage);
  }
  if (opts.source !== undefined && !["homepage", "owner", "custom"].includes(opts.source)) {
    throw new CliError("USAGE", `--source is homepage or owner, not ${opts.source}; pass --file for your own image`, `buildhound repo-icon --repo ${full} --source homepage`, EXIT.usage);
  }
  if (opts.source === "custom" && opts.file === undefined) throw new CliError("USAGE", "--source custom needs --file <image>", `buildhound repo-icon --repo ${full} --file <icon.png>`, EXIT.usage);
  return { owner: m[1]!, name: m[2]!, full };
}

/** The image as the API takes it, checked here too so a wrong file fails before any upload. */
async function readImage(path: string, full: string): Promise<{ content_type: string; data_base64: string }> {
  const retry = `buildhound repo-icon --repo ${full} --file <icon.png>`;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new CliError("FILE_NOT_FOUND", `no file at ${path}`, retry, EXIT.usage);
  }
  if (size > ICON_MAX_BYTES) throw new CliError("INVALID_IMAGE", `${path} is over 256 KB`, "use a square PNG, SVG, ICO, WebP or JPEG up to 256 KB", EXIT.usage);
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) throw new CliError("INVALID_IMAGE", `${path} is not a PNG, SVG, ICO, WebP or JPEG`, "use a square PNG, SVG, ICO, WebP or JPEG up to 256 KB", EXIT.usage);
  return { content_type: type, data_base64: (await readFile(path)).toString("base64") };
}

export async function runRepoIcon(opts: RepoIconOptions): Promise<RepoIconResult> {
  const { owner, name, full } = parse(opts);
  const path = `/v1/accounts/${enc(owner)}/repositories/${enc(name)}/icon`;
  const base = `buildhound repo-icon --repo ${full}`;
  if (opts.clear) {
    await confirm(opts.yes, `Clear the icon set for ${full}? An uploaded image is dropped, and it shows its homepage's favicon, else its owner's picture.`, `${base} --clear`);
    const r = await ApiClient.forCommand(opts, `${base} --clear --yes`).expect<RepositoryIconResponse>("DELETE", path, undefined, `${base} --clear --yes`);
    return { ...r, status: r.changed ? "cleared" : "unchanged", next: base };
  }
  if (opts.file !== undefined || opts.source !== undefined) {
    const image = opts.file !== undefined ? await readImage(opts.file, full) : undefined;
    const retry = opts.file !== undefined ? `${base} --file ${opts.file}` : `${base} --source ${opts.source}`;
    const r = await ApiClient.forCommand(opts, retry).expect<RepositoryIconResponse>("PUT", path, { source: image ? "custom" : opts.source, ...(image ? { image } : {}) }, retry);
    return { ...r, status: r.changed ? "updated" : "unchanged", next: `buildhound repos --org ${owner}` };
  }
  const r = await ApiClient.forCommand(opts, base).expect<RepositoryIconResponse>("GET", path, undefined, base);
  return { ...r, status: "read", next: r.role === "admin" ? `${base} --file <icon.png>` : `buildhound repos --org ${owner}` };
}

const SOURCE = { custom: "Uploaded image", homepage: "Homepage favicon", owner: "Owner picture" } as const;
const FAVICON = { found: "found", none: "no icon on the homepage", blocked: "the homepage's address is not allowed", error: "the homepage could not be read", no_homepage: "no homepage set on GitHub", pending: "not read yet" } as const;

export function prettyRepoIcon(r: RepoIconResult): string {
  const head = r.status === "updated" ? done(`Icon for ${r.repository} set to ${SOURCE[r.icon_source].toLowerCase()}`) : r.status === "cleared" ? done(`Icon for ${r.repository} cleared`) : r.status === "unchanged" ? `Icon for ${r.repository} unchanged` : `Icon for ${r.repository}`;
  return [
    head,
    "",
    ...fields([
      ["Shown", `${SOURCE[r.icon_source]}${r.choice ? "" : color.dim(" (automatic)")}`],
      ["Image", r.icon_url],
      ["Homepage", r.homepage ? `${r.homepage}, ${FAVICON[r.favicon.state]}` : FAVICON.no_homepage],
    ]),
    "",
    next(r.next),
  ].join("\n");
}

export function repoIconCommand(): Command {
  return new Command("repo-icon")
    .description("A repository's icon in the dashboard: show it, set it to its homepage's favicon, its owner's picture or your own image, or clear it (admins)")
    .option("--repo <owner/name>", "the repository")
    .option("--source <source>", "homepage or owner: show that image and drop an uploaded one")
    .option("--file <path>", "upload your own square PNG, SVG, ICO, WebP or JPEG, up to 256 KB")
    .option("--clear", "drop what was set: show the homepage's favicon, else the owner's picture")
    .option("--yes", "clear without asking; required with --clear when there is no TTY")
    .option("--api-url <url>", "control plane URL")
    .option("--token <token>", "GitHub token; else GITHUB_TOKEN, else `gh auth token`")
    .option("--json", "JSON output")
    .action(async (opts: RepoIconOptions) => {
      emit(await runRepoIcon(opts), opts, prettyRepoIcon);
    });
}
