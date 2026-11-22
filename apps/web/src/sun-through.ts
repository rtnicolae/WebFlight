/**
 * How much of the sun's direct light reaches a point through the clouds: 1 in the clear, 0
 * deep in a cumulus' shadow. The same towers and deck holes as drawn (vclouds.ts) and cast on
 * the ground (google3d.ts setCloudShadows, wfDeckLight: kept alike), for what the ground's
 * shade doesn't reach: the glider (its sunlight, its shadow).
 *
 * Points are in a local frame: metres east, north and up of the point (or of the camera).
 */

/** A drawn cumulus, relative to the point: its base centre and towers (vclouds.ts cloudGeometry). */
export interface TowerCloud {
  /** Base centre east, north, up of the point [m]. */
  e: number;
  n: number;
  u: number;
  /** TOWERS × (east, north, centre height above the base, radius) [m]. */
  towers: Float32Array;
  opacity: number;
}

/**
 * The cumulus' shade at the point, 0–1, as on the ground: each tower a soft disc at its centre's
 * height, seen from the point towards the sun (sun: unit vector, east, north, up); inside a
 * tower, its own. Overlapping, the darker (not the sum).
 */
export function cumulusShade(clouds: readonly TowerCloud[], sun: { e: number; n: number; u: number }): number {
  const su = Math.max(sun.u, Math.sin((5 * Math.PI) / 180));
  let shade = 0;
  for (const c of clouds) {
    for (let k = 0; k < c.towers.length / 4; k++) {
      const te = c.e + c.towers[k * 4]!, tn = c.n + c.towers[k * 4 + 1]!, tz = c.u + c.towers[k * 4 + 2]!, r = c.towers[k * 4 + 3]! * 1.05;
      // Where the ray to the sun is at the tower's centre height (above the point); below it,
      // whether the point is in the tower.
      const q = tz > 0 ? Math.hypot(te - (sun.e * tz) / su, tn - (sun.n * tz) / su) / r : Math.hypot(te, tn, tz) / r;
      if (q >= 1) continue;
      const a = q < 0.55 ? c.opacity : c.opacity * (1 - (q - 0.55) / 0.45);
      if (a > shade) shade = a;
    }
  }
  return Math.min(1, shade);
}

/** The decks' field (cloud-noise.ts deckField, R and G) with mip levels, as the GPU has it. */
export class DeckField {
  private readonly levels: { size: number; r: Float32Array; g: Float32Array }[] = [];

  constructor(rgba: Uint8Array, size: number) {
    let r = new Float32Array(size * size), g = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      r[i] = rgba[4 * i]! / 255;
      g[i] = rgba[4 * i + 1]! / 255;
    }
    this.levels.push({ size, r, g });
    // Each level the mean of four (generateMipmap's box filter).
    for (let s = size >> 1; s >= 1; s >>= 1) {
      const pr = r, pg = g, ps = s * 2;
      r = new Float32Array(s * s);
      g = new Float32Array(s * s);
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const i0 = 2 * y * ps + 2 * x, i1 = i0 + ps;
          r[y * s + x] = 0.25 * (pr[i0]! + pr[i0 + 1]! + pr[i1]! + pr[i1 + 1]!);
          g[y * s + x] = 0.25 * (pg[i0]! + pg[i0 + 1]! + pg[i1]! + pg[i1 + 1]!);
        }
      this.levels.push({ size: s, r, g });
    }
  }

  /** textureLod(map, uv, lod).rg, repeating, bilinear in a level and linear between levels. */
  sample(u: number, v: number, lod: number): [number, number] {
    const l0 = Math.max(0, Math.min(this.levels.length - 1, Math.floor(lod))), l1 = Math.min(this.levels.length - 1, l0 + 1), f = Math.max(0, Math.min(1, lod - l0));
    const a = this.bilinear(l0, u, v), b = this.bilinear(l1, u, v);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  private bilinear(l: number, u: number, v: number): [number, number] {
    const { size: s, r, g } = this.levels[l]!;
    const x = u * s - 0.5, y = v * s - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const w = (i: number) => ((i % s) + s) % s;
    const i00 = w(y0) * s + w(x0), i10 = w(y0) * s + w(x0 + 1), i01 = w(y0 + 1) * s + w(x0), i11 = w(y0 + 1) * s + w(x0 + 1);
    const lerp2 = (t: Float32Array) => (t[i00]! * (1 - fx) + t[i10]! * fx) * (1 - fy) + (t[i01]! * (1 - fx) + t[i11]! * fx) * fy;
    return [lerp2(r), lerp2(g)];
  }
}

/** vclouds.ts equalize: the field's sum of two uniforms made uniform again. */
export function equalize(s: number): number {
  if (s < 0.25) return (s * s) / 0.375;
  if (s < 0.75) return (s - 0.125) / 0.75;
  return 1 - ((1 - s) * (1 - s)) / 0.375;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The decks as drawn (vclouds.ts deckShade): base, top, cover, field mix; where, extinction. */
export interface DeckState {
  decks: readonly { x: number; y: number; z: number; w: number }[];
  at: readonly { x: number; y: number; z: number }[];
  /** The camera's height [m]. */
  camH: number;
  n: number;
}

/**
 * The sun's light through the decks at a point (rel: east, north, up of the camera [m]), the
 * direct and the forward-scattered together (two-stream), as on the ground (google3d.ts
 * wfDeckLight: the same 150 m footprint's mip levels).
 */
export function deckLight(field: DeckField, d: DeckState, rel: { e: number; n: number; u: number }, sun: { e: number; n: number; u: number }): number {
  const sunUp = Math.max(sun.u, 0.05), sx = sun.e / sunUp, sy = sun.n / sunUp, h = d.camH + rel.u;
  let all = 1;
  for (let k = 0; k < Math.min(2, d.n); k++) {
    const D = d.decks[k]!, P = d.at[k]!, mid = 0.5 * (D.x + D.y);
    if (D.z < 0.005 || mid <= h) continue;
    const x = P.x + rel.e + sx * (mid - h), y = P.y + rel.n + sy * (mid - h);
    let cov = 1;
    if (D.z <= 0.995) {
      const a = field.sample(x / 32000, y / 32000, 1.263);
      const b = field.sample((0.8 * x - 0.6 * y) / 9100 + 0.37, (0.6 * x + 0.8 * y) / 9100 + 0.37, 3.077);
      // (The second scale's channels swapped, as the shader's .gr.)
      const f0 = equalize(0.75 * a[0] + 0.25 * b[1]), f1 = equalize(0.75 * a[1] + 0.25 * b[0]);
      cov = smoothstep(1 - D.z, 1 - D.z + 0.5, f0 + (f1 - f0) * D.w);
    }
    all /= 1 + (0.1125 * P.z * 0.75 * (D.y - D.x) * cov) / (0.5 + 0.75 * sunUp);
  }
  return all;
}

/**
 * The share of the sun's light the clouds take where they shade, by the sun's height: all of it
 * from 12° up, none from 2° down (the light then is the sky's glow). As on the ground (google3d.ts
 * setCloudShadows, its 0.65 the photo's share of the light that is the sun's).
 */
export function cloudShadeRamp(sunElevationDeg: number): number {
  return Math.min(1, Math.max(0, (sunElevationDeg - 2) / 10));
}
