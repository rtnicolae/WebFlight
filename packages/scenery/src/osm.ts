/// <reference path="./earcut.d.ts" />
/**
 * Buildings and forests anywhere from OpenStreetMap vector tiles in the OpenMapTiles schema
 * (as served by OpenFreeMap): layer "building" (footprints, `render_height`,
 * `render_min_height`; buildings of one height are merged into one multipolygon feature)
 * and layer "landcover" (class "wood": forests and woods).
 *
 * Everything is turned into plain triangle meshes in a local east-north-up frame at the
 * tile's centre (metres), with per-vertex normals and colours, so the renderer can draw a
 * tile's buildings or trees as one draw call and this code stays testable without WebGL.
 */
import earcut from "earcut";
import { streetLamps } from "./lamps.ts";
import { decodeMvt, type MvtLayer } from "./mvt.ts";

export type LonLat = [number, number];

export interface OsmPolygon {
  /** Exterior ring then holes, [lon, lat] degrees, closed (first = last). */
  rings: LonLat[][];
  properties: Record<string, unknown>;
}

const ringArea = (r: [number, number][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
};

export function tileToLonLat(x: number, y: number, z: number): LonLat {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

/**
 * Polygons of one layer. Features of tiles straddling a tile edge are clipped with a buffer
 * and so appear in both tiles: with `ownedOnly`, only polygons whose first exterior vertex
 * lies inside this tile are kept, so neighbouring tiles don't draw the same building twice.
 */
export function polygonsFromLayer(layer: MvtLayer, z: number, x: number, y: number, keep: (p: Record<string, unknown>) => boolean = () => true, ownedOnly = false): OsmPolygon[] {
  const out: OsmPolygon[] = [];
  const e = layer.extent;
  for (const f of layer.features) {
    if (f.type !== 3 || !keep(f.properties)) continue;
    let cur: OsmPolygon | undefined;
    let skip = false;
    for (const ring of f.geometry) {
      if (ring.length < 4) continue;
      const a = ringArea(ring);
      // In tile coordinates (y down) exterior rings have positive area (MVT spec 4.3.4.4).
      if (a > 0 || !cur) {
        const [px, py] = ring[0]!;
        skip = ownedOnly && (px < 0 || py < 0 || px >= e || py >= e);
        cur = { rings: [], properties: f.properties };
        if (!skip) out.push(cur);
      }
      if (skip) continue;
      cur.rings.push(ring.map(([px, py]) => tileToLonLat(x + px / e, y + py / e, z)));
    }
  }
  return out;
}

export interface OsmTile {
  buildings: OsmPolygon[];
  forests: OsmPolygon[];
  /** Where single trees stand: residential land, parks, gardens, cemeteries (class in properties.kind). */
  greens: OsmPolygon[];
  /** Road and rail centrelines with half-widths [m], [lon, lat] points. */
  roads: { pts: LonLat[]; halfM: number }[];
  /** Street lamps (see lamps.ts). */
  lamps: LonLat[];
}

const ROAD_HALF_M: Record<string, number> = { motorway: 12, trunk: 9, primary: 7, secondary: 5.5, tertiary: 4.5, minor: 3.5, service: 2.5, track: 2, rail: 3, transit: 3 };

export function osmFromTile(data: Uint8Array, z: number, x: number, y: number): OsmTile {
  const t: OsmTile = { buildings: [], forests: [], greens: [], roads: [], lamps: [] };
  const layers = decodeMvt(data);
  const lamps = streetLamps(layers, z, y);
  t.lamps = lamps.pts.map(([u, v]) => tileToLonLat(x + u / lamps.extent, y + v / lamps.extent, z));
  for (const layer of layers) {
    if (layer.name === "building") t.buildings = polygonsFromLayer(layer, z, x, y, () => true, true);
    else if (layer.name === "landcover") {
      t.forests = polygonsFromLayer(layer, z, x, y, (p) => p["class"] === "wood");
      t.greens.push(...polygonsFromLayer(layer, z, x, y, (p) => p["class"] === "grass" && ["park", "garden", "allotments"].includes(String(p["subclass"]))).map((g) => ({ ...g, properties: { kind: "park" } })));
    } else if (layer.name === "landuse") {
      t.greens.push(...polygonsFromLayer(layer, z, x, y, (p) => ["residential", "suburb", "cemetery", "school", "hospital"].includes(String(p["class"]))).map((g) => ({ ...g, properties: { kind: g.properties["class"] === "cemetery" ? "park" : "residential" } })));
    } else if (layer.name === "transportation") {
      for (const f of layer.features) {
        const half = ROAD_HALF_M[String(f.properties["class"] ?? "")];
        if (f.type !== 2 || !half) continue;
        for (const line of f.geometry) t.roads.push({ pts: line.map(([px, py]) => tileToLonLat(x + px / layer.extent, y + py / layer.extent, z)), halfM: half });
      }
    }
  }
  return t;
}

export async function fetchOsm(url: string, z: number, x: number, y: number): Promise<OsmTile> {
  const r = await fetch(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  if (!r.ok) return { buildings: [], forests: [], greens: [], roads: [], lamps: [] };
  return osmFromTile(new Uint8Array(await r.arrayBuffer()), z, x, y);
}

// --- local frame -------------------------------------------------------------------------

const R_EARTH = 6_371_000;
const D2R = Math.PI / 180;

/** East-north-up metres around an origin; small-area (a z14 tile is ~2 km). */
export class LocalFrame {
  private readonly kx: number;
  private readonly ky = R_EARTH * D2R;
  constructor(
    readonly lonDeg: number,
    readonly latDeg: number,
    readonly heightM: number,
  ) {
    this.kx = R_EARTH * D2R * Math.cos(latDeg * D2R);
  }
  en(lon: number, lat: number): [number, number] {
    return [(lon - this.lonDeg) * this.kx, (lat - this.latDeg) * this.ky];
  }
  lonLat(e: number, n: number): LonLat {
    return [this.lonDeg + e / this.kx, this.latDeg + n / this.ky];
  }
  /** Up coordinate of a point at height h, including the earth's curvature drop. */
  up(e: number, n: number, h: number): number {
    return h - this.heightM - (e * e + n * n) / (2 * R_EARTH);
  }
}

/** Ground height [m] at a position (the renderer's terrain). */
export type GroundFn = (lonDeg: number, latDeg: number) => number;

/** A triangle mesh in the local frame: xyz positions, unit normals, RGBA bytes. */
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  /**
   * Per vertex (4 floats): texture u, v [m]; material + style seed (integer part: see MAT;
   * fraction: the building's style seed, a multiple of 1/512 below 0.98); and the building's wall height [m]
   * (facade details need to know where the wall ends; a balcony's own height).
   */
  uvm: Float32Array;
}

class MeshBuilder {
  p: number[] = [];
  nrm: number[] = [];
  c: number[] = [];
  i: number[] = [];
  t: number[] = [];
  /** Texture coordinates and material of the next vertices. */
  u = 0;
  v = 0;
  mat = 0;
  /** Style seed of the current building (k/512 < 0.98) and its wall height [m]. */
  seed = 0;
  wallH = 0;
  get count() {
    return this.p.length / 3;
  }
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: readonly number[]): number {
    this.p.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.c.push(col[0]!, col[1]!, col[2]!, 255);
    this.t.push(this.u, this.v, this.mat + this.seed, this.wallH);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }
  /** A flat-shaded triangle (own vertices, face normal pointing away from `inside`). */
  face(a: number[], b: number[], c: number[], col: readonly number[], mat = 2) {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // roofs face up
    // Texture: u along the face's horizontal direction, v up the slope (tile rows level).
    const hl = Math.hypot(nx, ny) || 1, hx = -ny / hl, hy = nx / hl, slope = Math.max(0.2, Math.sqrt(1 - nz * nz));
    this.mat = mat;
    const put = (q: number[]) => {
      this.u = q[0]! * hx + q[1]! * hy;
      this.v = q[2]! / slope;
      return this.vertex(q[0]!, q[1]!, q[2]!, nx, ny, nz, col);
    };
    const i0 = put(a), i1 = put(b), i2 = put(c);
    this.tri(i0, i1, i2);
  }
  build(): Mesh {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.nrm), colors: new Uint8Array(this.c), indices: new Uint32Array(this.i), uvm: new Float32Array(this.t) };
  }
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (a: number, b: number) => (Math.imul(Math.round(a * 1e6), 73856093) ^ Math.imul(Math.round(b * 1e6), 19349663)) >>> 0;

// --- buildings -------------------------------------------------------------------------

/** Surface materials (the integer part of uvm.z); the renderer draws each from u, v. */
export const MAT = { wall: 0, plainWall: 1, tiles: 2, bitumen: 3, gravel: 4, coping: 5, unit: 6, balcony: 7, brick: 8, plainBrick: 9, glass: 10 } as const;

/** Buildings taller than this [m] are blocks (flats, offices) rather than houses. */
export const BLOCK_WALL_M = 13;
/** Storey height of blocks [m] (the renderer uses the same). */
export const BLOCK_FLOOR_M = 2.8;

/**
 * Window spacing along walls [m], per building from its style seed (the renderer computes
 * the same from the seed it gets): houses 2.3–3.6 m, blocks 2.7–3.6 m.
 */
export function windowPitch(seed: number, block: boolean): number {
  const f = (seed * 7) % 1;
  return block ? 2.7 + 0.9 * f : 2.3 + 1.3 * f;
}
/** Plaster, render and brick wall colours of central-European towns. */
const WALLS = [[236, 230, 216], [228, 218, 196], [240, 236, 228], [222, 204, 176], [232, 214, 200], [214, 210, 202], [226, 222, 206], [196, 150, 120]];
/** Pitched roofs: clay tiles, weathered tiles, slate/metal. */
const PITCHED = [[150, 86, 66], [136, 80, 64], [118, 74, 60], [156, 104, 80], [96, 92, 90], [82, 84, 90]];
/** Flat roofs: gravel, bitumen, metal. */
const FLAT = [[112, 110, 104], [96, 94, 90], [126, 122, 114], [88, 90, 94], [104, 98, 88]];
/** Balcony fronts: bare and painted concrete, enamelled panels. */
const BALCONY = [[206, 202, 192], [190, 186, 178], [214, 206, 186], [200, 176, 150], [170, 186, 196], [214, 196, 160], [168, 172, 160]];

const NAMED: Record<string, string> = { white: "#ffffff", lightgrey: "#d3d3d3", lightgray: "#d3d3d3", grey: "#808080", gray: "#808080", wheat: "#f5deb3", beige: "#f5f5dc", ivory: "#fffff0", tan: "#d2b48c", firebrick: "#b22222", brown: "#a52a2a", maroon: "#800000", red: "#ff0000", yellow: "#ffff00", orange: "#ffa500", pink: "#ffc0cb", silver: "#c0c0c0", cream: "#fffdd0" };
/** A CSS colour from OpenStreetMap (building:colour) as RGB bytes, if it parses. */
export function parseColour(c: unknown): [number, number, number] | undefined {
  let s = String(c ?? "").trim().toLowerCase();
  s = NAMED[s] ?? s;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s);
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, "$&$&") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Wall finish of a building. OpenMapTiles turns building:material into a colour: brick
 * (#bd8161) and glass (#5a81a0) get those materials; other colours (building:colour) tint
 * the plaster. Untagged buildings are plaster, or brick as often as brick is common where they
 * stand (north of ~50.5° N: the Low Countries, northern Germany, Poland).
 */
function wallFinish(props: Record<string, unknown>, latDeg: number, r: () => number): { kind: "plaster" | "brick" | "glass"; col: number[] } {
  const raw = String(props["colour"] ?? "").toLowerCase();
  const col = parseColour(raw);
  if (raw === "#bd8161" || raw === "firebrick" || raw === "brown" || raw === "maroon") return { kind: "brick", col: brickTint(r) };
  if (raw === "#5a81a0") return { kind: "glass", col: [104, 128, 146] };
  if (col) {
    // Painted plaster: OSM colours are often saturated; keep them believable.
    const l = (col[0] + col[1] + col[2]) / 3;
    return { kind: "plaster", col: col.map((c) => Math.max(70, Math.min(245, 0.55 * c + 0.45 * l + 18))) };
  }
  if (r() < (latDeg > 50.5 ? 0.4 : 0.06)) return { kind: "brick", col: brickTint(r) };
  return { kind: "plaster", col: WALLS[Math.floor(r() * WALLS.length)]! };
}
/** Brick walls use the photo's own colour; the vertex colour is a mild per-building tint. */
const brickTint = (r: () => number) => {
  const k = 225 + r() * 30;
  return [k, k * (0.94 + 0.06 * r()), k * (0.9 + 0.1 * r())];
};

/**
 * The minimum-area rectangle around a footprint (rotating calipers over the ring's edge
 * directions): corners counter-clockwise, and how much of it the footprint fills.
 */
export function footprintRect(ring: [number, number][]): { corners: [number, number][]; fill: number; long: number; short: number } {
  let best = { area: Infinity, ux: 1, uy: 0, min0: 0, max0: 0, min1: 0, max1: 0 };
  for (let k = 0; k < ring.length - 1; k++) {
    const dx = ring[k + 1]![0] - ring[k]![0], dy = ring[k + 1]![1] - ring[k]![1];
    const l = Math.hypot(dx, dy);
    if (l < 0.5) continue;
    const ux = dx / l, uy = dy / l;
    let min0 = Infinity, max0 = -Infinity, min1 = Infinity, max1 = -Infinity;
    for (const [x, y] of ring) {
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      min0 = Math.min(min0, a); max0 = Math.max(max0, a); min1 = Math.min(min1, b); max1 = Math.max(max1, b);
    }
    const area = (max0 - min0) * (max1 - min1);
    if (area < best.area) best = { area, ux, uy, min0, max0, min1, max1 };
  }
  const { ux, uy, min0, max0, min1, max1 } = best;
  const pt = (a: number, b: number): [number, number] => [a * ux - b * uy, a * uy + b * ux];
  const corners = [pt(min0, min1), pt(max0, min1), pt(max0, max1), pt(min0, max1)];
  const l0 = max0 - min0, l1 = max1 - min1;
  return { corners, fill: Math.abs(ringArea(ring)) / best.area, long: Math.max(l0, l1), short: Math.min(l0, l1) };
}

/**
 * Extruded buildings with walls along the real footprints. Houses (low, roughly
 * rectangular, under ~25 m wide) get a hipped or gabled tile roof over their footprint's
 * rectangle; everything else a flat roof. The base sits on the lowest ground under the
 * footprint, so on slopes the uphill walls go into the ground instead of floating.
 */
export function buildingMesh(polys: OsmPolygon[], frame: LocalFrame, ground: GroundFn): Mesh {
  const m = new MeshBuilder();
  for (const poly of polys) {
    // Outlines whose parts are mapped separately (the parts are drawn instead).
    if (poly.properties["hide_3d"]) continue;
    const rings = poly.rings.map((r) => r.map(([lon, lat]) => frame.en(lon, lat)));
    const outer = rings[0]!;
    if (outer.length < 4) continue;
    const areaM2 = Math.abs(ringArea(outer));
    if (areaM2 < 6) continue;
    let base = Infinity;
    for (const [lon, lat] of poly.rings[0]!) base = Math.min(base, ground(lon, lat));
    base += Number(poly.properties["render_min_height"] ?? 0);
    const tall = Number(poly.properties["render_height"] ?? 5);
    const r = rng(hash(poly.rings[0]![0]![0], poly.rings[0]![0]![1]));
    // Quantized so the renderer recovers it exactly (it hashes it per window).
    m.seed = Math.floor(r() * 500) / 512;
    const finish = wallFinish(poly.properties, poly.rings[0]![0]![1], r);
    const wall = finish.col;
    // Walls reach 1 m below the ground so slopes and terrain smoothing hide no gap.
    const h0 = base - 1;
    const h1 = base + Math.max(2.5, tall) - Number(poly.properties["render_min_height"] ?? 0);
    m.wallH = h1 - base;
    const block = m.wallH > BLOCK_WALL_M;
    const pitch = windowPitch(m.seed, block);
    const balconies = block && finish.kind !== "glass" ? balconyStyle(r) : undefined;
    let nBalc = 0;
    const ccw = ringArea(outer) > 0; // positive = counter-clockwise with y up (north)
    for (const ring of rings) {
      for (let k = 0; k < ring.length - 1; k++) {
        const [ax, ay] = ring[k]!, [bx, by] = ring[k + 1]!;
        const dx = bx - ax, dy = by - ay;
        const l = Math.hypot(dx, dy);
        if (l < 0.05) continue;
        // Outward normal: right of travel on a counter-clockwise exterior (and on its holes).
        let nx = dy / l, ny = -dx / l;
        if (!ccw) { nx = -nx; ny = -ny; }
        // Windows on walls long and high enough, their grid centred on the wall.
        const windows = l >= 3.2 && h1 - base >= 2.6;
        m.mat = finish.kind === "glass" ? MAT.glass : finish.kind === "brick" ? (windows ? MAT.brick : MAT.plainBrick) : windows ? MAT.wall : MAT.plainWall;
        const u0 = (pitch - (l % pitch)) / 2;
        const vert = (x: number, y: number, h: number, u: number) => {
          m.u = u;
          m.v = h - base;
          return m.vertex(x, y, frame.up(x, y, h), nx, ny, 0, wall);
        };
        const a0 = vert(ax, ay, h0, u0), b0 = vert(bx, by, h0, u0 + l), b1 = vert(bx, by, h1, u0 + l), a1 = vert(ax, ay, h1, u0);
        m.tri(a0, b0, b1);
        m.tri(a0, b1, a1);
        if (balconies && windows && l >= 9 && nBalc < 400) nBalc += balconyStack(m, frame, ax, ay, dx / l, dy / l, nx, ny, l, u0, pitch, base, m.wallH, balconies, r);
      }
    }
    const rect = rings.length === 1 && outer.length <= 14 && tall <= 14 ? footprintRect(outer) : undefined;
    if (rect && rect.fill > 0.82 && rect.short <= 24 && rect.short >= 4) pitchedRoof(m, frame, rect, h1, r);
    else {
      flatRoof(m, frame, rings, h1, FLAT[Math.floor(r() * FLAT.length)]!, r() < 0.35 ? 4 : 3);
      if (h1 - base >= 4) parapet(m, frame, rings, ccw, base, h1, wall);
      if (areaM2 > 180 && rings.length === 1) rooftopUnits(m, frame, outer, h1, areaM2, r);
    }
  }
  return m.build();
}

interface BalconyStyle {
  /** Every `period` window columns a balcony `width` columns wide, starting at `phase`. */
  period: number;
  width: number;
  phase: number;
  depth: number;
  /** Share of balconies glazed in (most in Romanian blocks, each owner their own way). */
  enclosed: number;
  colour: number[];
}
function balconyStyle(r: () => number): BalconyStyle | undefined {
  if (r() < 0.25) return undefined; // offices, hotels, flats without
  const period = 2 + Math.floor(r() * 3);
  return { period, width: r() < 0.6 || period === 2 ? 1 : 2, phase: Math.floor(r() * period), depth: 1.0 + r() * 0.5, enclosed: r() < 0.5 ? 0.5 + r() * 0.5 : r() * 0.4, colour: BALCONY[Math.floor(r() * BALCONY.length)]! };
}

/**
 * Balconies up one wall of a block: boxes on every storey above the ground floor, in columns
 * aligned with the facade's windows; open ones are a slab with a 1.05 m front, enclosed ones
 * reach to the slab above (the renderer glazes their upper part). Returns how many.
 */
function balconyStack(m: MeshBuilder, frame: LocalFrame, ax: number, ay: number, tx: number, ty: number, nx: number, ny: number, l: number, u0: number, pitch: number, base: number, wallH: number, st: BalconyStyle, r: () => number): number {
  const floors = Math.floor((wallH - 0.6) / BLOCK_FLOOR_M);
  let n = 0;
  for (let c = 1; (c + st.width) * pitch <= u0 + l + 1e-6; c++) {
    if ((c + st.phase) % st.period !== 0 || c * pitch < u0) continue;
    const s0 = c * pitch - u0 + 0.12, s1 = (c + st.width) * pitch - u0 - 0.12;
    for (let f = 1; f < floors; f++) {
      const closed = r() < st.enclosed;
      const z0 = f * BLOCK_FLOOR_M - 0.2, z1 = closed ? (f + 1) * BLOCK_FLOOR_M - 0.25 : f * BLOCK_FLOOR_M + 1.05;
      // Owners paint their own: a slight shade per balcony.
      const k = 0.92 + 0.12 * r();
      box(m, frame, ax, ay, tx, ty, nx, ny, s0, s1, -0.05, st.depth, base + z0, base + z1, st.colour.map((v) => Math.min(255, v * k)));
      n++;
    }
  }
  return n;
}

/** A box against a wall: from s0 to s1 along it, d0 to d1 out from it, z0 to z1 [m] up. */
function box(m: MeshBuilder, frame: LocalFrame, ax: number, ay: number, tx: number, ty: number, nx: number, ny: number, s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, col: readonly number[]) {
  const [mat, wallH] = [m.mat, m.wallH];
  m.mat = MAT.balcony;
  const H = z1 - z0;
  m.wallH = H;
  const P = (s: number, d: number): [number, number] => [ax + tx * s + nx * d, ay + ty * s + ny * d];
  const quad = (p: [number, number][], zs: number[], us: number[], vs: number[], N: number[]) => {
    const i = p.map((q, k) => ((m.u = us[k]!), (m.v = vs[k]!), m.vertex(q[0], q[1], frame.up(q[0], q[1], zs[k]!), N[0]!, N[1]!, N[2]!, col)));
    m.tri(i[0]!, i[1]!, i[2]!);
    m.tri(i[0]!, i[2]!, i[3]!);
  };
  const w = s1 - s0, dd = d1 - d0;
  const f0 = P(s0, d1), f1 = P(s1, d1), b0 = P(s0, d0), b1 = P(s1, d0);
  // Front, the two sides, underside, top.
  quad([f0, f1, f1, f0], [z0, z0, z1, z1], [0, w, w, 0], [0, 0, H, H], [nx, ny, 0]);
  quad([b0, f0, f0, b0], [z0, z0, z1, z1], [0, dd, dd, 0], [0, 0, H, H], [-tx, -ty, 0]);
  quad([f1, b1, b1, f1], [z0, z0, z1, z1], [0, dd, dd, 0], [0, 0, H, H], [tx, ty, 0]);
  quad([b0, b1, f1, f0], [z0, z0, z0, z0], [0, w, w, 0], [-1, -1, -1, -1], [0, 0, -1]);
  quad([f0, f1, b1, b0], [z1, z1, z1, z1], [0, w, w, 0], [-2, -2, -2, -2], [0, 0, 1]);
  [m.mat, m.wallH] = [mat, wallH];
}

/** A 0.6 m parapet around a flat roof (wall material, no windows) with a light coping on top. */
function parapet(m: MeshBuilder, frame: LocalFrame, rings: [number, number][][], ccw: boolean, base: number, h: number, wall: readonly number[]) {
  const top = h + 0.6, cope = [196, 194, 188];
  for (const ring of rings)
    for (let k = 0; k < ring.length - 1; k++) {
      const [ax, ay] = ring[k]!, [bx, by] = ring[k + 1]!;
      const l = Math.hypot(bx - ax, by - ay);
      if (l < 0.05) continue;
      let nx = (by - ay) / l, ny = -(bx - ax) / l;
      if (!ccw) { nx = -nx; ny = -ny; }
      m.mat = 1;
      const v = (x: number, y: number, hh: number, u: number) => ((m.u = u), (m.v = hh - base), m.vertex(x, y, frame.up(x, y, hh), nx, ny, 0, wall));
      const a0 = v(ax, ay, h, 0), b0 = v(bx, by, h, l), b1 = v(bx, by, top, l), a1 = v(ax, ay, top, 0);
      m.tri(a0, b0, b1);
      m.tri(a0, b1, a1);
      // Coping: a 0.3 m strip on top, inwards.
      m.mat = 5;
      const ix = -nx * 0.3, iy = -ny * 0.3;
      const c = (x: number, y: number, u: number, w: number) => ((m.u = u), (m.v = w), m.vertex(x, y, frame.up(x, y, top), 0, 0, 1, cope));
      const c0 = c(ax, ay, 0, 0), c1 = c(bx, by, l, 0), c2 = c(bx + ix, by + iy, l, 0.3), c3 = c(ax + ix, ay + iy, 0, 0.3);
      m.tri(c0, c1, c2);
      m.tri(c0, c2, c3);
    }
}

/** A few boxes on large flat roofs: vents, air handlers, lift rooms. */
function rooftopUnits(m: MeshBuilder, frame: LocalFrame, outer: [number, number][], h: number, area: number, r: () => number) {
  const n = Math.min(7, Math.floor(area / 220));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const metal = [[150, 152, 154], [128, 130, 132], [172, 172, 168]];
  for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
    const w = 1.2 + r() * 2.8, d = 1.2 + r() * 2.2, hh = 0.9 + r() * 1.6, a = r() * Math.PI;
    const cx = x0 + r() * (x1 - x0), cy = y0 + r() * (y1 - y0);
    const ca = Math.cos(a), sa = Math.sin(a);
    const pts: [number, number][] = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([px, py]) => [cx + (px! * ca - py! * sa) / 2, cy + (px! * sa + py! * ca) / 2]);
    // Fully inside the roof, with a margin.
    if (!pts.every(([px, py]) => point(outer, px, py) && point(outer, px + 1.5, py) && point(outer, px - 1.5, py) && point(outer, px, py + 1.5) && point(outer, px, py - 1.5))) continue;
    i++;
    const col = metal[Math.floor(r() * metal.length)]!;
    m.mat = 6;
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = pts[k]!, [bx, by] = pts[(k + 1) % 4]!;
      const l = Math.hypot(bx - ax, by - ay), nx = (by - ay) / l, ny = -(bx - ax) / l;
      const v = (x: number, y: number, z: number, u: number) => ((m.u = u), (m.v = z), m.vertex(x, y, frame.up(x, y, h + z), nx, ny, 0, col));
      const a0 = v(ax, ay, 0, 0), b0 = v(bx, by, 0, l), b1 = v(bx, by, hh, l), a1 = v(ax, ay, hh, 0);
      m.tri(a0, b0, b1);
      m.tri(a0, b1, a1);
    }
    const t = pts.map(([x, y]) => ((m.u = x), (m.v = y), m.vertex(x, y, frame.up(x, y, h + hh), 0, 0, 1, col)));
    m.tri(t[0]!, t[1]!, t[2]!);
    m.tri(t[0]!, t[2]!, t[3]!);
  }
}

function flatRoof(m: MeshBuilder, frame: LocalFrame, rings: [number, number][][], h: number, col: readonly number[], mat = 3) {
  const flat: number[] = [];
  const holes: number[] = [];
  for (const [k, ring] of rings.entries()) {
    if (k > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring.slice(0, -1)) flat.push(x, y);
  }
  const idx = earcut(flat, holes);
  const first = m.count;
  m.mat = mat;
  for (let v = 0; v < flat.length / 2; v++) ((m.u = flat[2 * v]!), (m.v = flat[2 * v + 1]!)), m.vertex(flat[2 * v]!, flat[2 * v + 1]!, frame.up(flat[2 * v]!, flat[2 * v + 1]!, h), 0, 0, 1, col);
  for (let t = 0; t < idx.length; t += 3) m.tri(first + idx[t]!, first + idx[t + 1]!, first + idx[t + 2]!);
}

/** Hipped (or, one time in three, gabled) roof on a rectangle, 30–40° pitch, 0.4 m eaves. */
function pitchedRoof(m: MeshBuilder, frame: LocalFrame, rect: ReturnType<typeof footprintRect>, h: number, r: () => number) {
  const col = PITCHED[Math.floor(r() * PITCHED.length)]!;
  let [c0, c1, c2, c3] = rect.corners as [[number, number], [number, number], [number, number], [number, number]];
  // Make c0→c1 the long side.
  if (Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < Math.hypot(c3[0] - c0[0], c3[1] - c0[1])) [c0, c1, c2, c3] = [c1, c2, c3, c0];
  const ctr = [(c0[0] + c2[0]) / 2, (c0[1] + c2[1]) / 2];
  const grow = (c: [number, number]): [number, number] => {
    const dx = c[0] - ctr[0]!, dy = c[1] - ctr[1]!, l = Math.hypot(dx, dy) || 1;
    return [c[0] + (dx / l) * 0.55, c[1] + (dy / l) * 0.55];
  };
  [c0, c1, c2, c3] = [grow(c0), grow(c1), grow(c2), grow(c3)];
  const L = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  const W = Math.hypot(c3[0] - c0[0], c3[1] - c0[1]);
  const ux = (c1[0] - c0[0]) / L, uy = (c1[1] - c0[1]) / L;
  const pitch = (30 + r() * 10) * D2R;
  const rise = Math.min((W / 2) * Math.tan(pitch), 6);
  const gable = r() < 0.33;
  const inset = gable ? 0 : Math.min(W / 2, L / 2);
  const m03 = [(c0[0] + c3[0]) / 2, (c0[1] + c3[1]) / 2], m12 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  const r0 = [m03[0]! + ux * inset, m03[1]! + uy * inset], r1 = [m12[0]! - ux * inset, m12[1]! - uy * inset];
  const P = (p: number[], hh: number) => [p[0]!, p[1]!, frame.up(p[0]!, p[1]!, hh)];
  const e0 = P(c0, h - 0.2), e1 = P(c1, h - 0.2), e2 = P(c2, h - 0.2), e3 = P(c3, h - 0.2);
  const t0 = P(r0, h + rise), t1 = P(r1, h + rise);
  // Long slopes.
  m.face(e0, e1, t1, col); m.face(e0, t1, t0, col);
  m.face(e2, e3, t0, col); m.face(e2, t0, t1, col);
  if (gable) {
    // Gable ends are wall.
    const wall = WALLS[Math.floor(r() * 3)]!;
    m.face(e3, e0, t0, wall, 1); m.face(e1, e2, t1, wall, 1);
  } else {
    m.face(e3, e0, t0, col); m.face(e1, e2, t1, col);
  }
}

// --- trees -----------------------------------------------------------------------------

const point = (ring: [number, number][], x: number, y: number) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export interface TreeOptions {
  /** Mean spacing between trees [m] (jittered grid). */
  spacingM: number;
  /** Only place trees within this square (local frame, metres), e.g. a sub-cell. */
  bounds?: { e0: number; n0: number; e1: number; n1: number };
  /** Cap on trees per call. */
  max?: number;
}

/**
 * Low-poly trees scattered through forest polygons on a jittered grid (stable: positions
 * depend only on the world grid, so neighbouring tiles and reloads agree). Broadleaf crowns
 * are rounded 6-sided blobs, conifers two-tier cones; conifers become commoner with height.
 */
export function treeMesh(forests: OsmPolygon[], frame: LocalFrame, ground: GroundFn, o: TreeOptions): Mesh {
  const m = new MeshBuilder();
  const s = o.spacingM;
  let placed = 0;
  for (const poly of forests) {
    const rings = poly.rings.map((r) => r.map(([lon, lat]) => frame.en(lon, lat)));
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (const [x, y] of rings[0]!) { e0 = Math.min(e0, x); n0 = Math.min(n0, y); e1 = Math.max(e1, x); n1 = Math.max(n1, y); }
    if (o.bounds) { e0 = Math.max(e0, o.bounds.e0); n0 = Math.max(n0, o.bounds.n0); e1 = Math.min(e1, o.bounds.e1); n1 = Math.min(n1, o.bounds.n1); }
    for (let gy = Math.floor(n0 / s); gy * s <= n1; gy++) {
      for (let gx = Math.floor(e0 / s); gx * s <= e1; gx++) {
        if (o.max !== undefined && placed >= o.max) return m.build();
        // Grid cells are anchored in world coordinates so trees don't move between tiles.
        const [clon, clat] = frame.lonLat(gx * s, gy * s);
        const r = rng(hash(Math.round(clon * 1e5) / 1e5, Math.round(clat * 1e5) / 1e5));
        const x = (gx + r()) * s, y = (gy + r()) * s;
        if (o.bounds && (x < o.bounds.e0 || x >= o.bounds.e1 || y < o.bounds.n0 || y >= o.bounds.n1)) continue;
        if (!point(rings[0]!, x, y) || rings.slice(1).some((h) => point(h, x, y))) continue;
        const [lon, lat] = frame.lonLat(x, y);
        const g = ground(lon, lat);
        const conifer = r() < 0.25 + Math.max(0, Math.min(0.6, (g - 700) / 800));
        const H = (conifer ? 16 : 13) + r() * 10;
        const shade = 0.75 + r() * 0.4;
        const base = conifer ? [36, 52, 38] : [56, 74, 42];
        const col = base.map((v) => Math.min(255, v * shade));
        tree(m, x, y, frame.up(x, y, g - 0.5), H, conifer, col, r() * Math.PI);
        placed++;
      }
    }
  }
  return m.build();
}

/**
 * Tree instances for impostors, with the same world-anchored placement as treeMesh: per tree
 * 5 floats — east, north, up (local frame) of the base, height [m], and kind + seed packed as
 * kind (0 broadleaf, 1 conifer) + a fraction in [0, 1) for the renderer's variant choice.
 */
export function treeInstances(forests: OsmPolygon[], frame: LocalFrame, ground: GroundFn, o: TreeOptions): Float32Array {
  const out: number[] = [];
  const s = o.spacingM;
  for (const poly of forests) {
    const rings = poly.rings.map((r) => r.map(([lon, lat]) => frame.en(lon, lat)));
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (const [x, y] of rings[0]!) { e0 = Math.min(e0, x); n0 = Math.min(n0, y); e1 = Math.max(e1, x); n1 = Math.max(n1, y); }
    if (o.bounds) { e0 = Math.max(e0, o.bounds.e0); n0 = Math.max(n0, o.bounds.n0); e1 = Math.min(e1, o.bounds.e1); n1 = Math.min(n1, o.bounds.n1); }
    for (let gy = Math.floor(n0 / s); gy * s <= n1; gy++) {
      for (let gx = Math.floor(e0 / s); gx * s <= e1; gx++) {
        if (o.max !== undefined && out.length / 5 >= o.max) return new Float32Array(out);
        const [clon, clat] = frame.lonLat(gx * s, gy * s);
        const r = rng(hash(Math.round(clon * 1e5) / 1e5, Math.round(clat * 1e5) / 1e5));
        const x = (gx + r()) * s, y = (gy + r()) * s;
        if (o.bounds && (x < o.bounds.e0 || x >= o.bounds.e1 || y < o.bounds.n0 || y >= o.bounds.n1)) continue;
        if (!point(rings[0]!, x, y) || rings.slice(1).some((h) => point(h, x, y))) continue;
        const [lon, lat] = frame.lonLat(x, y);
        const g = ground(lon, lat);
        const conifer = r() < 0.25 + Math.max(0, Math.min(0.6, (g - 700) / 800));
        const H = (conifer ? 16 : 11) + r() * (conifer ? 10 : 9);
        out.push(x, y, frame.up(x, y, g - 0.3), H, (conifer ? 1 : 0) + Math.min(0.999, r()));
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Single trees in towns and parks (same 5-float instances as treeInstances): on a jittered
 * world-anchored grid through residential land (gardens, street trees: about every other
 * cell of 16 m) and parks (12 m), never on a building, within 2 m of one, or on a road.
 * Smaller than forest trees and mostly broadleaf.
 */
export function townTreeInstances(t: OsmTile, frame: LocalFrame, ground: GroundFn, bounds: { e0: number; n0: number; e1: number; n1: number }): Float32Array {
  const out: number[] = [];
  const inB = (x: number, y: number, pad: number) => x >= bounds.e0 - pad && x < bounds.e1 + pad && y >= bounds.n0 - pad && y < bounds.n1 + pad;
  const local = (r: LonLat[]) => r.map(([lon, lat]) => frame.en(lon, lat));
  const touches = (r: [number, number][], pad: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return x0 < bounds.e1 + pad && x1 > bounds.e0 - pad && y0 < bounds.n1 + pad && y1 > bounds.n0 - pad;
  };
  const buildings = t.buildings.map((b) => local(b.rings[0]!)).filter((r) => touches(r, 5));
  const roads = t.roads.map((r) => ({ pts: local(r.pts), halfM: r.halfM })).filter((r) => touches(r.pts, 10));
  const forests = t.forests.map((f) => local(f.rings[0]!)).filter((r) => touches(r, 0));
  const segDist = (px: number, py: number, a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const k = l ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l)) : 0;
    return Math.hypot(px - a[0] - k * dx, py - a[1] - k * dy);
  };
  const nearRing = (r: [number, number][], x: number, y: number, d: number) => point(r, x, y) || r.some((_, k) => k > 0 && segDist(x, y, r[k - 1]!, r[k]!) < d);
  const taken = new Set<string>();
  for (const g of t.greens) {
    const park = g.properties["kind"] === "park";
    const s = park ? 12 : 16, keep = park ? 0.6 : 0.5;
    const rings = g.rings.map(local);
    if (!touches(rings[0]!, 0)) continue;
    for (let gy = Math.floor(bounds.n0 / s); gy * s < bounds.n1; gy++)
      for (let gx = Math.floor(bounds.e0 / s); gx * s < bounds.e1; gx++) {
        const key = `${s}/${gx}/${gy}`;
        if (taken.has(key)) continue;
        const [clon, clat] = frame.lonLat(gx * s, gy * s);
        const r = rng(hash(Math.round(clon * 1e5) / 1e5, Math.round(clat * 1e5) / 1e5) ^ 0x51ed);
        const x = (gx + r()) * s, y = (gy + r()) * s;
        if (r() > keep || !inB(x, y, 0)) continue;
        if (!point(rings[0]!, x, y) || rings.slice(1).some((h) => point(h, x, y))) continue;
        taken.add(key);
        if (forests.some((f) => point(f, x, y))) continue;
        if (buildings.some((b) => nearRing(b, x, y, 2.5))) continue;
        if (roads.some((rd) => rd.pts.some((_, k) => k > 0 && segDist(x, y, rd.pts[k - 1]!, rd.pts[k]!) < rd.halfM + 1))) continue;
        const [lon, lat] = frame.lonLat(x, y);
        const gH = ground(lon, lat);
        const conifer = r() < 0.15;
        out.push(x, y, frame.up(x, y, gH - 0.2), 5 + r() * (park ? 10 : 7), (conifer ? 1 : 0) + Math.min(0.999, r()));
      }
  }
  return new Float32Array(out);
}

function tree(m: MeshBuilder, x: number, y: number, z: number, H: number, conifer: boolean, col: number[], rot: number) {
  // Crown profile: [height fraction, radius fraction] from bottom to top; radius = H/3.
  const R = conifer ? H * 0.24 : H * 0.36;
  const tiers = conifer ? [[0.12, 0.15], [0.18, 1], [0.55, 0.62], [0.6, 0.72], [1, 0]] : [[0.18, 0.25], [0.35, 0.92], [0.62, 1], [0.86, 0.6], [1, 0]];
  const N = 6;
  const ring0 = m.count;
  const dark = col.map((v) => v * 0.7);
  for (const [t, [hf, rf]] of tiers.entries()) {
    for (let k = 0; k < N; k++) {
      const a = rot + (k / N) * Math.PI * 2 + (t % 2) * (Math.PI / N);
      const cx = Math.cos(a), cy = Math.sin(a);
      // Smooth normals: mostly outward, tilted up towards the top.
      const up = conifer ? 0.45 : (hf! - 0.5) * 1.6;
      const l = Math.hypot(1, up);
      m.vertex(x + cx * R * rf!, y + cy * R * rf!, z + H * hf!, cx / l, cy / l, up / l, t === 0 ? dark : col);
    }
  }
  for (let t = 0; t < tiers.length - 1; t++) {
    for (let k = 0; k < N; k++) {
      const a = ring0 + t * N + k, b = ring0 + t * N + ((k + 1) % N);
      const c = ring0 + (t + 1) * N + k, d = ring0 + (t + 1) * N + ((k + 1) % N);
      m.tri(a, b, d);
      m.tri(a, d, c);
    }
  }
}
