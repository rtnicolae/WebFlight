/**
 * Fetch FGAddon aircraft folders over HTTP, from SourceForge's SVN server (svn.code.sf.net:
 * folder listings are plain HTML lists, files are served as they are) or, where that host isn't
 * reachable, from the Allura tree browser (listings as HTML pages, files with `?format=raw`).
 * The browser's tree pages answered 404 from November 2026 (every fresh checkout and CI failed
 * to get the aircraft); whichever source answers first is used from then on.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const FGADDON_SVN = "https://svn.code.sf.net/p/flightgear/fgaddon/trunk/Aircraft/";
export const FGADDON_TREE = "https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/";

export interface ListingEntry {
  name: string;
  kind: "dir" | "file";
}

export interface FetchOptions {
  /** Destination root; the aircraft lands in `<dest>/<aircraft>/`. */
  dest: string;
  /**
   * Only fetch paths (relative to the aircraft folder) that start with one of these
   * prefixes. Folders on the way to a prefix are still listed. Empty = everything.
   */
  only?: readonly string[];
  concurrency?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, tries = 5): Promise<Response | null> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (res.status === 404) return null;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000 * 2 ** i);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Parse a folder listing into its child entries: an SVN server's (`<li><a href="name/">`,
 * folders ending in "/") or an Allura tree page's.
 */
export function parseListing(html: string): ListingEntry[] {
  const out: ListingEntry[] = [];
  const allura = /<a class="icon" href="([^"]+)"[^>]*><i class="fa (fa-folder|fa-file-o)"/g;
  for (const m of html.matchAll(allura)) out.push({ name: decodeURIComponent(m[1]!), kind: m[2] === "fa-folder" ? "dir" : "file" });
  if (out.length) return out;
  for (const m of html.matchAll(/<li><a href="([^"]+)">/g)) {
    const href = m[1]!;
    if (href === "../" || href.startsWith("/") || href.includes("://")) continue;
    const dir = href.endsWith("/");
    out.push({ name: decodeURIComponent(dir ? href.slice(0, -1) : href), kind: dir ? "dir" : "file" });
  }
  return out;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Where listings and files come from: the SVN server, else the tree browser. */
const SOURCES = [
  { list: (rel: string) => FGADDON_SVN + encodePath(rel) + "/", file: (rel: string) => FGADDON_SVN + encodePath(rel) },
  { list: (rel: string) => FGADDON_TREE + encodePath(rel) + "/", file: (rel: string) => `${FGADDON_TREE}${encodePath(rel)}?format=raw` },
];
let source: (typeof SOURCES)[number] | undefined;

export async function listDir(relPath: string): Promise<ListingEntry[]> {
  let lastErr: unknown;
  for (const s of source ? [source] : SOURCES) {
    try {
      const res = await fetchWithRetry(s.list(relPath), source ? 5 : 2);
      if (!res) continue;
      source = s;
      return parseListing(await res.text());
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`FGAddon folder not found: ${relPath}${lastErr ? ` (${lastErr instanceof Error ? lastErr.message : lastErr})` : ""}`);
}

function wanted(rel: string, kind: "dir" | "file", only: readonly string[] | undefined): boolean {
  if (!only || only.length === 0) return true;
  return only.some((p) => rel.startsWith(p) || (kind === "dir" && p.startsWith(rel + "/")));
}

/** Download an aircraft folder (or the parts selected by `only`). Existing files are kept. */
export async function fetchAircraft(aircraft: string, opts: FetchOptions): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const root = path.join(opts.dest, aircraft);
  const files: string[] = [];

  const walk = async (rel: string): Promise<void> => {
    const entries = await listDir(rel ? `${aircraft}/${rel}` : aircraft);
    const subdirs: Promise<void>[] = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (!wanted(childRel, e.kind, opts.only)) continue;
      if (e.kind === "dir") subdirs.push(walk(childRel));
      else files.push(childRel);
    }
    await Promise.all(subdirs);
  };
  await walk("");
  log(`${aircraft}: ${files.length} files`);

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const rel = files[next++]!;
      const target = path.join(root, rel);
      const exists = await fs.stat(target).then(() => true, () => false);
      if (!exists) {
        const res = await fetchWithRetry((source ?? SOURCES[0]!).file(`${aircraft}/${rel}`));
        if (!res) throw new Error(`listed file missing: ${rel}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
        await fs.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
        await fs.rename(tmp, target);
      }
      if (++done % 25 === 0) log(`  ${done}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return files;
}
