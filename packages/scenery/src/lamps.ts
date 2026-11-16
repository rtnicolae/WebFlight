/**
 * Street lamps from an OpenMapTiles vector tile: along streets (primary to minor roads, not
 * in tunnels) every LAMP_SPACING_M where they run through built-up land (landuse
 * residential, commercial, retail, industrial). One function for everything that shows
 * them (the light pools painted on the ground, the lamp lights in the scene), so they agree.
 * OpenStreetMap has few lamps mapped; these are placed, not surveyed.
 */
import type { MvtLayer } from "./mvt.ts";

export const LAMP_SPACING_M = 38;
/** Streets with lamps, and where the pole stands from the centreline [m] (beyond the kerb). */
const LAMP_ROADS: Record<string, number> = { primary: 7.5, secondary: 6, tertiary: 5.2, minor: 4.2 };
const BUILT = new Set(["residential", "commercial", "retail", "industrial"]);

const inRing = (ring: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

export interface TileLamp {
  /** On the street's centreline (the pool of light), tile units. */
  u: number;
  v: number;
  /** The pole at the roadside, alternating sides along the street, tile units. */
  pu: number;
  pv: number;
}

/** Lamps in the tile's own coordinates (0…extent, y down), for a tile at zoom z, row y. */
export function streetLamps(layers: MvtLayer[], z: number, y: number): { extent: number; pts: TileLamp[] } {
  const roads = layers.find((l) => l.name === "transportation"), landuse = layers.find((l) => l.name === "landuse");
  const extent = roads?.extent ?? 4096;
  const pts: TileLamp[] = [];
  if (!roads || !landuse) return { extent, pts };
  // Built-up polygons with their bounding boxes (even-odd over a feature's rings).
  const built = landuse.features
    .filter((f) => f.type === 3 && BUILT.has(String(f.properties["class"] ?? "")))
    .map((f) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of f.geometry) for (const [a, b] of r) { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, a); y1 = Math.max(y1, b); }
      return { rings: f.geometry, x0, y0, x1, y1 };
    });
  if (!built.length) return { extent, pts };
  const k = landuse.extent / extent;
  const isBuilt = (u: number, v: number) => built.some((p) => u * k >= p.x0 && u * k <= p.x1 && v * k >= p.y0 && v * k <= p.y1 && p.rings.reduce((c, r) => (inRing(r, u * k, v * k) ? !c : c), false));
  // True metres per tile unit at the tile's latitude.
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z)));
  const unitM = (40075016.686 * Math.cos(lat)) / 2 ** z / extent;
  for (const f of roads.features) {
    const side = LAMP_ROADS[String(f.properties["class"] ?? "")];
    if (f.type !== 2 || !side || f.properties["brunnel"] === "tunnel") continue;
    for (const line of f.geometry) {
      let next = LAMP_SPACING_M / 3; // distance along the line to the next lamp [m]
      let n = 0;
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = line[i]!, [bx, by] = line[i + 1]!;
        const len = Math.hypot(bx - ax, by - ay) * unitM;
        while (next <= len) {
          const t = next / len, u = ax + (bx - ax) * t, v = ay + (by - ay) * t;
          // Only lamps inside the tile proper: the neighbour places those in its own area.
          if (u >= 0 && v >= 0 && u < extent && v < extent && isBuilt(u, v)) {
            const l = Math.hypot(bx - ax, by - ay) || 1, o = ((n++ % 2 ? 1 : -1) * side) / unitM;
            pts.push({ u, v, pu: u - ((by - ay) / l) * o, pv: v + ((bx - ax) / l) * o });
          }
          next += LAMP_SPACING_M;
        }
        next -= len;
      }
    }
  }
  return { extent, pts };
}
