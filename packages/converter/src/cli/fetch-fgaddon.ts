/**
 * Usage: fetch-fgaddon <AircraftFolder> [--only <prefix>]... [--dest <dir>]
 * Default destination: <repo>/.cache/fgaddon
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchAircraft } from "../fgaddon.ts";
import { defaultCacheDir } from "../paths.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string", multiple: true },
    dest: { type: "string" },
  },
});

if (positionals.length === 0) {
  console.error("usage: fetch-fgaddon <AircraftFolder>... [--only <prefix>] [--dest <dir>]");
  process.exit(2);
}
const dest = path.resolve(values.dest ?? defaultCacheDir());
for (const aircraft of positionals) {
  const files = await fetchAircraft(aircraft, { dest, only: values.only ?? [], log: console.log });
  console.log(`${aircraft}: ${files.length} files in ${path.join(dest, aircraft)}`);
}
