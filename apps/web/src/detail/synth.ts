/**
 * Ground detail synthesized from 10 m satellite colours: what a sharp aerial photo would
 * show at that place, inferred from the blurry one. Purely visual (the simulation never
 * reads it). Everything is anchored to world coordinates (metres in Web Mercator at the
 * tile), so neighbouring tiles join without seams and every visit looks the same.
 *
 * Per pixel, from the upsampled Sentinel-2 colour (and the OSM land cover when known):
 *  - cropland: parcels of narrow strip fields (the Romanian/Eastern-European pattern), each
 *    strip tinted around the real colour, with furrows along it
 *  - forest: a canopy of crowns with shadows away from the sun
 *  - grass: fine grain
 *  - water / built-up: left close to the photo (OSM vectors are drawn on top separately)
 */

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

const PARCEL_M = 420;
/** Crop tones (summer): green crops, maize, wheat/stubble, ploughed soil, sunflower. */
const CROPS: [number, number, number][] = [
  [104, 128, 62],
  [86, 116, 54],
  [178, 160, 102],
  [196, 176, 118],
  [128, 108, 82],
  [112, 96, 74],
  [140, 140, 70],
  [96, 120, 70],
];

/**
 * The strip field at a world point: parcel (jittered grid, nearest seed), its orientation,
 * the strip index across it, and the position along/across the strip [m].
 */
export function stripAt(x: number, y: number): { parcel: number; strip: number; across: number; along: number; widthM: number } {
  const cx = Math.floor(x / PARCEL_M), cy = Math.floor(y / PARCEL_M);
  let best = Infinity, px = 0, py = 0, pid = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const h = hash2(cx + i, cy + j, 11);
      const sx = (cx + i + 0.15 + 0.7 * u01(h)) * PARCEL_M, sy = (cy + j + 0.15 + 0.7 * u01(hash2(h, 7))) * PARCEL_M;
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < best) { best = d; px = sx; py = sy; pid = h; }
    }
  // Orientation: mostly near one regional direction (fields follow roads and valleys), with
  // the parcel's own twist.
  const region = valueNoise(px, py, 6000, 3) * Math.PI; // per parcel: straight strips
  const ang = region + (u01(hash2(pid, 1)) - 0.5) * 1.2 + (u01(hash2(pid, 2)) < 0.35 ? Math.PI / 2 : 0);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const along = (x - px) * ux + (y - py) * uy;
  const acrossRaw = -(x - px) * uy + (y - py) * ux;
  const widthM = 14 + 46 * u01(hash2(pid, 3)) ** 1.5;
  const strip = Math.floor(acrossRaw / widthM);
  return { parcel: pid, strip, across: acrossRaw - strip * widthM, along, widthM };
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
/** Lift and stretch an 8-bit channel (gamma 0.85, contrast 1.12 around mid-grey). */
const LIFT = Array.from({ length: 256 }, (_, v) => Math.max(0, Math.min(255, (255 * Math.pow(v / 255, 0.85) - 110) * 1.12 + 118)));
const lift = (v: number) => LIFT[v]!;

export const COVERS: Cover[] = ["crop", "forest", "grass", "water", "urban"];
export function synthesize(px: Uint8ClampedArray, o: SynthOptions, cover?: Uint8Array): void {
  const { size, mPerPx } = o;
  for (let j = 0; j < size; j++) {
    const wy = o.y0 - (j + 0.5) * mPerPx;
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      const wx = o.x0 + (i + 0.5) * mPerPx;
      // Levels: Sentinel-2 cloudless is dark and flat next to aerial photos.
      let r = lift(px[k]!), g = lift(px[k + 1]!), b = lift(px[k + 2]!);
      const c = cover && cover[j * size + i] ? COVERS[cover[j * size + i]! - 1]! : classify(r, g, b);
      let f = 1, tr = 1, tg = 1, tb = 1;
      if (c === "crop") {
        const s = stripAt(wx, wy);
        const h = hash2(s.parcel, s.strip, 5);
        // Each strip a crop of its own, pulled from the real colour toward that crop's tone.
        const crop = CROPS[h % CROPS.length]!;
        const mix = 0.32 + 0.18 * u01(hash2(h, 4));
        r = r * (1 - mix) + crop[0] * mix;
        g = g * (1 - mix) + crop[1] * mix;
        b = b * (1 - mix) + crop[2] * mix;
        const pitch = 1.1 + 1.4 * u01(hash2(h, 6));
        // Furrows only where a pixel resolves them (else they alias into hatching).
        const fur = mPerPx * 2.5 < pitch ? 0.95 + 0.05 * Math.cos((s.across / pitch) * 2 * Math.PI) : 1;
        // A narrow grassy margin between strips.
        const edge = Math.min(s.across, s.widthM - s.across);
        const border = edge < Math.max(0.5, mPerPx * 0.5) ? 0.9 : 1;
        f = fur * border * (0.94 + 0.12 * valueNoise(wx, wy, 22, 8)) * (0.96 + 0.08 * valueNoise(wx, wy, 3, 9));
      } else if (c === "forest") {
        // Crowns on a ~4 m jittered grid: lit side brighter, shadow away from the sun.
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
            // Shadow cast away from the sun.
            const sd = Math.hypot(dx + o.sunX * rad * o.sunLow, dy + o.sunY * rad * o.sunLow) / rad;
            if (sd < 1 && d >= 1) shade = Math.min(shade, 0.62);
          }
        f = mPerPx < 2.5 ? shade : 0.9 + 0.1 * valueNoise(wx, wy, 6, 22);
        tg = 1.03;
      } else if (c === "grass") {
        // Grass: blades (sub-metre), tufts (metres), patches (tens of metres).
        f = 0.86 + 0.16 * valueNoise(wx, wy, 0.7, 31) * (mPerPx < 0.8 ? 1 : 0.35) + 0.12 * (valueNoise(wx, wy, 4, 33) - 0.5) + 0.12 * (valueNoise(wx, wy, 35, 32) - 0.5);
      } else if (c === "urban") {
        // Built-up ground between the drawn buildings: yards and lots, mostly paved. Pull the
        // blurred bright roofs (halos in 10 m pixels) toward concrete/asphalt.
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        const pave = lum > 130 ? 0.85 : 0.5;
        const tone = 0.8 + 0.25 * valueNoise(wx, wy, 14, 42);
        r = r * (1 - pave) + 116 * tone * pave;
        g = g * (1 - pave) + 116 * tone * pave;
        b = b * (1 - pave) + 112 * tone * pave;
        f = 0.95 + 0.08 * valueNoise(wx, wy, 2, 41);
      } else {
        f = 0.98 + 0.04 * valueNoise(wx, wy, 8, 51);
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
