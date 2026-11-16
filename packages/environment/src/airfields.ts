/**
 * Europe's airfields and runways from OurAirports (public domain; data/airfields/, built by
 * scripts/airfields.ts, tiled so only the data around the start loads), with runway geometry
 * resolved from, in order:
 *  1. OpenStreetMap runway lines near the field (passed in; the most precise where mapped),
 *  2. OurAirports' runway end coordinates,
 *  3. the runway designator (magnetic heading / 10) through the airfield's reference point.
 */
import { distanceM } from "./util.ts";

export interface RunwayData {
  /** Designators of the two ends, e.g. "04" / "22". */
  le: string;
  he: string;
  lengthM: number | null;
  widthM: number | null;
  surface: "paved" | "grass" | "other";
  /** End coordinates, if known. */
  leLatLon: [number, number] | null;
  heLatLon: [number, number] | null;
}

export interface AirfieldData {
  ident: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  elevM: number;
  kind: "s" | "m" | "l";
  municipality: string;
  country: string;
  runways: RunwayData[];
}

/** A runway as the sim uses it: centre, true heading of the `le` direction, size. */
export interface Runway {
  name: string;
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  lengthM: number;
  widthM: number;
  paved: boolean;
  /** Where the geometry came from. */
  source: "osm" | "ourairports" | "designator";
}

/** A runway line from OpenStreetMap (aeroway=runway): its ends, and its ref (e.g. "03/21"). */
export interface OsmRunwayLine {
  ref?: string;
  a: [number, number];
  b: [number, number];
}

type Row = [string, string, number, number, number, "s" | "m" | "l", string, string, [string, string, number | null, number | null, RunwayData["surface"], number | null, number | null, number | null, number | null][]];

export function parseAirfields(json: { airfields: unknown[] }): AirfieldData[] {
  return (json.airfields as Row[]).map(([ident, name, latDeg, lonDeg, elevM, kind, municipality, country, rws]) => ({
    ident,
    name,
    latDeg,
    lonDeg,
    elevM,
    kind,
    municipality,
    country,
    runways: rws.map(([le, he, lengthM, widthM, surface, a, b, c, d]) => ({
      le,
      he,
      lengthM,
      widthM,
      surface,
      leLatLon: a !== null && b !== null ? [a, b] : null,
      heLatLon: c !== null && d !== null ? [c, d] : null,
    })),
  }));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

/** Magnetic heading of a designator ("04", "22L") [deg], or undefined. */
export function designatorDeg(id: string): number | undefined {
  const m = /^(\d{1,2})/.exec(id);
  return m ? (Number(m[1]) % 36 || 36) * 10 : undefined;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Resolve a runway's geometry. OSM lines within 3 km whose direction matches the designator
 * (±25°: magnetic variation in Europe is under ±10°, designators are rounded to 10°) win;
 * the nearest to the airfield point is used.
 */
export function resolveRunway(field: AirfieldData, rw: RunwayData, osm: OsmRunwayLine[] = []): Runway {
  const design = designatorDeg(rw.le);
  const paved = rw.surface === "paved";
  const widthM = rw.widthM ?? (paved ? 25 : 40);
  const name = `${rw.le}/${rw.he}`;
  // A line whose ref names this runway wins; otherwise the nearest line along the
  // designator's direction that doesn't name another of the field's runways.
  const key = (id: string) => id.replace(/^0+/, "").toUpperCase();
  const refMatches = (ref: string | undefined, r: RunwayData) => !!ref && ref.split("/").some((e) => key(e) === key(r.le) || key(e) === key(r.he));
  let best: { line: OsmRunwayLine; d: number } | undefined;
  for (const line of osm) {
    const brg = bearingDeg(line.a[0], line.a[1], line.b[0], line.b[1]);
    const axis = design === undefined ? 0 : Math.min(angleDiff(brg, design), angleDiff(brg + 180, design));
    if (axis > 25) continue;
    const mid: [number, number] = [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
    let d = distanceM(mid[0], mid[1], field.latDeg, field.lonDeg);
    if (d > 3000) continue;
    if (refMatches(line.ref, rw)) d -= 10_000;
    else if (field.runways.some((o) => o !== rw && refMatches(line.ref, o))) continue;
    else if (rw.leLatLon && rw.heLatLon) continue; // OurAirports' own ends beat a guess
    if (!best || d < best.d) best = { line, d };
  }
  if (best) {
    let { a, b } = best.line;
    // Orient along the `le` designator.
    if (design !== undefined && angleDiff(bearingDeg(a[0], a[1], b[0], b[1]), design) > 90) [a, b] = [b, a];
    return { name, latDeg: (a[0] + b[0]) / 2, lonDeg: (a[1] + b[1]) / 2, headingDeg: bearingDeg(a[0], a[1], b[0], b[1]), lengthM: distanceM(a[0], a[1], b[0], b[1]), widthM, paved, source: "osm" };
  }
  if (rw.leLatLon && rw.heLatLon) {
    const [a, b] = [rw.leLatLon, rw.heLatLon];
    return { name, latDeg: (a[0] + b[0]) / 2, lonDeg: (a[1] + b[1]) / 2, headingDeg: bearingDeg(a[0], a[1], b[0], b[1]), lengthM: rw.lengthM ?? distanceM(a[0], a[1], b[0], b[1]), widthM, paved, source: "ourairports" };
  }
  return { name, latDeg: field.latDeg, lonDeg: field.lonDeg, headingDeg: design ?? 0, lengthM: rw.lengthM ?? 800, widthM, paved, source: "designator" };
}

/** Airfields matching a query (ident, name or town; accents ignored), best first. */
export function searchAirfields<T extends { ident: string; name: string; municipality: string }>(all: T[], query: string, limit = 12): T[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query.trim());
  if (!q) return [];
  const scored: [number, T][] = [];
  for (const a of all) {
    const id = a.ident.toLowerCase(), name = norm(a.name), town = norm(a.municipality);
    let s = 0;
    if (id === q) s = 100;
    else if (id.startsWith(q)) s = 60;
    else if (name.startsWith(q) || town.startsWith(q)) s = 50;
    else if (name.includes(q) || town.includes(q)) s = 30;
    if (s) scored.push([s, a]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => a);
}

/** Home base: Ghimbav Aerodrome (Brașov), with its position to find its data tile. */
export const HOME_AIRFIELD = { ident: "RO-0010", latDeg: 45.699386, lonDeg: 25.528414 };

/** Airfield data tiles (zoom-7 Web Mercator, ~200–300 km in Europe). */
export const AIRFIELD_TILE_ZOOM = 7;
// Next to the code (Node, Vite dev) or the bundle (built site: assets/ → data/airfields/, copied
// there by the web app's build). Not a string literal, or Vite would rewrite it as an asset.
const DATA_DIR = "../data/airfields/";
const DATA = new URL(DATA_DIR, import.meta.url);

async function readJson(path: string): Promise<unknown> {
  const u = new URL(path, DATA);
  if (u.protocol === "file:") {
    const fs = (await import("node:fs/promises" as string)) as { readFile(u: URL, enc: string): Promise<string> };
    return JSON.parse(await fs.readFile(u, "utf8"));
  }
  const r = await fetch(u.href);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const tileCache = new Map<string, Promise<AirfieldData[]>>();
/** All airfields of one data tile (zoom AIRFIELD_TILE_ZOOM). */
export function airfieldTile(x: number, y: number): Promise<AirfieldData[]> {
  const k = `${x}/${y}`;
  let t = tileCache.get(k);
  if (!t) {
    // A tile without airfields has no file.
    t = readJson(`${AIRFIELD_TILE_ZOOM}/${k}.json`).then((j) => parseAirfields(j as { airfields: unknown[] }), () => []);
    tileCache.set(k, t);
  }
  return t;
}

/** Airfields within `radiusM` of a point, loading only the data tiles that cover it. */
export async function airfieldsAround(latDeg: number, lonDeg: number, radiusM: number): Promise<AirfieldData[]> {
  const n = 2 ** AIRFIELD_TILE_ZOOM;
  const dLat = radiusM / 111_132, dLon = radiusM / (111_320 * Math.cos((latDeg * Math.PI) / 180));
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  const jobs: Promise<AirfieldData[]>[] = [];
  for (let x = tx(lonDeg - dLon); x <= tx(lonDeg + dLon); x++) for (let y = ty(latDeg + dLat); y <= ty(latDeg - dLat); y++) jobs.push(airfieldTile(x, y));
  return (await Promise.all(jobs)).flat().filter((a) => distanceM(latDeg, lonDeg, a.latDeg, a.lonDeg) <= radiusM);
}

/** An airfield by ident near a known point (the point only selects the data tile). */
export async function airfieldAt(ident: string, latDeg: number, lonDeg: number): Promise<AirfieldData | undefined> {
  return (await airfieldsAround(latDeg, lonDeg, 5000)).find((a) => a.ident.toLowerCase() === ident.toLowerCase());
}

/** A search index entry: enough to find a field and then load its tile. */
export interface AirfieldIndexEntry {
  ident: string;
  name: string;
  municipality: string;
  country: string;
  latDeg: number;
  lonDeg: number;
}

let index: Promise<AirfieldIndexEntry[]> | undefined;
/** The search index (all of Europe, names and positions only): load it only to search. */
export function loadAirfieldIndex(): Promise<AirfieldIndexEntry[]> {
  index ??= readJson("index.json").then((j) =>
    ((j as { airfields: [string, string, string, string, number, number][] }).airfields).map(([ident, name, municipality, country, latDeg, lonDeg]) => ({ ident, name, municipality, country, latDeg, lonDeg })),
  );
  return index;
}
