/**
 * Ground detail from 10 m satellite colours: the real image sharpened (edge-aware
 * upsampling keeps every boundary where the data puts it), plus fine texture a 10 m pixel
 * can't carry. Nothing is invented at the scale of fields. Purely visual (the simulation never
 * reads it). Everything is anchored to world coordinates (metres in Web Mercator at the
 * tile), so neighbouring tiles join without seams and every visit looks the same.
 *
 * Per pixel, from the upsampled Sentinel-2 colour (and the OSM land cover when known):
 *  - cropland: the real fields as the edge-aware upsampling sharpens them, with fine grain
 *  - forest: a canopy of crowns with shadows away from the sun
 *  - grass: fine grain
 *  - water / built-up: left close to the photo (OSM vectors are drawn on top separately)
 */

/**
 * Edge-aware upsampling of a satellite tile: bilinear, then each pixel is snapped toward the
 * nearer of the two dominant colours in its 4×4 source neighbourhood (a two-means split by
 * luminance). Real boundaries (field edges, roads, forest margins) become crisp lines where
 * the data puts them, at sub-pixel precision; uniform areas stay as they are.
 * `src` is the source RGBA (n×n), the window starts at (sx0, sy0) and spans `span` source
 * pixels, written into `out` (size×size RGBA).
 */
export function edgeAwareUpsample(src: Uint8ClampedArray, n: number, sx0: number, sy0: number, span: number, out: Uint8ClampedArray, size: number, strength = 0.8): void {
  const at = (x: number, y: number, c: number) => src[(Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))) * 4 + c]!;
  const lumAt = (x: number, y: number) => 0.3 * at(x, y, 0) + 0.59 * at(x, y, 1) + 0.11 * at(x, y, 2);
  for (let j = 0; j < size; j++) {
    const sy = sy0 + ((j + 0.5) * span) / size - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let i = 0; i < size; i++) {
      const sx = sx0 + ((i + 0.5) * span) / size - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const k = (j * size + i) * 4;
      const v = [0, 0, 0];
      for (let c = 0; c < 3; c++) v[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
      // Two-means over the 4×4 neighbourhood, split at its mean luminance.
      let mean = 0;
      for (let b = -1; b <= 2; b++) for (let a = -1; a <= 2; a++) mean += lumAt(x0 + a, y0 + b);
      mean /= 16;
      const lo = [0, 0, 0], hi = [0, 0, 0];
      let nl = 0, nh = 0, ll = 0, lh = 0;
      for (let b = -1; b <= 2; b++)
        for (let a = -1; a <= 2; a++) {
          const L = lumAt(x0 + a, y0 + b);
          const t = L < mean ? lo : hi;
          for (let c = 0; c < 3; c++) t[c]! += at(x0 + a, y0 + b, c);
          if (L < mean) { nl++; ll += L; } else { nh++; lh += L; }
        }
      const vl = 0.3 * v[0]! + 0.59 * v[1]! + 0.11 * v[2]!;
      if (nl && nh && lh / nh - ll / nl > 6) {
        const t = Math.abs(vl - ll / nl) < Math.abs(vl - lh / nh) ? lo : hi;
        const m = t === lo ? nl : nh;
        for (let c = 0; c < 3; c++) v[c] = v[c]! + (t[c]! / m - v[c]!) * strength;
      }
      out[k] = v[0]!;
      out[k + 1] = v[1]!;
      out[k + 2] = v[2]!;
      out[k + 3] = 255;
    }
  }
}

import { TileSampler, type DetailTexture } from "./textures.ts";

export type Cover = "crop" | "forest" | "grass" | "water" | "urban";

/** 32-bit hash of integer coordinates (+ salt). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const u01 = (h: number) => h / 4294967296;

/** Smooth value noise in [0, 1) over world metres, cell size `s`. */
export function valueNoise(x: number, y: number, s: number, salt = 0): number {
  const fx = x / s, fy = y / s;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = u01(hash2(x0, y0, salt)), b = u01(hash2(x0 + 1, y0, salt));
  const c = u01(hash2(x0, y0 + 1, salt)), d = u01(hash2(x0 + 1, y0 + 1, salt));
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Land cover from a satellite colour (when OSM says nothing). */
export function classify(r: number, g: number, b: number): Cover {
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  const green = g - (r + b) / 2;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (b > g + 4 && b > r && lum < 90) return "water";
  if (lum < 72 && green > 1) return "forest";
  if (sat < 22 && lum > 105) return "urban";
  if (green > 14 && lum > 80) return "grass";
  return "crop";
}

/** Canopy brightness at a point: crowns on a ~4 m jittered grid, lit toward the sun, shadows away. */
function crownShade(wx: number, wy: number, o: SynthOptions): number {
  const cs = 4.2;
  const gx = Math.floor(wx / cs), gy = Math.floor(wy / cs);
  let shade = 0.72;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const h = hash2(gx + di, gy + dj, 21);
      const tx = (gx + di + 0.2 + 0.6 * u01(h)) * cs, ty = (gy + dj + 0.2 + 0.6 * u01(hash2(h, 1))) * cs;
      const rad = cs * (0.45 + 0.3 * u01(hash2(h, 2)));
      const dx = wx - tx, dy = wy - ty;
      const d = Math.hypot(dx, dy) / rad;
      if (d < 1) shade = Math.max(shade, 0.88 + 0.32 * ((dx * o.sunX + dy * o.sunY) / rad) * (1 - d) + 0.1 * (1 - d));
      const sd = Math.hypot(dx + o.sunX * rad * o.sunLow, dy + o.sunY * rad * o.sunLow) / rad;
      if (sd < 1 && d >= 1) shade = Math.min(shade, 0.62);
    }
  return shade;
}

const canopyMeans = new Map<string, number>();
/** The canopy's average brightness for this sun (sampled once). */
function canopyMean(o: SynthOptions): number {
  const key = `${o.sunX.toFixed(2)},${o.sunY.toFixed(2)},${o.sunLow.toFixed(2)}`;
  let m = canopyMeans.get(key);
  if (m === undefined) {
    let sum = 0;
    for (let i = 0; i < 4096; i++) sum += crownShade((i % 64) * 0.73 + 0.31, Math.floor(i / 64) * 0.71 + 0.17, o);
    m = sum / 4096;
    canopyMeans.set(key, m);
  }
  return m;
}

export interface SynthOptions {
  /** Tile origin (north-west corner) and pixel size, in world metres (x east, y north). */
  x0: number;
  y0: number;
  mPerPx: number;
  size: number;
  /** Sun direction (towards the sun) in the ground plane, unit; elevation factor 0..1. */
  sunX: number;
  sunY: number;
  sunLow: number;
}

/**
 * Synthesize detail into `px` (RGBA, in place) from the upsampled satellite colours
 * already in it. `cover` (optional, per pixel: 0 unknown, else index in COVERS) is the OSM
 * land cover rasterized for this tile.
 */
export const COVERS: Cover[] = ["crop", "forest", "grass", "water", "urban"];
/** HD detail textures for the open ground (optional: without them, procedural grain). */
export interface GroundTextures {
  grass: DetailTexture;
  dryGrass: DetailTexture;
  soil: DetailTexture;
  drySoil: DetailTexture;
  /** Paved yards and lots in built-up areas. */
  paved: DetailTexture;
}

/** Near-ground colours: summer grass, dry grass, bare soil; and how far they replace the satellite's. */
export const LUSH = [98, 128, 56], DRY = [142, 136, 78], SOIL = [124, 100, 74];
export const NEAR_COLOUR = 0.6;

/** Lush/dry blend of two textures at the sampler's current point into out. */
function mixInto(ts: TileSampler, lush: DetailTexture, dryT: DetailTexture, dry: number, a: Float32Array, b: Float32Array, out: Float32Array): void {
  if (dry < 0.08) return ts.sample(lush, out);
  if (dry > 0.92) return ts.sample(dryT, out);
  ts.sample(lush, a);
  ts.sample(dryT, b);
  for (let c = 0; c < 3; c++) out[c] = a[c]! + (b[c]! - a[c]!) * dry;
}

export function synthesize(px: Uint8ClampedArray, o: SynthOptions, cover?: Uint8Array, tex?: GroundTextures, smooth?: Uint8ClampedArray): void {
  const ra = new Float32Array(3), rb = new Float32Array(3);
  const ts = new TileSampler(o.mPerPx, { x: o.sunX, y: o.sunY, low: o.sunLow });
  const gr = new Float32Array(3), so = new Float32Array(3);
  const { size, mPerPx } = o;
  for (let j = 0; j < size; j++) {
    const wy = o.y0 - (j + 0.5) * mPerPx;
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      const wx = o.x0 + (i + 0.5) * mPerPx;
      // No recolouring: the detail tiles border plain Sentinel-2 tiles and must match them.
      let r = px[k]!, g = px[k + 1]!, b = px[k + 2]!;
      const c = cover && cover[j * size + i] ? COVERS[cover[j * size + i]! - 1]! : classify(r, g, b);
      // Built-up ground: the plain (unsnapped) upsampling; snapping a smear of roofs and
      // shadows gives jagged patches.
      if (c === "urban" && smooth) {
        r = smooth[k]!;
        g = smooth[k + 1]!;
        b = smooth[k + 2]!;
      }
      let f = 1, tr = 1, tg = 1, tb = 1;
      if ((c === "crop" || c === "grass") && tex) {
        // Retexture open ground with HD photos: grass where the satellite pixel is green,
        // soil where it is brown, a blend in between; dry and lush variants in patches of a
        // few hundred metres. Ratios to the texture means: the real colours stay.
        const green = g - (r + b) / 2;
        const t = Math.min(1, Math.max(0, (green - 1) / 12));
        const dry = valueNoise(wx, wy, 240, 71);
        ts.at(wx, wy);
        // Sample only what this pixel uses (most are all grass or all soil, lush or dry);
        // no allocation per pixel.
        if (t > 0.02) mixInto(ts, tex.grass, tex.dryGrass, dry, ra, rb, gr);
        else gr[0] = gr[1] = gr[2] = 1;
        if (t < 0.98) mixInto(ts, tex.soil, tex.drySoil, dry, ra, rb, so);
        else so[0] = so[1] = so[2] = 1;
        tr = so[0]! + (gr[0]! - so[0]!) * t;
        tg = so[1]! + (gr[1]! - so[1]!) * t;
        tb = so[2]! + (gr[2]! - so[2]!) * t;
        // Close to the ground the satellite's dark, hazy average gives way to the colours
        // grass and soil have at arm's length (eases in below 2 m per pixel, so zoom levels
        // blend into each other); the satellite still modulates it.
        const near = NEAR_COLOUR * Math.min(1, Math.max(0, (2 - mPerPx) / 1.7));
        if (near > 0) {
          const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 70; // relative to a typical field
          const k = Math.min(1.25, Math.max(0.75, lum));
          for (let ch = 0; ch < 3; ch++) {
            const grassC = LUSH[ch]! + (DRY[ch]! - LUSH[ch]!) * dry, target = (SOIL[ch]! + (grassC - SOIL[ch]!) * t) * k;
            if (ch === 0) r += (target - r) * near;
            else if (ch === 1) g += (target - g) * near;
            else b += (target - b) * near;
          }
        }
      } else if (c === "crop") {
        // (value noise averages 0.5: every factor here averages 1, so tones match Sentinel-2.)
        f = (1 + (valueNoise(wx, wy, 1.2, 8) - 0.5) * (mPerPx < 1 ? 0.1 : 0.04)) * (1 + (valueNoise(wx, wy, 7, 9) - 0.5) * 0.06);
      } else if (c === "forest") {
        // Canopy (crowns, sun-side highlights, shadows), divided by its own average so the
        // forest keeps its Sentinel-2 tone.
        f = mPerPx < 1 ? crownShade(wx, wy, o) / canopyMean(o) : 1 + (valueNoise(wx, wy, 6, 22) - 0.5) * 0.1;
      } else if (c === "grass") {
        // Grass: blades (sub-metre), tufts (metres), patches (tens of metres); mean 1.
        f = 1 + (valueNoise(wx, wy, 0.7, 31) - 0.5) * (mPerPx < 0.8 ? 0.16 : 0.05) + (valueNoise(wx, wy, 4, 33) - 0.5) * 0.1 + (valueNoise(wx, wy, 35, 32) - 0.5) * 0.08;
      } else if (c === "urban" && tex) {
        // Built-up ground between the buildings: lawns where the satellite is green, paved
        // yards and lots elsewhere. The 10 m pixels there are a smear of roofs, walls and
        // shadows: up close (below ~3 m per pixel) lawn and paving get the colours they have
        // at arm's length, and the edge between them is crisp and irregular (a metre-scale
        // noise moves it), not a 10 m blur.
        const green = g - (r + b) / 2;
        const near = Math.min(1, Math.max(0, (5.5 - mPerPx) / 3));
        const edge = (valueNoise(wx, wy, 3.5, 91) - 0.5) * 10 + (valueNoise(wx, wy, 0.9, 92) - 0.5) * 3;
        const soft = Math.min(1, Math.max(0, (green - 2) / 10));
        const hard = green + edge > 1 ? 1 : 0;
        const t = soft + (hard - soft) * near;
        const dry = valueNoise(wx, wy, 60, 93);
        ts.at(wx, wy);
        if (t > 0.02) mixInto(ts, tex.grass, tex.dryGrass, dry * 0.7, ra, rb, gr);
        else gr[0] = gr[1] = gr[2] = 1;
        if (t < 0.98) {
          ts.sample(tex.paved, so);
          // The asphalt photo has dark cracks and patches: half its contrast for yards.
          for (let ch = 0; ch < 3; ch++) so[ch] = 1 + (so[ch]! - 1) * 0.45;
        } else so[0] = so[1] = so[2] = 1;
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        const k = Math.min(1.2, Math.max(0.8, lum / 105));
        // Paving: concrete to asphalt grey in patches of tens of metres; worn lawn: grass
        // with trodden soil showing through.
        const pave = Math.min(150, Math.max(70, lum)) * (0.9 + 0.2 * valueNoise(wx, wy, 23, 94)) / k; // keeps the local tone (k is applied below)
        const worn = Math.max(0, valueNoise(wx, wy, 6, 95) - 0.55) * 1.6;
        const pull = 0.7 * Math.min(1, Math.max(0, (6 - mPerPx) / 3)); // eases in with zoom (none where tiles meet plain Sentinel-2)
        for (let ch = 0; ch < 3; ch++) {
          const grassC = (LUSH[ch]! + (DRY[ch]! - LUSH[ch]!) * dry * 0.7) * (1 - worn) + SOIL[ch]! * worn;
          const target = (pave * (ch === 2 ? 0.97 : 1) + (grassC - pave * (ch === 2 ? 0.97 : 1)) * t) * k;
          if (ch === 0) r += (target - r) * pull;
          else if (ch === 1) g += (target - g) * pull;
          else b += (target - b) * pull;
        }
        tr = so[0]! + (gr[0]! - so[0]!) * t;
        tg = so[1]! + (gr[1]! - so[1]!) * t;
        tb = so[2]! + (gr[2]! - so[2]!) * t;
      } else if (c === "urban") {
        f = 1 + (valueNoise(wx, wy, 2, 41) - 0.5) * 0.08;
      } else {
        f = 1 + (valueNoise(wx, wy, 8, 51) - 0.5) * 0.04;
      }
      r *= f * tr;
      g *= f * tg;
      b *= f * tb;
      px[k] = r;
      px[k + 1] = g;
      px[k + 2] = b;
    }
  }
}
