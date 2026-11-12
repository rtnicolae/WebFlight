/**
 * On-demand FGData (FlightGear's shared base data: Aircraft/Generic, Aircraft/Instruments-3d,
 * Nasal libraries, ...) fetched file by file from the GitLab mirror into a local cache.
 * FGData is GPL-2.0-or-later, like most aircraft.
 */
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.ts";

export const FGDATA_REF = "next";
export const FGDATA_RAW = `https://gitlab.com/flightgear/fgdata/-/raw/${FGDATA_REF}/`;

export const defaultFgdataDir = (): string =>
  process.env["WEBFLIGHT_FGDATA_CACHE"] ?? path.join(repoRoot(), ".cache", "fgdata");

const NOT_FOUND_FILE = ".not-found.json";

function readNotFound(dir: string): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(dir, NOT_FOUND_FILE), "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Fetch FG_ROOT-relative paths into `dir`. Returns what was newly fetched and what doesn't exist upstream. */
export async function fetchFgdataFiles(paths: Iterable<string>, dir = defaultFgdataDir(), log?: (m: string) => void): Promise<{ fetched: string[]; notFound: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const notFound = readNotFound(dir);
  const todo = [...new Set(paths)].filter((p) => !notFound.has(p) && !fs.existsSync(path.join(dir, p)));
  const fetched: string[] = [];
  const missing: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const rel = todo[next++]!;
      const url = FGDATA_RAW + rel.split("/").map(encodeURIComponent).join("/");
      let res: Response | undefined;
      for (let i = 0; i < 4; i++) {
        try {
          res = await fetch(url);
          if (res.ok || res.status === 404) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
      if (!res?.ok) {
        missing.push(rel);
        continue;
      }
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
      fetched.push(rel);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (missing.length) {
    for (const m of missing) notFound.add(m);
    fs.writeFileSync(path.join(dir, NOT_FOUND_FILE), JSON.stringify([...notFound].sort(), null, 1));
  }
  log?.(`FGData: fetched ${fetched.length}, not found ${missing.length}`);
  return { fetched, notFound: missing };
}
