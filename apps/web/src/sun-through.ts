/**
 * How much of the sun's direct light reaches a point through the clouds: 1 in the clear, 0
 * deep in a cumulus' shadow. The same towers and deck holes as drawn (vclouds.ts) and cast on
 * the ground (google3d.ts setCloudShadows, wfDeckLight: kept alike), for what the ground's
 * shade doesn't reach: the glider (its sunlight, its shadow).
 *
 * Points are in a local frame: metres east, north and up of the point (or of the camera).
 */

/** The decks' depth factor by place (deckDepthScale's range), coded in a byte logarithmically. */
export const PLACE_SCALE_MIN = 0.02, PLACE_SCALE_MAX = 5;
export const placeScaleByte = (s: number) => Math.round((255 * Math.log(Math.min(PLACE_SCALE_MAX, Math.max(PLACE_SCALE_MIN, s)) / PLACE_SCALE_MIN)) / Math.log(PLACE_SCALE_MAX / PLACE_SCALE_MIN));
export const placeScaleOf = (b: number) => PLACE_SCALE_MIN * Math.exp((b / 255) * Math.log(PLACE_SCALE_MAX / PLACE_SCALE_MIN));

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
  /** The decks by place (vclouds.ts DeckPlaces as its u_place: RGBA bytes) and the camera on it. */
  place?: Uint8Array;
  placeCols?: number;
  placeRows?: number;
  placeP?: { x: number; y: number; z: number; w: number };
}

/**
 * The decks at a place en [m east/north of the camera], as the GPU samples u_place (linear,
 * clamped): low and mid cover, the factor on their extinction. Without a map: everywhere 1.
 */
export function deckPlace(d: DeckState, e: number, n: number): [number, number, number] {
  const b = d.place, P = d.placeP, cols = d.placeCols ?? 1, rows = d.placeRows ?? 1;
  if (!b || !P || b.length < cols * rows * 4) return [1, 1, 1];
  const x = Math.min(cols - 1, Math.max(0, (P.x + e * P.z) * cols - 0.5)), y = Math.min(rows - 1, Math.max(0, (P.y + n * P.w) * rows - 0.5));
  const j0 = Math.floor(x), i0 = Math.floor(y), j1 = Math.min(cols - 1, j0 + 1), i1 = Math.min(rows - 1, i0 + 1), fx = x - j0, fy = y - i0;
  const v = (c: number) => ((b[4 * (i0 * cols + j0) + c]! * (1 - fx) + b[4 * (i0 * cols + j1) + c]! * fx) * (1 - fy) + (b[4 * (i1 * cols + j0) + c]! * (1 - fx) + b[4 * (i1 * cols + j1) + c]! * fx) * fy) / 255;
  return [v(0), v(1), PLACE_SCALE_MIN * Math.exp(v(2) * Math.log(PLACE_SCALE_MAX / PLACE_SCALE_MIN))];
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
    // Where the sun's ray crosses it: its cover and depth there.
    const ae = rel.e + sx * (mid - h), an = rel.n + sy * (mid - h), pl = deckPlace(d, ae, an), c = k === 0 ? pl[0] : pl[1];
    const x = P.x + ae, y = P.y + an;
    if (c < 0.005) continue;
    let cov = 1;
    if (c <= 0.995) {
      const a = field.sample(x / 32000, y / 32000, 1.263);
      const b = field.sample((0.8 * x - 0.6 * y) / 9100 + 0.37, (0.6 * x + 0.8 * y) / 9100 + 0.37, 3.077);
      // (The second scale's channels swapped, as the shader's .gr.)
      const f0 = equalize(0.75 * a[0] + 0.25 * b[1]), f1 = equalize(0.75 * a[1] + 0.25 * b[0]);
      cov = smoothstep(1 - c, 1 - c + 0.5, f0 + (f1 - f0) * D.w);
    }
    all /= 1 + (0.1125 * P.z * pl[2] * 0.75 * (D.y - D.x) * cov) / (0.5 + 0.75 * sunUp);
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

/**
 * The same on the GPU, for what is drawn on the ground (Google's tiles, our buildings, our
 * water): wfSunThrough(relW) — the sun's light through the clouds at a point (relW: from the
 * camera, world axes), 1 in the clear, the clouds' share of it ramped by the sun's height
 * (cloudShadeRamp). The cumulus from their shadow map (google3d.ts setCloudShadows: cast onto
 * the ground), the decks as deckLight. Uniforms (SUN_THROUGH_UNIFORMS):
 *   wfcShadow   the cumulus' shadow map, metres east/north of the camera
 *   wfcShadowP  its centre east, north of the camera [m], size [m], 1 when on
 *   wfcDeckMap  the decks' field (cloud-noise.ts)
 *   wfcDeck0/1  base, top, cover, field mix
 *   wfcDeckP0/1 the camera east, north in the deck's frame [m], extinction
 *   wfcDeckH    the camera's height [m], decks drawn, the ramp
 *   wfcPlace    the decks by place (vclouds.ts u_place), wfcPlaceP the camera on it
 */
export const SUN_THROUGH_DECLS = /* glsl */ `
uniform sampler2D wfcShadow;
uniform vec4 wfcShadowP;
uniform sampler2D wfcDeckMap;
uniform vec4 wfcDeck0;
uniform vec4 wfcDeck1;
uniform vec4 wfcDeckP0;
uniform vec4 wfcDeckP1;
uniform vec4 wfcDeckH;
uniform sampler2D wfcPlace;
uniform vec4 wfcPlaceP;
`;
export const SUN_THROUGH_GLSL = /* glsl */ `
float wfcEqualize(float s) {
  if (s < 0.25) return s * s / 0.375;
  if (s < 0.75) return (s - 0.125) / 0.75;
  return 1.0 - (1.0 - s) * (1.0 - s) / 0.375;
}
float wfSunThrough(vec3 relW) {
  if (wfcShadowP.w < 0.5 && wfcDeckH.y < 0.5) return 1.0;
  vec3 upW = normalize(czm_viewerPositionWC);
  vec3 e = normalize(vec3(-upW.y, upW.x, 0.0));
  vec3 nn = cross(upW, e);
  vec2 en = vec2(dot(relW, e), dot(relW, nn));
  float t = 1.0;
  if (wfcShadowP.w > 0.5) {
    vec2 uv = (en - wfcShadowP.xy) / wfcShadowP.z + 0.5;
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) t = 1.0 - texture(wfcShadow, uv).r;
  }
  if (wfcDeckH.y > 0.5) {
    vec3 sunW = normalize(czm_inverseViewRotation * czm_lightDirectionEC);
    float sunUp = max(dot(sunW, upW), 0.05);
    vec2 sxy = vec2(dot(sunW, e), dot(sunW, nn)) / sunUp;
    float h = wfcDeckH.x + dot(relW, upW), all = 1.0;
    for (int k = 0; k < 2; k++) {
      vec4 D = k == 0 ? wfcDeck0 : wfcDeck1, P = k == 0 ? wfcDeckP0 : wfcDeckP1;
      float mid = 0.5 * (D.x + D.y);
      if (D.z < 0.005 || mid <= h) continue;
      // Where the sun's ray crosses it: its cover and depth there (vclouds.ts deckPlace).
      vec2 at = en + sxy * (mid - h), xy = P.xy + at;
      vec4 pl = textureLod(wfcPlace, wfcPlaceP.xy + at * wfcPlaceP.zw, 0.0);
      float c = k == 0 ? pl.r : pl.g;
      if (c < 0.005) continue;
      float cov = 1.0;
      if (c <= 0.995) {
        // (Mip levels for a 150 m footprint, as vclouds.ts deckSun's.)
        vec2 a = textureLod(wfcDeckMap, xy / 32000.0, 1.263).rg;
        vec2 b = textureLod(wfcDeckMap, mat2(0.8, 0.6, -0.6, 0.8) * xy / 9100.0 + 0.37, 3.077).gr;
        cov = smoothstep(1.0 - c, 1.0 - c + 0.5, mix(wfcEqualize(0.75 * a.x + 0.25 * b.x), wfcEqualize(0.75 * a.y + 0.25 * b.y), D.w));
      }
      // Its depth there is H·cov; at its mean density, three quarters of the extinction
      // (decks.ts deckTransmission), times the place's factor.
      float scale = exp(${Math.log(PLACE_SCALE_MIN).toFixed(6)} + pl.b * ${Math.log(PLACE_SCALE_MAX / PLACE_SCALE_MIN).toFixed(6)});
      all /= 1.0 + 0.1125 * P.z * scale * 0.75 * (D.y - D.x) * cov / (0.5 + 0.75 * sunUp);
    }
    t = min(t, all);
  }
  return 1.0 - wfcDeckH.z * (1.0 - t);
}
`;

/**
 * Where something lit like the photos (all its light times it, as a cast shadow): the light
 * left in a cloud's shade, 1 − 0.65 of what the clouds take (the photo's share of its light that
 * is the sun's: under a cumulus, about the sky's third). sunThrough: wfSunThrough's.
 */
export const CLOUD_SHADE = 0.65;
