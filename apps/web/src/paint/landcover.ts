/**
 * "Painted" terrain imagery: a plausible aerial look generated from elevation alone, for when
 * photo imagery is unavailable. Pure functions (no DOM), so it runs in a worker and in Node.
 *
 * Inputs per pixel: height, the surface normal (from neighbouring heights) and world
 * position in metres (degrees scaled at a fixed 47° reference latitude: continuous across
 * tiles and zoom levels, and isotropic around the Alps).
 * Land cover: field patchwork in flat lowland, forest on slopes and in patches, villages,
 * pasture on ridges, then alpine meadow, rock, scree and snow with height and steepness.
 * Lighting: Lambert hillshade from the sun plus sky ambient, as in an aerial photo.
 */

export type Rgb = [number, number, number];

const M_PER_DEG_LAT = 111_132;
/** Metres per degree of longitude at 47°N: the noise frame's x scale everywhere. */
const M_PER_DEG_LON_REF = 111_320 * Math.cos((47 * Math.PI) / 180);

// ---- hashing and noise (deterministic, continuous in world metres) -------------------

function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [0, 1]. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal noise in [0, 1]. */
export function fbm(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Jittered-grid cells (fields): id hash of the nearest feature point and distance to the edge. */
export function cell(x: number, y: number, size: number, seed: number): { id: number; edge: number; angle: number } {
  const gx = Math.floor(x / size), gy = Math.floor(y / size);
  let best = Infinity, second = Infinity, bx = 0, by = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cy = gy + j;
      const px = (cx + 0.15 + 0.7 * hash2(cx, cy, seed)) * size, py = (cy + 0.15 + 0.7 * hash2(cx, cy, seed + 1)) * size;
      // Slightly anisotropic metric: fields come out longish, like real parcels.
      const dx = x - px, dy = (y - py) * 1.35;
      const d = dx * dx + dy * dy;
      if (d < best) {
        second = best;
        best = d;
        bx = cx;
        by = cy;
      } else if (d < second) second = d;
    }
  return { id: hash2(bx, by, seed + 2), edge: Math.sqrt(second) - Math.sqrt(best), angle: hash2(bx, by, seed + 3) * Math.PI };
}

// ---- palette --------------------------------------------------------------------------

const C = {
  meadow: [[98, 130, 60], [110, 140, 66], [88, 122, 54], [120, 146, 74], [104, 134, 58]] as Rgb[],
  crop: [[176, 166, 112], [150, 158, 88], [166, 152, 104], [134, 146, 80], [184, 174, 104], [128, 112, 88], [146, 128, 98]] as Rgb[],
  forestDeciduous: [62, 92, 44] as Rgb,
  forestConifer: [44, 70, 40] as Rgb,
  village: [[150, 140, 128], [138, 96, 80], [160, 152, 140], [124, 116, 106], [142, 108, 90]] as Rgb[],
  pasture: [128, 150, 82] as Rgb,
  alpine: [136, 148, 92] as Rgb,
  rock: [140, 136, 128] as Rgb,
  scree: [168, 162, 152] as Rgb,
  snow: [240, 243, 247] as Rgb,
  hedge: [70, 96, 50] as Rgb,
};

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const sstep = (a: number, b: number, v: number) => smooth(clamp01((v - a) / (b - a)));

export interface Sun {
  /** Unit vector towards the sun in local east-north-up. */
  e: number;
  n: number;
  u: number;
}

/** Sun direction from azimuth (deg from north, clockwise) and elevation (deg). */
export function sunFrom(azimuthDeg: number, elevationDeg: number): Sun {
  const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
  return { e: Math.sin(az) * Math.cos(el), n: Math.cos(az) * Math.cos(el), u: Math.sin(el) };
}

/**
 * Colour of one ground pixel.
 * @param h height [m]; @param ne, nn, nu surface normal (east, north, up), unit
 * @param x, y world position [m] (east, north); @param pixelM pixel size [m]
 */
export function groundColor(h: number, ne: number, nn: number, nu: number, x: number, y: number, pixelM: number, sun: Sun): Rgb {
  const slope = Math.acos(Math.max(-1, Math.min(1, nu))); // rad
  const slopeDeg = (slope * 180) / Math.PI;
  const northFacing = -nn; // > 0 on north-facing slopes
  // Detail fades out where a pixel is larger than the feature (keeps distant tiles calm).
  const fine = 1 - sstep(20, 120, pixelM);

  // Forest likelihood: patches everywhere, much more on slopes and in the foothills.
  const patches = fbm(x / 1400, y / 1400, 4, 11);
  const forestNoise = patches + 0.35 * sstep(10, 28, slopeDeg) + 0.12 * sstep(600, 1000, h) - 0.25 * sstep(1500, 1900, h) - 0.2 * sstep(1150, 1350, h) * (1 - sstep(8, 16, slopeDeg));
  const forest = forestNoise > 0.66;

  let col: Rgb;
  if (h > 2900 - 300 * northFacing - 200 * fbm(x / 600, y / 600, 3, 5)) {
    col = C.snow;
  } else if (slopeDeg > 40 + 8 * (fbm(x / 300, y / 300, 2, 6) - 0.5) && h > 700) {
    col = mix(C.rock, C.scree, fbm(x / 120, y / 120, 3, 7));
  } else if (h > 1900) {
    col = mix(C.alpine, C.scree, sstep(2100, 2600, h) * 0.8);
  } else if (forest) {
    const conifer = sstep(800, 1300, h) * 0.7 + 0.3 * valueNoise(x / 900, y / 900, 21);
    col = mix(C.forestDeciduous, C.forestConifer, conifer);
    // Canopy texture: crowns and gaps.
    const crowns = fbm(x / 9, y / 9, 2, 23) * fine;
    col = mix(col, [col[0] * 0.7, col[1] * 0.72, col[2] * 0.7], crowns);
    const edge = sstep(0.66, 0.7, forestNoise);
    col = mix(C.hedge, col, 0.4 + 0.6 * edge);
  } else if (h < 900 && slopeDeg < 9) {
    // Settlements: clustered blocks on flat lowland.
    const town = fbm(x / 2600, y / 2600, 3, 31) + 0.15 * valueNoise(x / 400, y / 400, 32);
    if (town > 0.75) {
      // Houses in gardens: roofs on a jittered 35 m grid, denser towards the centre.
      const b = cell(x, y, 35, 33);
      const density = sstep(0.75, 0.85, town);
      const roof = C.village[Math.floor(b.id * C.village.length)]!;
      const isHouse = b.id < 0.35 + 0.5 * density && b.edge > 4;
      col = isHouse ? roof : mix(C.meadow[0]!, [126, 124, 116], 0.35 + 0.4 * density);
      if (b.edge < 2.5) col = mix(col, [112, 110, 104], 0.7 * fine); // streets
      col = mix(col, mix(C.meadow[0]!, [134, 124, 110], 0.25 + 0.3 * density), 1 - fine); // calm when far
    } else {
      // Field patchwork with hedgerow edges and plough lines.
      const big = valueNoise(x / 3000, y / 3000, 40) > 0.5;
      const f = cell(x, y, big ? 300 : 170, big ? 41 : 43);
      const cropShare = 0.22 + 0.25 * valueNoise(x / 5000, y / 5000, 44);
      const crop = f.id < cropShare;
      col = crop ? C.crop[Math.floor((f.id / cropShare) * 7) % 7]! : C.meadow[Math.floor(((f.id - cropShare) / (1 - cropShare)) * 5) % 5]!;
      const ca = Math.cos(f.angle), sa = Math.sin(f.angle);
      const rows = 0.5 + 0.5 * Math.sin(((x * ca + y * sa) / 6) * Math.PI);
      if (crop) col = mix(col, [col[0] * 0.85, col[1] * 0.85, col[2] * 0.82], rows * fine * 0.6);
      col = mix(col, [col[0] * 0.92, col[1] * 0.95, col[2] * 0.9], fbm(x / 70, y / 70, 2, 42) * 0.6);
      const hedgeRow = valueNoise(x / 500, y / 500, 45) > 0.55; // some boundaries are hedgerows
      const hedge = 1 - sstep(1, (hedgeRow ? 5 : 2) + 2 * (1 - fine), f.edge);
      col = mix(col, hedgeRow ? C.hedge : mix(col, [120, 112, 92], 0.5), hedge * (hedgeRow ? 0.85 : 0.5) * (0.4 + 0.6 * fine));
    }
  } else if (h > 1150 && slopeDeg < 14) {
    col = mix(C.pasture, C.meadow[2]!, fbm(x / 200, y / 200, 3, 51));
  } else {
    col = mix(C.meadow[1]!, C.meadow[2]!, fbm(x / 250, y / 250, 3, 52));
  }

  // Hillshade: sun + sky light, a little blue in the shade.
  const lambert = Math.max(0, ne * sun.e + nn * sun.n + nu * sun.u);
  const sky = 0.38 + 0.12 * nu;
  const lit = sky + 0.95 * lambert;
  const shadeTint = 1 - clamp01(lambert * 2);
  return [
    Math.min(255, col[0] * lit * (1 - 0.06 * shadeTint)),
    Math.min(255, col[1] * lit * (1 - 0.02 * shadeTint)),
    Math.min(255, col[2] * lit * (1 + 0.1 * shadeTint)),
  ];
}

/**
 * Paint a Web Mercator tile (size×size RGBA) from its height grid: (size + 2)² heights at
 * pixel centres with a 1-pixel border, row 0 north (TerrariumTerrain.heightGrid), so normals
 * are continuous across tile edges.
 */
export function paintTile(x: number, y: number, z: number, size: number, hs: Float32Array, sun: Sun, out = new Uint8ClampedArray(size * size * 4)): Uint8ClampedArray {
  const n = 2 ** z;
  const worldM = 2 * Math.PI * 6378137;
  const pad = size + 2;
  for (let j = 0; j < size; j++) {
    const ty = y + (j + 0.5) / size;
    const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
    const k = Math.cos((latC * Math.PI) / 180);
    const pixelM = (worldM / n / size) * k; // ground size of a pixel
    const yM = latC * M_PER_DEG_LAT; // north, metres
    for (let i = 0; i < size; i++) {
      const c = (j + 1) * pad + (i + 1);
      const dzdx = (hs[c + 1]! - hs[c - 1]!) / (2 * pixelM);
      const dzdy = (hs[c - pad]! - hs[c + pad]!) / (2 * pixelM); // north is up the tile
      const len = Math.hypot(dzdx, dzdy, 1);
      const lon = ((x + (i + 0.5) / size) / n) * 360 - 180;
      const rgb = groundColor(hs[c]!, -dzdx / len, -dzdy / len, 1 / len, lon * M_PER_DEG_LON_REF, yM, pixelM, sun);
      const o = (j * size + i) * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = 255;
    }
  }
  return out;
}
