/**
 * Europe's airfields and runways from OurAirports (public domain; data/airfields-eu.json,
 * built by scripts/airfields.ts), with runway geometry resolved from, in order:
 *  1. OpenStreetMap runway lines near the field (passed in; the most precise where mapped),
 *  2. OurAirports' runway end coordinates,
 *  3. the runway designator (magnetic heading / 10) through the airfield's reference point.
 */
import { advance, distanceM } from "./util.ts";

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
export function searchAirfields(all: AirfieldData[], query: string, limit = 12): AirfieldData[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query.trim());
  if (!q) return [];
  const scored: [number, AirfieldData][] = [];
  for (const a of all) {
    const id = a.ident.toLowerCase(), name = norm(a.name), town = norm(a.municipality);
    let s = 0;
    if (id === q) s = 100;
    else if (id.startsWith(q)) s = 60;
    else if (name.startsWith(q) || town.startsWith(q)) s = 50;
    else if (name.includes(q) || town.includes(q)) s = 30;
    if (s) scored.push([s + (a.kind === "s" ? 2 : 0), a]); // small fields: gliding
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => a);
}

/** Nearest airfields to a point. */
export function nearestAirfields(all: AirfieldData[], latDeg: number, lonDeg: number, limit = 5): AirfieldData[] {
  return all
    .map((a) => [distanceM(latDeg, lonDeg, a.latDeg, a.lonDeg), a] as const)
    .sort((x, y) => x[0] - y[0])
    .slice(0, limit)
    .map(([, a]) => a);
}

/** A point `distM` before the `le` threshold on the extended centreline. */
export function finalFix(rw: Runway, distM: number): [number, number] {
  return advance(rw.latDeg, rw.lonDeg, rw.headingDeg + 180, rw.lengthM / 2 + distM);
}

/** Home base: Ghimbav Aerodrome (Brașov). */
export const HOME_AIRFIELD = "RO-0010";

/** The bundled data file (Vite serves it as an asset; Node reads it from disk). */
export const AIRFIELDS_URL = new URL("../data/airfields-eu.json", import.meta.url);

let cache: Promise<AirfieldData[]> | undefined;
export function loadAirfields(): Promise<AirfieldData[]> {
  cache ??= (async () => {
    if (AIRFIELDS_URL.protocol === "file:") {
      const fs = (await import("node:fs/promises" as string)) as { readFile(u: URL, enc: string): Promise<string> };
      return parseAirfields(JSON.parse(await fs.readFile(AIRFIELDS_URL, "utf8")) as { airfields: unknown[] });
    }
    const r = await fetch(AIRFIELDS_URL.href);
    return parseAirfields((await r.json()) as { airfields: unknown[] });
  })();
  return cache;
}
