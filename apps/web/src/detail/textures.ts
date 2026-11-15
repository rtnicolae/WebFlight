/**
 * HD ground textures (Poly Haven, CC0; public/textures) used as detail maps: each texel is
 * stored as its colour divided by the texture's mean, in a mip pyramid (2×2 box filter).
 * Multiplying a satellite colour by a sample keeps the real colour and adds the photo's
 * grain. A pixel samples the pyramid level whose texels are at least its own size, so where
 * the texture is finer than a pixel the sample averages to 1 and the tile equals the plain
 * satellite image (no tonal steps between zoom levels).
 */

export interface DetailTexture {
  /** Ground size of one texture repeat [world m]. */
  meters: number;
  /** Level 0 size [px] (square, power of two). */
  size: number;
  /** Per level: RGB ratios to the mean, size>>level squared. */
  levels: Float32Array[];
}

export function buildDetailTexture(rgba: Uint8ClampedArray, size: number, meters: number): DetailTexture {
  let mr = 0, mg = 0, mb = 0;
  const n = size * size;
  for (let i = 0; i < n; i++) {
    mr += rgba[i * 4]!;
    mg += rgba[i * 4 + 1]!;
    mb += rgba[i * 4 + 2]!;
  }
  mr /= n; mg /= n; mb /= n;
  const l0 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    l0[i * 3] = rgba[i * 4]! / mr;
    l0[i * 3 + 1] = rgba[i * 4 + 1]! / mg;
    l0[i * 3 + 2] = rgba[i * 4 + 2]! / mb;
  }
  const levels = [l0];
  for (let s = size >> 1; s >= 1; s >>= 1) {
    const prev = levels[levels.length - 1]!, ps = s * 2;
    const cur = new Float32Array(s * s * 3);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++)
        for (let c = 0; c < 3; c++)
          cur[(y * s + x) * 3 + c] =
            (prev[((2 * y) * ps + 2 * x) * 3 + c]! + prev[((2 * y) * ps + 2 * x + 1) * 3 + c]! + prev[((2 * y + 1) * ps + 2 * x) * 3 + c]! + prev[((2 * y + 1) * ps + 2 * x + 1) * 3 + c]!) / 4;
    levels.push(cur);
  }
  return { meters, size, levels };
}

/**
 * The texture's ratio at world point (wx, wy) [m] for a pixel of mPerPx [m], into out[0..2].
 * Bilinear within the level whose texel is at least the pixel; tiles seamlessly.
 */
export function sampleRatio(t: DetailTexture, wx: number, wy: number, mPerPx: number, out: Float32Array, meters = t.meters): void {
  const texel0 = meters / t.size;
  let level = Math.max(0, Math.ceil(Math.log2(mPerPx / texel0)));
  if (level >= t.levels.length) {
    out[0] = out[1] = out[2] = 1;
    return;
  }
  const s = t.size >> level;
  const lv = t.levels[level]!;
  // Texture v grows southwards (image rows), world y northwards.
  const u = ((wx / meters) % 1 + 1) % 1 * s - 0.5, v = ((-wy / meters) % 1 + 1) % 1 * s - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const X0 = ((x0 % s) + s) % s, X1 = (X0 + 1) % s, Y0 = ((y0 % s) + s) % s, Y1 = (Y0 + 1) % s;
  for (let c = 0; c < 3; c++) {
    const a = lv[(Y0 * s + X0) * 3 + c]!, b = lv[(Y0 * s + X1) * 3 + c]!, d = lv[(Y1 * s + X0) * 3 + c]!, e = lv[(Y1 * s + X1) * 3 + c]!;
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
}

/**
 * Two scales of the same photo, multiplied (each averages 1): the macro layer stretches it
 * so its clumps read as meadow patches and crop texture from a glider's height; the micro
 * layer, at about true scale, shows on low passes and on the ground.
 */
const MACRO = 7;
/**
 * Contrast gains around 1 (mean-preserving): the photos' grain lives mostly below a pixel at
 * glider heights, so the averaged levels vary by only 2–5 %; the gains make it 10–15 %.
 * Applied to brightness, with a little of the photo's colour, so the satellite hue stays.
 */
const MICRO_GAIN = 2.5, MACRO_GAIN = 3, CHROMA = 0.3;

/** Smooth value noise in [0, 1) (cell s) for blending the texture samples. */
function noise(x: number, y: number, s: number, salt: number): number {
  const h = (i: number, j: number) => {
    let v = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
    v = Math.imul(v ^ (v >>> 15), 0x85ebca6b);
    return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
  };
  const fx = x / s, fy = y / s, x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  return (h(x0, y0) * (1 - sx) + h(x0 + 1, y0) * sx) * (1 - sy) + (h(x0, y0 + 1) * (1 - sx) + h(x0 + 1, y0 + 1) * sx) * sy;
}

/** Bilinear lookup of a level at texture coordinates (u, v) in repeats. */
function lookup(lv: Float32Array, s: number, u: number, v: number, out: Float32Array): void {
  const x = (u - Math.floor(u)) * s - 0.5, y = (v - Math.floor(v)) * s - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const X0 = (x0 + s) % s, X1 = (X0 + 1) % s, Y0 = (y0 + s) % s, Y1 = (Y0 + 1) % s;
  const i00 = (Y0 * s + X0) * 3, i10 = (Y0 * s + X1) * 3, i01 = (Y1 * s + X0) * 3, i11 = (Y1 * s + X1) * 3;
  for (let c = 0; c < 3; c++) out[c] = (lv[i00 + c]! * (1 - fx) + lv[i10 + c]! * fx) * (1 - fy) + (lv[i01 + c]! * (1 - fx) + lv[i11 + c]! * fx) * fy;
}

const R = [0.31, 1.97, 1.31, 2.97].map((a) => [Math.cos(a), Math.sin(a)] as const);

/**
 * Samples detail textures for one tile (one pixel size): the mip levels are chosen once per
 * texture, and per pixel `at()` computes the shared coordinates and blend weights once; then
 * `sample()` reads any texture there. Two scales (true and ×7, multiplied, each averaging 1:
 * the macro layer makes the clumps read as meadow and crop texture from a glider's height),
 * each from two rotated, offset samples mixed by smooth noise so no repeat shows.
 */
export class TileSampler {
  private readonly lv = new Map<DetailTexture, { micro?: [Float32Array, number]; macro?: [Float32Array, number] }>();
  // Per pixel: world coordinates of the four samples, and the two mix weights / normalizers.
  private m1x = 0; private m1y = 0; private m2x = 0; private m2y = 0;
  private M1x = 0; private M1y = 0; private M2x = 0; private M2y = 0;
  private wm = 0; private km = 1; private wM = 0; private kM = 1;
  private readonly a = new Float32Array(3);
  private readonly b = new Float32Array(3);
  private readonly mic = new Float32Array(3);
  private readonly mac = new Float32Array(3);

  constructor(private readonly mPerPx: number) {}

  private levels(t: DetailTexture) {
    let e = this.lv.get(t);
    if (!e) {
      const pick = (meters: number): [Float32Array, number] | undefined => {
        const level = Math.max(0, Math.ceil(Math.log2(this.mPerPx / (meters / t.size))));
        return level < t.levels.length ? [t.levels[level]!, t.size >> level] : undefined;
      };
      e = {};
      const mi = pick(t.meters), ma = pick(t.meters * MACRO);
      if (mi) e.micro = mi;
      if (ma) e.macro = ma;
      this.lv.set(t, e);
    }
    return e;
  }

  at(wx: number, wy: number): void {
    const [c0, s0] = R[0]!, [c1, s1] = R[1]!, [c2, s2] = R[2]!, [c3, s3] = R[3]!;
    this.m1x = wx * c0 - wy * s0; this.m1y = wx * s0 + wy * c0;
    const ox = wx + 2.3, oy = wy - 3.9;
    this.m2x = ox * c1 - oy * s1; this.m2y = ox * s1 + oy * c1;
    const Ox = wx + 13.7, Oy = wy - 29.3;
    this.M1x = Ox * c2 - Oy * s2; this.M1y = Ox * s2 + Oy * c2;
    const Px = Ox + 17.1, Py = Oy - 23.9;
    this.M2x = Px * c3 - Py * s3; this.M2y = Px * s3 + Py * c3;
    this.wm = noise(wx, wy, 11, 11);
    this.km = 1 / Math.sqrt(this.wm * this.wm + (1 - this.wm) * (1 - this.wm));
    this.wM = noise(wx, wy, 75, 18);
    this.kM = 1 / Math.sqrt(this.wM * this.wM + (1 - this.wM) * (1 - this.wM));
  }

  /** The detail ratio of texture t at the current point, into out. */
  sample(t: DetailTexture, out: Float32Array): void {
    const e = this.levels(t);
    const one = (lev: [Float32Array, number] | undefined, meters: number, x1: number, y1: number, x2: number, y2: number, w: number, k: number, dst: Float32Array) => {
      if (!lev) {
        dst[0] = dst[1] = dst[2] = 1;
        return;
      }
      // Texture v grows southwards (image rows), world y northwards.
      lookup(lev[0], lev[1], x1 / meters, -y1 / meters, this.a);
      lookup(lev[0], lev[1], x2 / meters, -y2 / meters, this.b);
      for (let c = 0; c < 3; c++) dst[c] = 1 + ((this.a[c]! - 1) * (1 - w) + (this.b[c]! - 1) * w) * k;
    };
    one(e.micro, t.meters, this.m1x, this.m1y, this.m2x, this.m2y, this.wm, this.km, this.mic);
    one(e.macro, t.meters * MACRO, this.M1x, this.M1y, this.M2x, this.M2y, this.wM, this.kM, this.mac);
    const lm = (this.mic[0]! + this.mic[1]! + this.mic[2]!) / 3, lM = (this.mac[0]! + this.mac[1]! + this.mac[2]!) / 3;
    const L = (1 + (lm - 1) * MICRO_GAIN) * (1 + (lM - 1) * MACRO_GAIN);
    for (let c = 0; c < 3; c++) out[c] = Math.max(0.3, L * (1 + (this.mic[c]! - lm) * CHROMA));
  }
}

/** Detail textures by role, with the ground size each repeat covers. */
export const TEXTURES = {
  grass: { file: "leafy_grass.jpg", meters: 6 },
  dryGrass: { file: "grass_ground.jpg", meters: 7 },
  soil: { file: "farm_soil.jpg", meters: 6 },
  drySoil: { file: "dry_mud_field_001.jpg", meters: 8 },
  track: { file: "aerial_mud_1.jpg", meters: 8 },
  gravel: { file: "gravel_road.jpg", meters: 4 },
  asphalt: { file: "aerial_asphalt_01.jpg", meters: 30 },
} as const;
export type TextureRole = keyof typeof TEXTURES;
