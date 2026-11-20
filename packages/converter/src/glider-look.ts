/**
 * A finer look for a glider's outside, made at bundle time from its own FlightGear texture
 * (GPL, like the rest of the bundle; visual only):
 *  - Base colour at 4096² (the 2048² atlas, or a livery of it, enlarged with a Lanczos filter), with a little bug
 *    spatter along the wings' leading edges and grime on the belly behind the wheel.
 *  - Ambient occlusion baked by casting rays against the whole model (wing roots, the cockpit
 *    rim, control-surface gaps and the wheel well darken where the sky's light can't reach),
 *    1024² enlarged to 4096².
 *  - Roughness from the colours: glossy gelcoat, matt rubber, labels in between.
 *  - A clearcoat (KHR_materials_clearcoat) on the gelcoat: the polished, sky-reflecting finish
 *    of a glider; and glass that is smooth (it was roughness 0.5: a milky canopy).
 * AO, roughness and metallic go in one texture (R, G, B), as glTF allows.
 */
import type { GlbImage, GlbMaterial, GlbNode, GlbPrimitive } from "./glb.ts";
import { decodePng, encodePng, upscale2x, type Rgba } from "./png.ts";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Bounding-volume tree over triangles, for "is anything within d along this ray?" */
class Bvh {
  private readonly tri: Float32Array; // per triangle: v0 (3), e1 (3), e2 (3)
  private readonly nodes: Float32Array; // per node: min (3), max (3)
  private readonly meta: Int32Array; // per node: left/first, count (0: inner)
  private readonly order: Int32Array;
  private n = 0;

  constructor(tris: Float32Array) {
    const count = tris.length / 9;
    this.tri = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      this.tri[o] = tris[o]!;
      this.tri[o + 1] = tris[o + 1]!;
      this.tri[o + 2] = tris[o + 2]!;
      for (let k = 0; k < 3; k++) {
        this.tri[o + 3 + k] = tris[o + 3 + k]! - tris[o + k]!;
        this.tri[o + 6 + k] = tris[o + 6 + k]! - tris[o + k]!;
      }
    }
    this.order = new Int32Array(count).map((_, i) => i);
    this.nodes = new Float32Array(count * 2 * 6);
    this.meta = new Int32Array(count * 2 * 2);
    const cen = new Float32Array(count * 3);
    for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) cen[t * 3 + k] = (tris[t * 9 + k]! + tris[t * 9 + 3 + k]! + tris[t * 9 + 6 + k]!) / 3;
    const build = (lo: number, hi: number): number => {
      const id = this.n++;
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = lo; i < hi; i++) {
        const t = this.order[i]!;
        for (let v = 0; v < 3; v++)
          for (let k = 0; k < 3; k++) {
            const x = tris[t * 9 + v * 3 + k]!;
            if (x < b[k]!) b[k] = x;
            if (x > b[3 + k]!) b[3 + k] = x;
          }
      }
      this.nodes.set(b, id * 6);
      if (hi - lo <= 4) {
        this.meta[id * 2] = lo;
        this.meta[id * 2 + 1] = hi - lo;
        return id;
      }
      const ax = [0, 1, 2].reduce((a, k) => (b[3 + k]! - b[k]! > b[3 + a]! - b[a]! ? k : a), 0);
      const part = this.order.subarray(lo, hi).sort((p, q) => cen[p * 3 + ax]! - cen[q * 3 + ax]!);
      this.order.set(part, lo);
      const mid = (lo + hi) >> 1;
      build(lo, mid);
      const right = build(mid, hi);
      this.meta[id * 2] = right;
      this.meta[id * 2 + 1] = 0;
      return id;
    };
    build(0, count);
  }

  /** Whether a triangle lies within maxT of o along unit d. */
  hits(o: V3, d: V3, maxT: number): boolean {
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    const stack = new Int32Array(64);
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const id = stack[--sp]!;
      const nb = id * 6;
      let t0 = 0, t1 = maxT;
      for (let k = 0; k < 3; k++) {
        let a = (this.nodes[nb + k]! - o[k]!) * inv[k]!, b = (this.nodes[nb + 3 + k]! - o[k]!) * inv[k]!;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) break;
      }
      if (t0 > t1) continue;
      const count = this.meta[id * 2 + 1]!;
      if (count === 0) {
        stack[sp++] = id + 1;
        stack[sp++] = this.meta[id * 2]!;
        continue;
      }
      const first = this.meta[id * 2]!;
      for (let i = first; i < first + count; i++) {
        const t = this.order[i]! * 9, T = this.tri;
        // Möller–Trumbore.
        const e1: V3 = [T[t + 3]!, T[t + 4]!, T[t + 5]!], e2: V3 = [T[t + 6]!, T[t + 7]!, T[t + 8]!];
        const p = cross(d, e2), det = dot(e1, p);
        if (Math.abs(det) < 1e-9) continue;
        const s: V3 = [o[0] - T[t]!, o[1] - T[t + 1]!, o[2] - T[t + 2]!];
        const u = dot(s, p) / det;
        if (u < 0 || u > 1) continue;
        const q = cross(s, e1), v = dot(d, q) / det;
        if (v < 0 || u + v > 1) continue;
        const dist = dot(e2, q) / det;
        if (dist > 1e-4 && dist < maxT) return true;
      }
    }
    return false;
  }
}

const AO_RES = 1024;
const AO_RAYS = 24;
const AO_REACH_M = 1.5;

/** Small deterministic hash → [0, 1). */
const hash = (a: number, b: number, c = 0) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

interface Grid {
  /** Covered texels: 1. */
  mask: Uint8Array;
  pos: Float32Array;
  nrm: Float32Array;
}

/** The exterior's surface position and normal at each texel centre of a res² texture. */
function rasterise(prims: { p: GlbPrimitive }[], res: number): Grid {
  const g: Grid = { mask: new Uint8Array(res * res), pos: new Float32Array(res * res * 3), nrm: new Float32Array(res * res * 3) };
  for (const { p } of prims) {
    if (!p.uvs) continue;
    const ix = p.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]!, b = ix[t + 1]!, c = ix[t + 2]!;
      const u = [a, b, c].map((i) => [p.uvs![i * 2]! * res, p.uvs![i * 2 + 1]! * res]) as [number, number][];
      const x0 = Math.max(0, Math.floor(Math.min(u[0]![0], u[1]![0], u[2]![0]))), x1 = Math.min(res - 1, Math.ceil(Math.max(u[0]![0], u[1]![0], u[2]![0])));
      const y0 = Math.max(0, Math.floor(Math.min(u[0]![1], u[1]![1], u[2]![1]))), y1 = Math.min(res - 1, Math.ceil(Math.max(u[0]![1], u[1]![1], u[2]![1])));
      const den = (u[1]![1] - u[2]![1]) * (u[0]![0] - u[2]![0]) + (u[2]![0] - u[1]![0]) * (u[0]![1] - u[2]![1]);
      if (Math.abs(den) < 1e-12) continue;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((u[1]![1] - u[2]![1]) * (px - u[2]![0]) + (u[2]![0] - u[1]![0]) * (py - u[2]![1])) / den;
          const w1 = ((u[2]![1] - u[0]![1]) * (px - u[2]![0]) + (u[0]![0] - u[2]![0]) * (py - u[2]![1])) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const o = y * res + x;
          g.mask[o] = 1;
          for (let k = 0; k < 3; k++) {
            g.pos[o * 3 + k] = w0 * p.positions[a * 3 + k]! + w1 * p.positions[b * 3 + k]! + w2 * p.positions[c * 3 + k]!;
            g.nrm[o * 3 + k] = w0 * p.normals[a * 3 + k]! + w1 * p.normals[b * 3 + k]! + w2 * p.normals[c * 3 + k]!;
          }
        }
    }
  }
  return g;
}

/** Fill uncovered texels from covered neighbours, n passes (no seams in mipmaps). */
function dilate(v: Float32Array, mask: Uint8Array, res: number, passes: number): void {
  const m = mask.slice();
  for (let p = 0; p < passes; p++) {
    const add: [number, number][] = [];
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const o = y * res + x;
        if (m[o]) continue;
        let s = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= res || yy >= res) continue;
          const q = yy * res + xx;
          if (m[q]) (s += v[q]!), n++;
        }
        if (n) add.push([o, s / n]);
      }
    for (const [o, val] of add) (v[o] = val), (m[o] = 1);
  }
}

export interface ExteriorLookResult {
  warnings: string[];
  aoMean?: number | undefined;
  ms?: number;
}

/**
 * Gives material `name` (the glider's outside) the finer look; adds images. Glass materials
 * (translucent) get a smooth surface. Mutates materials and images.
 */
export function improveExterior(nodes: readonly GlbNode[], materials: GlbMaterial[], images: GlbImage[], name: string, opts: { livery?: Uint8Array } = {}): ExteriorLookResult {
  const t0 = Date.now();
  const warnings: string[] = [];
  // Glass: smooth, so the canopy reflects the sky instead of looking milky.
  for (const m of materials)
    if (m.baseColor[3] < 1) {
      m.roughness = 0.04;
      m.clearcoat = { factor: 1, roughness: 0.02 };
    }
  const mi = materials.findIndex((m) => m.name === name);
  const mat = materials[mi];
  if (!mat || mat.image === undefined) return { warnings: [`exterior material ${name} not found or untextured`] };
  const src = images[mat.image]!;
  if (src.mimeType !== "image/png") return { warnings: [`exterior texture of ${name} is not a PNG`] };
  // A livery (same UV layout) in place of the plain texture, when given.
  const base = decodePng(opts.livery ?? src.data);

  // Every opaque triangle occludes; the exterior's own are the ones baked.
  const all: number[] = [];
  const exterior: { p: GlbPrimitive; node: string }[] = [];
  for (const n of nodes)
    for (const p of n.primitives ?? []) {
      const m = materials[p.material]!;
      if (m.baseColor[3] < 1) continue;
      for (let t = 0; t < p.indices.length; t += 3) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) all.push(p.positions[p.indices[t + v]! * 3 + k]!);
      if (p.material === mi) exterior.push({ p, node: n.name });
    }
  const bvh = new Bvh(new Float32Array(all));

  // Axes from the parts: span (wings), up (fin over the fuselage), forward (canopy ahead).
  const centroid = (re: RegExp) => {
    const s: V3 = [0, 0, 0];
    let n = 0;
    for (const e of exterior)
      if (re.test(e.node))
        for (let i = 0; i < e.p.positions.length; i += 3) (s[0] += e.p.positions[i]!), (s[1] += e.p.positions[i + 1]!), (s[2] += e.p.positions[i + 2]!), n++;
    return n ? ([s[0] / n, s[1] / n, s[2] / n] as V3) : undefined;
  };
  const fus = centroid(/^fuselage/), fin = centroid(/^rudder/), canopy = centroid(/^canopy/);
  // The model's axes: fore-aft along the fuselage's longest extent, span the other horizontal
  // one (the wings' widest), up the third, pointing to the fin; forward points to the canopy.
  const ext: V3 = [0, 0, 0], wext: V3 = [0, 0, 0];
  for (const e of exterior) {
    const target = /^fuselage/.test(e.node) ? ext : /^wing/.test(e.node) ? wext : undefined;
    if (!target) continue;
    for (let i = 0; i < e.p.positions.length; i += 3) for (let k = 0; k < 3; k++) target[k] = Math.max(target[k]!, Math.abs(e.p.positions[i + k]! - (fus?.[k] ?? 0)));
  }
  const axis = (k: number): V3 => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  const kLong = [0, 1, 2].reduce((a, k) => (ext[k]! > ext[a]! ? k : a), 0);
  const kSpan = [0, 1, 2].filter((k) => k !== kLong).reduce((a, k) => (wext[k]! > wext[a]! ? k : a));
  const kUp = 3 - kLong - kSpan;
  const up = axis(kUp), span = axis(kSpan);
  if (fus && fin && fin[kUp]! < fus[kUp]!) up[kUp] = -1;
  const fwd = axis(kLong);
  if (canopy && fin && canopy[kLong]! < fin[kLong]!) fwd[kLong] = -1;

  // Ambient occlusion at AO_RES².
  const g = rasterise(exterior, AO_RES);
  const ao = new Float32Array(AO_RES * AO_RES).fill(1);
  let sum = 0, cnt = 0;
  for (let o = 0; o < AO_RES * AO_RES; o++) {
    if (!g.mask[o]) continue;
    const p: V3 = [g.pos[o * 3]!, g.pos[o * 3 + 1]!, g.pos[o * 3 + 2]!];
    let n = norm([g.nrm[o * 3]!, g.nrm[o * 3 + 1]!, g.nrm[o * 3 + 2]!]);
    const occl = (nn: V3) => {
      const tg = norm(Math.abs(nn[0]) < 0.9 ? cross(nn, [1, 0, 0]) : cross(nn, [0, 1, 0])), bt = cross(nn, tg);
      const org: V3 = [p[0] + nn[0] * 0.004, p[1] + nn[1] * 0.004, p[2] + nn[2] * 0.004];
      let hit = 0;
      const rot = hash(o, 7) * 2 * Math.PI;
      for (let r = 0; r < AO_RAYS; r++) {
        // Cosine-weighted, stratified in rings, rotated per texel.
        const u1 = (r + hash(o, r)) / AO_RAYS, phi = rot + r * 2.39996323;
        const sr = Math.sqrt(u1), z = Math.sqrt(1 - u1);
        const d = norm([tg[0] * sr * Math.cos(phi) + bt[0] * sr * Math.sin(phi) + nn[0] * z, tg[1] * sr * Math.cos(phi) + bt[1] * sr * Math.sin(phi) + nn[1] * z, tg[2] * sr * Math.cos(phi) + bt[2] * sr * Math.sin(phi) + nn[2] * z]);
        if (bvh.hits(org, d, AO_REACH_M)) hit++;
      }
      return 1 - hit / AO_RAYS;
    };
    let a = occl(n);
    // A normal facing into the part (inconsistent winding in the source): the other side.
    if (a < 0.2) {
      n = [-n[0], -n[1], -n[2]];
      a = Math.max(a, occl(n));
    }
    ao[o] = a;
    sum += a;
    cnt++;
  }
  dilate(ao, g.mask, AO_RES, 6);

  // Base colour at 4096², with bugs on the leading edges and belly grime.
  const hi = upscale2x(base);
  const S = hi.width, scale = S / AO_RES;
  const wheel = centroid(/^wheelM/);
  for (let y = 0; y < AO_RES; y++)
    for (let x = 0; x < AO_RES; x++) {
      const o = y * AO_RES + x;
      if (!g.mask[o]) continue;
      const p: V3 = [g.pos[o * 3]!, g.pos[o * 3 + 1]!, g.pos[o * 3 + 2]!];
      const n = norm([g.nrm[o * 3]!, g.nrm[o * 3 + 1]!, g.nrm[o * 3 + 2]!]);
      const lateral = fus ? Math.abs(dot(sub(p, fus), span)) : 0;
      // Bugs: on the wings' (and fin's) leading edges, sparse small splats.
      if (dot(n, fwd) > 0.85 && lateral > 0.8 && hash(x, y, 3) < 0.025) {
        const cx = (x + hash(x, y, 4)) * scale, cy = (y + hash(x, y, 5)) * scale, r = 1 + 1.4 * hash(x, y, 6), al = 0.2 + 0.25 * hash(x, y, 8);
        for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++)
          for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            const f = Math.max(0, 1 - Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) / r) * al;
            const q = (yy * S + xx) * 4;
            hi.data[q] = Math.round(hi.data[q]! * (1 - f) + 92 * f);
            hi.data[q + 1] = Math.round(hi.data[q + 1]! * (1 - f) + 80 * f);
            hi.data[q + 2] = Math.round(hi.data[q + 2]! * (1 - f) + 52 * f);
          }
      }
      // Belly behind the main wheel: a light streak of grime.
      if (wheel && dot(n, up) < -0.4) {
        const along = -dot(sub(p, wheel), fwd); // metres behind the wheel
        if (along > -0.3 && along < 3.5) {
          const k = 0.1 * Math.exp(-Math.max(0, along) / 1.6) * (0.6 + 0.4 * hash(x >> 2, y >> 2, 9));
          for (let yy = y * scale; yy < (y + 1) * scale; yy++)
            for (let xx = x * scale; xx < (x + 1) * scale; xx++) {
              const q = (yy * S + xx) * 4;
              hi.data[q] = Math.round(hi.data[q]! * (1 - k) + 120 * k);
              hi.data[q + 1] = Math.round(hi.data[q + 1]! * (1 - k) + 108 * k);
              hi.data[q + 2] = Math.round(hi.data[q + 2]! * (1 - k) + 90 * k);
            }
        }
      }
    }

  // Occlusion (R), roughness (G), metallic (B) at 4096²; clearcoat strength (R) at 1024².
  const orm: Rgba = { width: S, height: S, data: new Uint8Array(S * S * 4) };
  const coat: Rgba = { width: AO_RES, height: AO_RES, data: new Uint8Array(AO_RES * AO_RES * 4) };
  const aoAt = (fx: number, fy: number) => {
    const x = Math.min(AO_RES - 1.001, Math.max(0, fx - 0.5)), y = Math.min(AO_RES - 1.001, Math.max(0, fy - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const v = (xx: number, yy: number) => ao[yy * AO_RES + xx]!;
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  };
  const surf = (r: number, gg: number, b: number) => {
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), lum = (0.3 * r + 0.59 * gg + 0.11 * b) / 255, sat = mx ? (mx - mn) / mx : 0;
    // Gelcoat (light, unsaturated): glossy, coated. Rubber (dark): matt. Paint, labels: between.
    if (lum > 0.72 && sat < 0.15) return { rough: 0.35, coat: 1 };
    if (lum < 0.16) return { rough: 0.85, coat: 0 };
    return { rough: 0.5, coat: 0.6 };
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const q = (y * S + x) * 4;
      const s = surf(hi.data[q]!, hi.data[q + 1]!, hi.data[q + 2]!);
      orm.data[q] = Math.round(255 * aoAt((x + 0.5) / scale, (y + 0.5) / scale));
      orm.data[q + 1] = Math.round(255 * s.rough);
      orm.data[q + 2] = 0;
      orm.data[q + 3] = 255;
    }
  for (let y = 0; y < AO_RES; y++)
    for (let x = 0; x < AO_RES; x++) {
      const q0 = ((y * scale + 2) * S + x * scale + 2) * 4, q = (y * AO_RES + x) * 4;
      const v = Math.round(255 * surf(hi.data[q0]!, hi.data[q0 + 1]!, hi.data[q0 + 2]!).coat);
      coat.data.set([v, v, v, 255], q);
    }

  const add = (img: Rgba, rgb: boolean) => images.push({ mimeType: "image/png", data: encodePng(img, { rgb }) }) - 1;
  mat.image = add(hi, false);
  mat.orm = add(orm, true);
  mat.roughness = 1;
  mat.clearcoat = { factor: 1, roughness: 0.03, image: add(coat, true) };
  warnings.push(`exterior look axes: fore-aft ${"xyz"[kLong]}${fwd[kLong]! > 0 ? "+" : "-"}, up ${"xyz"[kUp]}${up[kUp]! > 0 ? "+" : "-"}, span ${"xyz"[kSpan]}`);
  return { warnings, aoMean: cnt ? sum / cnt : undefined, ms: Date.now() - t0 };
}
