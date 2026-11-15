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
}

export function osmFromTile(data: Uint8Array, z: number, x: number, y: number): OsmTile {
  const t: OsmTile = { buildings: [], forests: [] };
  for (const layer of decodeMvt(data)) {
    if (layer.name === "building") t.buildings = polygonsFromLayer(layer, z, x, y, () => true, true);
    else if (layer.name === "landcover") t.forests = polygonsFromLayer(layer, z, x, y, (p) => p["class"] === "wood");
  }
  return t;
}

export async function fetchOsm(url: string, z: number, x: number, y: number): Promise<OsmTile> {
  const r = await fetch(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  if (!r.ok) return { buildings: [], forests: [] };
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
}

class MeshBuilder {
  p: number[] = [];
  nrm: number[] = [];
  c: number[] = [];
  i: number[] = [];
  get count() {
    return this.p.length / 3;
  }
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, col: readonly number[]): number {
    this.p.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.c.push(col[0]!, col[1]!, col[2]!, 255);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }
  /** A flat-shaded triangle (own vertices, face normal pointing away from `inside`). */
  face(a: number[], b: number[], c: number[], col: readonly number[]) {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // roofs face up
    const i0 = this.vertex(a[0]!, a[1]!, a[2]!, nx, ny, nz, col);
    const i1 = this.vertex(b[0]!, b[1]!, b[2]!, nx, ny, nz, col);
    const i2 = this.vertex(c[0]!, c[1]!, c[2]!, nx, ny, nz, col);
    this.tri(i0, i1, i2);
  }
  build(): Mesh {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.nrm), colors: new Uint8Array(this.c), indices: new Uint32Array(this.i) };
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

/** Plaster, render and brick wall colours of central-European towns. */
const WALLS = [[236, 230, 216], [228, 218, 196], [240, 236, 228], [222, 204, 176], [232, 214, 200], [214, 210, 202], [226, 222, 206], [196, 150, 120]];
/** Pitched roofs: clay tiles, weathered tiles, slate/metal. */
const PITCHED = [[168, 84, 58], [150, 76, 56], [128, 70, 54], [176, 102, 70], [98, 92, 90], [84, 86, 92]];
/** Flat roofs: gravel, bitumen, metal. */
const FLAT = [[150, 148, 142], [124, 122, 118], [168, 166, 160], [110, 112, 116]];

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
    const wall = WALLS[Math.floor(r() * WALLS.length)]!;
    // Walls reach 1 m below the ground so slopes and terrain smoothing hide no gap.
    const h0 = base - 1;
    const h1 = base + Math.max(2.5, tall) - Number(poly.properties["render_min_height"] ?? 0);
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
        const a0 = m.vertex(ax, ay, frame.up(ax, ay, h0), nx, ny, 0, wall);
        const b0 = m.vertex(bx, by, frame.up(bx, by, h0), nx, ny, 0, wall);
        const b1 = m.vertex(bx, by, frame.up(bx, by, h1), nx, ny, 0, wall);
        const a1 = m.vertex(ax, ay, frame.up(ax, ay, h1), nx, ny, 0, wall);
        m.tri(a0, b0, b1);
        m.tri(a0, b1, a1);
      }
    }
    const rect = rings.length === 1 && outer.length <= 14 && tall <= 14 ? footprintRect(outer) : undefined;
    if (rect && rect.fill > 0.82 && rect.short <= 24 && rect.short >= 4) pitchedRoof(m, frame, rect, h1, r);
    else flatRoof(m, frame, rings, h1, FLAT[Math.floor(r() * FLAT.length)]!);
  }
  return m.build();
}

function flatRoof(m: MeshBuilder, frame: LocalFrame, rings: [number, number][][], h: number, col: readonly number[]) {
  const flat: number[] = [];
  const holes: number[] = [];
  for (const [k, ring] of rings.entries()) {
    if (k > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring.slice(0, -1)) flat.push(x, y);
  }
  const idx = earcut(flat, holes);
  const first = m.count;
  for (let v = 0; v < flat.length / 2; v++) m.vertex(flat[2 * v]!, flat[2 * v + 1]!, frame.up(flat[2 * v]!, flat[2 * v + 1]!, h), 0, 0, 1, col);
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
    m.face(e3, e0, t0, wall); m.face(e1, e2, t1, wall);
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
        const shade = 0.8 + r() * 0.35;
        const base = conifer ? [52, 74, 50] : [74, 98, 52];
        const col = base.map((v) => Math.min(255, v * shade));
        tree(m, x, y, frame.up(x, y, g - 0.5), H, conifer, col, r() * Math.PI);
        placed++;
      }
    }
  }
  return m.build();
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
