/**
 * Builds data/airfields/ from OurAirports (public domain,
 * https://github.com/davidmegginson/ourairports-data): Europe's small, medium and large
 * airports with their open runways, cut into zoom-7 Web Mercator tiles
 * (data/airfields/7/x/y.json, loaded around the start point) plus a search index
 * (data/airfields/index.json: ident, name, town, country, lat, lon; loaded only to search).
 * Run: pnpm --filter @webflight/environment airfields (NODE_USE_ENV_PROXY=1 behind a proxy).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { AIRFIELD_TILE_ZOOM } from "../src/airfields.ts";
import { lonLatToTile } from "../src/terrain.ts";

const SRC = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main";
const FT = 0.3048;

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
}

/** OurAirports surfaces are free text: map to paved / grass / other. */
export function surfaceClass(s: string): "paved" | "grass" | "other" {
  const t = s.toLowerCase();
  if (/(asp|con|pem|bit|tar|paved|cement|concrete|asphalt|^pav)/.test(t)) return "paved";
  if (/(grs|grass|gre|turf|^g$|^g-|grav|dirt|soil|earth|clay|^gvl|sand)/.test(t)) return "grass";
  return "other";
}

/**
 * The material, for drawing the runway: asphalt or concrete (the earlier named wins: "ASPH/
 * CONC" is asphalt), grass, gravel, dirt, water; "o" when unknown. One letter each.
 */
export function surfaceMaterial(s: string): "a" | "c" | "g" | "v" | "d" | "w" | "o" {
  const t = s.toUpperCase();
  const at = (re: RegExp) => { const m = re.exec(t); return m ? m.index : Infinity; };
  const asp = at(/ASP|BIT|TAR|PEM|MAC|PAVED|^PAV/), con = at(/CON|CEM|PCC/);
  if (asp < Infinity || con < Infinity) return asp <= con ? "a" : "c";
  if (/WAT/.test(t)) return "w";
  if (/GRS|GRASS|GRE|TURF|SOD|^G$|^G-/.test(t)) return "g";
  if (/GVL|GRAV|GRVL|GRV|PI\u00c7ARRA|CORAL|SHALE/.test(t)) return "v";
  if (/DIRT|EARTH|SOIL|CLAY|SAND|LATERITE|^S$/.test(t)) return "d";
  return "o";
}

const num = (s: string) => (s === "" ? null : Number(s));
const round = (x: number | null, d: number) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function main() {
  const [ap, rw] = await Promise.all(["airports", "runways"].map(async (f) => parseCsv(await (await fetch(`${SRC}/${f}.csv`)).text())));
  const kinds: Record<string, string> = { small_airport: "s", medium_airport: "m", large_airport: "l" };
  const byId = new Map<string, Record<string, string>[]>();
  for (const r of rw!) {
    if (r["closed"] === "1" || /^H/i.test(r["le_ident"] ?? "")) continue;
    const list = byId.get(r["airport_ident"]!) ?? [];
    list.push(r);
    byId.set(r["airport_ident"]!, list);
  }
  const out: unknown[] = [];
  for (const a of ap!) {
    if (a["continent"] !== "EU" || !kinds[a["type"]!]) continue;
    const runways = (byId.get(a["ident"]!) ?? []).map((r) => [
      r["le_ident"],
      r["he_ident"],
      round(num(r["length_ft"]!) && num(r["length_ft"]!)! * FT, 0),
      round(num(r["width_ft"]!) && num(r["width_ft"]!)! * FT, 0),
      surfaceClass(r["surface"]!),
      round(num(r["le_latitude_deg"]!), 6),
      round(num(r["le_longitude_deg"]!), 6),
      round(num(r["he_latitude_deg"]!), 6),
      round(num(r["he_longitude_deg"]!), 6),
      surfaceMaterial(r["surface"]!),
    ]);
    if (!runways.length) continue;
    out.push([a["ident"], a["name"], round(Number(a["latitude_deg"]), 6), round(Number(a["longitude_deg"]), 6), round((num(a["elevation_ft"]!) ?? 0) * FT, 0), kinds[a["type"]!], a["municipality"], a["iso_country"], runways]);
  }
  const dir = new URL("../data/airfields/", import.meta.url);
  rmSync(dir, { recursive: true, force: true });
  const source = "OurAirports (public domain), " + new Date().toISOString().slice(0, 10);
  const tiles = new Map<string, unknown[]>();
  for (const a of out as [string, string, number, number, ...unknown[]][]) {
    const [fx, fy] = lonLatToTile(a[3], a[2], AIRFIELD_TILE_ZOOM);
    const k = `${Math.floor(fx)}/${Math.floor(fy)}`;
    tiles.set(k, [...(tiles.get(k) ?? []), a]);
  }
  for (const [k, list] of tiles) {
    const f = new URL(`${AIRFIELD_TILE_ZOOM}/${k}.json`, dir);
    mkdirSync(new URL(".", f), { recursive: true });
    writeFileSync(f, JSON.stringify({ source, airfields: list }));
  }
  const index = (out as unknown[][]).map((a) => [a[0], a[1], a[6], a[7], a[2], a[3]]);
  writeFileSync(new URL("index.json", dir), JSON.stringify({ source, fields: ["ident", "name", "municipality", "country", "lat", "lon"], airfields: index }));
  console.log(`${out.length} airfields in ${tiles.size} tiles`);
}

void main();
