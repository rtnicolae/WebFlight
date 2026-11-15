/**
 * Water bodies from swisstopo's base vector tiles (ch.swisstopo.base.vt, layer "water":
 * lakes, rivers, ponds, pools). Polygons are assembled from MVT rings (exterior rings have
 * positive area in tile coordinates, y down; holes negative) and returned in degrees.
 */
import { decodeMvt } from "./mvt.ts";

export const BASE_VT = "https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf";

export interface WaterPolygon {
  /** Exterior ring then holes, [lon, lat] degrees, closed. */
  rings: [number, number][][];
  kind: string;
}

const area = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
};

function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

/** Decode the water polygons of one tile. */
export function waterFromTile(data: Uint8Array, z: number, x: number, y: number, kinds: (k: string) => boolean = () => true): WaterPolygon[] {
  const out: WaterPolygon[] = [];
  for (const layer of decodeMvt(data)) {
    if (layer.name !== "water") continue;
    for (const f of layer.features) {
      if (f.type !== 3) continue;
      const kind = String(f.properties["class"] ?? "water");
      if (!kinds(kind)) continue;
      let cur: WaterPolygon | undefined;
      for (const ring of f.geometry) {
        if (ring.length < 4) continue;
        const a = area(ring);
        const deg = ring.map(([px, py]) => tileToLonLat(x + px / layer.extent, y + py / layer.extent, z));
        // In tile coordinates (y down), the spec's exterior rings have positive area.
        if (a > 0 || !cur) {
          cur = { rings: [deg], kind };
          out.push(cur);
        } else cur.rings.push(deg);
      }
    }
  }
  return out;
}

export async function fetchWater(z: number, x: number, y: number, kinds?: (k: string) => boolean, url = BASE_VT): Promise<WaterPolygon[]> {
  const r = await fetch(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  if (!r.ok) return [];
  return waterFromTile(new Uint8Array(await r.arrayBuffer()), z, x, y, kinds);
}
