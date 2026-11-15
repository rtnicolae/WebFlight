/**
 * Runway centrelines from OpenStreetMap (OpenMapTiles layer "aeroway", class "runway",
 * line features with `ref`, e.g. "03/21"). Vector tiles cut a runway at tile edges (with
 * overlapping buffers), so pieces with the same ref lying on one line are merged into the
 * full runway: the extent of all their points along the common axis.
 */
import { decodeMvt } from "./mvt.ts";
import { tileToLonLat } from "./osm.ts";

export interface RunwayLine {
  ref?: string;
  /** Ends, [lat, lon]. */
  a: [number, number];
  b: [number, number];
}

export function runwayPiecesFromTile(data: Uint8Array, z: number, x: number, y: number): RunwayLine[][] {
  const out: RunwayLine[][] = [];
  for (const layer of decodeMvt(data)) {
    if (layer.name !== "aeroway") continue;
    for (const f of layer.features) {
      if (f.type !== 2 || f.properties["class"] !== "runway") continue;
      for (const line of f.geometry) {
        const pts = line.map(([px, py]) => {
          const [lon, lat] = tileToLonLat(x + px / layer.extent, y + py / layer.extent, z);
          return [lat, lon] as [number, number];
        });
        const ref = f.properties["ref"];
        out.push(pts.slice(1).map((p, i) => ({ ...(typeof ref === "string" ? { ref } : {}), a: pts[i]!, b: p })));
      }
    }
  }
  return out;
}

/** Merge pieces lying on one line (direction within 3°, offset under 15 m) per ref. */
export function mergeRunwayPieces(pieces: RunwayLine[]): RunwayLine[] {
  const kx = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
  const groups: { ref?: string; o: [number, number]; ux: number; uy: number; pts: [number, number][] }[] = [];
  for (const p of pieces) {
    const lat0 = p.a[0];
    const dx = (p.b[1] - p.a[1]) * kx(lat0), dy = (p.b[0] - p.a[0]) * 111_132;
    const l = Math.hypot(dx, dy);
    if (l < 1) continue;
    const ux = dx / l, uy = dy / l;
    const g = groups.find((g) => {
      if (g.ref !== p.ref) return false;
      if (Math.abs(g.ux * uy - g.uy * ux) > Math.sin((3 * Math.PI) / 180)) return false;
      const ex = (p.a[1] - g.o[1]) * kx(lat0), ey = (p.a[0] - g.o[0]) * 111_132;
      return Math.abs(ex * g.uy - ey * g.ux) < 15;
    });
    if (g) g.pts.push(p.a, p.b);
    else groups.push({ ...(p.ref !== undefined ? { ref: p.ref } : {}), o: p.a, ux, uy, pts: [p.a, p.b] });
  }
  return groups.map((g) => {
    const k = kx(g.o[0]);
    const t = (q: [number, number]) => (q[1] - g.o[1]) * k * g.ux + (q[0] - g.o[0]) * 111_132 * g.uy;
    let lo = g.pts[0]!, hi = g.pts[0]!;
    for (const q of g.pts) {
      if (t(q) < t(lo)) lo = q;
      if (t(q) > t(hi)) hi = q;
    }
    return { ...(g.ref !== undefined ? { ref: g.ref } : {}), a: lo, b: hi };
  });
}

/** Runways within ~2 km of a point: the zoom-14 tiles around it, merged. */
export async function fetchRunwayLines(url: string, latDeg: number, lonDeg: number): Promise<RunwayLine[]> {
  const n = 2 ** 14;
  const fx = ((lonDeg + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan((latDeg * Math.PI) / 180) + 1 / Math.cos((latDeg * Math.PI) / 180)) / Math.PI) / 2) * n;
  const tiles: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push([Math.floor(fx) + dx, Math.floor(fy) + dy]);
  const pieces = await Promise.all(
    tiles.map(async ([x, y]) => {
      try {
        const r = await fetch(url.replace("{z}", "14").replace("{x}", String(x)).replace("{y}", String(y)));
        return r.ok ? runwayPiecesFromTile(new Uint8Array(await r.arrayBuffer()), 14, x, y).flat() : [];
      } catch {
        return [];
      }
    }),
  );
  return mergeRunwayPieces(pieces.flat());
}
