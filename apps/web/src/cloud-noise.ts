/**
 * Tileable 3D noise for the volumetric clouds (vclouds.ts), after Schneider, "The Real-time
 * Volumetric Cloudscapes of Horizon: Zero Dawn" (2015) / Nubis:
 *  - shape (64³, RGBA): R Perlin–Worley (billowy Perlin, its low values cut by Worley cells:
 *    round, cauliflower lumps), G B A inverted Worley fBm at 4, 8 and 16 cells across;
 *  - detail (32³, RGB): inverted Worley fBm at 2, 4 and 8 cells across (wisps, eroded edges).
 * Made once per page in a worker (cloud-noise-worker.ts: ~1.6 s on the M1 Pro, during the
 * loading screen), as bytes; cloudNoiseAsync() hands them over.
 */

/** Integer hash → [0, 1). */
function hash(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const wrap = (i: number, p: number) => ((i % p) + p) % p;

/** Inverted Worley noise (1 at feature points), tileable with `cells` cells across [0, 1). */
function worley(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells, py = y * cells, pz = z * cells;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let d2 = 9;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const wx = wrap(cx, cells), wy = wrap(cy, cells), wz = wrap(cz, cells);
        const fx = cx + hash(wx, wy, wz, seed) - px, fy = cy + hash(wx, wy, wz, seed + 1) - py, fz = cz + hash(wx, wy, wz, seed + 2) - pz;
        const d = fx * fx + fy * fy + fz * fz;
        if (d < d2) d2 = d;
      }
  return 1 - Math.min(1, Math.sqrt(d2));
}
const worleyFbm = (x: number, y: number, z: number, cells: number, seed: number) =>
  worley(x, y, z, cells, seed) * 0.625 + worley(x, y, z, cells * 2, seed + 7) * 0.25 + worley(x, y, z, cells * 4, seed + 13) * 0.125;

/** Gradient (Perlin) noise in [0, 1], tileable with `cells` cells across. */
function perlin(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells, py = y * cells, pz = z * cells;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const fx = px - ix, fy = py - iy, fz = pz - iz;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
    const h = Math.floor(hash(wrap(cx, cells), wrap(cy, cells), wrap(cz, cells), seed) * 12);
    const G = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]][h]!;
    return G[0]! * dx + G[1]! * dy + G[2]! * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const n = l(
    l(l(grad(ix, iy, iz, fx, fy, fz), grad(ix + 1, iy, iz, fx - 1, fy, fz), u), l(grad(ix, iy + 1, iz, fx, fy - 1, fz), grad(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u), v),
    l(l(grad(ix, iy, iz + 1, fx, fy, fz - 1), grad(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u), l(grad(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), grad(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u), v),
    w,
  );
  return n * 0.5 + 0.5;
}
function perlinFbm(x: number, y: number, z: number, cells: number, seed: number, oct: number): number {
  let s = 0, a = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * perlin(x, y, z, cells << o, seed + o * 31);
    norm += a;
    a *= 0.5;
  }
  return s / norm;
}
const remap = (v: number, a: number, b: number, c: number, d: number) => c + ((v - a) / (b - a)) * (d - c);
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export interface CloudNoise {
  shape: Uint8Array;
  shapeSize: number;
  detail: Uint8Array;
  detailSize: number;
}

let cached: CloudNoise | undefined;

export function cloudNoise(): CloudNoise {
  if (cached) return cached;
  const S = 64, D = 32;
  const shape = new Uint8Array(S * S * S * 4);
  for (let z = 0; z < S; z++)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, v = (y + 0.5) / S, w = (z + 0.5) / S;
        const wf = worleyFbm(u, v, w, 4, 11);
        // Billowy (folded) Perlin lifting the Worley cells where it is high (Nubis): mostly the
        // cells' round lumps, joined in places.
        const p = Math.abs(perlinFbm(u, v, w, 4, 3, 4) * 2 - 1);
        const pw = remap(p, 0, 1, wf, 1);
        const i = 4 * (x + S * (y + S * z));
        shape[i] = byte(pw);
        shape[i + 1] = byte(wf);
        shape[i + 2] = byte(worleyFbm(u, v, w, 8, 23));
        shape[i + 3] = byte(worleyFbm(u, v, w, 16, 37));
      }
  const detail = new Uint8Array(D * D * D * 4);
  for (let z = 0; z < D; z++)
    for (let y = 0; y < D; y++)
      for (let x = 0; x < D; x++) {
        const u = (x + 0.5) / D, v = (y + 0.5) / D, w = (z + 0.5) / D;
        const i = 4 * (x + D * (y + D * z));
        detail[i] = byte(worleyFbm(u, v, w, 2, 41));
        detail[i + 1] = byte(worleyFbm(u, v, w, 4, 53));
        detail[i + 2] = byte(worleyFbm(u, v, w, 8, 67));
        detail[i + 3] = 255;
      }
  cached = { shape, shapeSize: S, detail, detailSize: D };
  return cached;
}

let pending: Promise<CloudNoise> | undefined;
/** The noise, made in a worker (once per page). */
export function cloudNoiseAsync(): Promise<CloudNoise> {
  if (cached) return Promise.resolve(cached);
  if (!pending)
    pending = new Promise<CloudNoise>((resolve, reject) => {
      const w = new Worker(new URL("./cloud-noise-worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<CloudNoise>) => {
        cached = e.data;
        w.terminate();
        resolve(e.data);
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message));
      };
    });
  return pending;
}
