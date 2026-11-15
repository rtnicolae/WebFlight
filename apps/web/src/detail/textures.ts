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

const ta = new Float32Array(3), tb = new Float32Array(3);
/**
 * One scale, without visible repetition: two samples of the photo, rotated and offset
 * differently, mixed by smooth noise (the mix has no period for the eye to lock onto).
 */
function bombed(t: DetailTexture, wx: number, wy: number, mPerPx: number, meters: number, salt: number, out: Float32Array): void {
  const r = (a: number, x: number, y: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const [x1, y1] = r(0.31 + salt, wx, wy);
  const [x2, y2] = r(1.97 + salt, wx + 0.37 * meters, wy - 0.61 * meters);
  sampleRatio(t, x1, y1, mPerPx, ta, meters);
  sampleRatio(t, x2, y2, mPerPx, tb, meters);
  const w = noise(wx, wy, meters * 1.7, 11 + salt * 7);
  // Equal-variance mix (a plain lerp would halve the contrast in between).
  const k = 1 / Math.sqrt(w * w + (1 - w) * (1 - w));
  for (let c = 0; c < 3; c++) out[c] = 1 + ((ta[c]! - 1) * (1 - w) + (tb[c]! - 1) * w) * k;
}

const tmp = new Float32Array(3);
/**
 * Two scales of the same photo, multiplied (each averages 1): the macro layer stretches it so
 * its clumps read as meadow patches and crop texture from a glider's height; the micro layer,
 * at about true scale, shows on low passes and on the ground.
 */
export function sampleTwoScale(t: DetailTexture, wx: number, wy: number, mPerPx: number, out: Float32Array): void {
  bombed(t, wx, wy, mPerPx, t.meters, 0, out);
  bombed(t, wx, wy, mPerPx, t.meters * MACRO, 1, tmp);
  const lm = (out[0]! + out[1]! + out[2]!) / 3, lM = (tmp[0]! + tmp[1]! + tmp[2]!) / 3;
  const L = (1 + (lm - 1) * MICRO_GAIN) * (1 + (lM - 1) * MACRO_GAIN);
  for (let c = 0; c < 3; c++) out[c] = Math.max(0.3, L * (1 + (out[c]! - lm) * CHROMA));
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
