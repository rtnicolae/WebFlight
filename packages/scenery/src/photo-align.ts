/**
 * How far an aerial photo is displaced from OpenStreetMap.
 *
 * Satellite photos are often registered a few metres off (measured over Ghimbav, RO: Bing's
 * roofs sit ~4.7 m south-west of the OSM footprints). The 3D buildings stand on the OSM
 * footprints, so the photo's own roofs show beside them as flat "ghost" roofs. This finds the
 * displacement that best puts the footprints' outlines on the photo's roof edges, aggregated
 * over many houses, so the photo can be moved back onto the map.
 *
 * Score of a shift for one building: the mean edge strength along its outline moved by the
 * shift, times how bright the moved interior is (a roof, not the building's dark shadow,
 * whose outline is just as sharp). Each building's scores are normalised by their median so
 * busy surroundings don't dominate; the sum over buildings peaks at the common displacement.
 * Low houses only: a tall building's roof is displaced further by the camera's lean.
 */

/** A grey image: luminance per pixel, row-major. */
export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

export interface AlignFootprint {
  /** Outline in image pixels (x right, y down), closed or open. */
  ring: [number, number][];
  heightM: number;
}

export interface PhotoOffset {
  /** Where the photo shows the roofs relative to the footprints, in image pixels. */
  dx: number;
  dy: number;
  /** Buildings that took part. */
  buildings: number;
  /** Peak over median of the summed scores (1 = no signal; ~1.2 over a village). */
  quality: number;
}

export interface AlignOptions {
  /** Search radius [m]. */
  rangeM?: number;
  /** Building heights used [m]. */
  minHeightM?: number;
  maxHeightM?: number;
  /** Below these the answer is undefined. */
  minBuildings?: number;
  minQuality?: number;
}

/** [1 2 1]/4 in both directions. */
function blur(g: Gray): Gray {
  const { w, h, data: s } = g;
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      t[i] = (s[i - (x > 0 ? 1 : 0)]! + 2 * s[i]! + s[i + (x < w - 1 ? 1 : 0)]!) / 4;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = (t[i - (y > 0 ? w : 0)]! + 2 * t[i]! + t[i + (y < h - 1 ? w : 0)]!) / 4;
    }
  return { w, h, data: o };
}

/** Sobel gradient magnitude. */
function gradient(g: Gray): Gray {
  const { w, h, data: s } = g;
  const o = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = s[i - w + 1]! + 2 * s[i + 1]! + s[i + w + 1]! - s[i - w - 1]! - 2 * s[i - 1]! - s[i + w - 1]!;
      const gy = s[i + w - 1]! + 2 * s[i + w]! + s[i + w + 1]! - s[i - w - 1]! - 2 * s[i - w]! - s[i - w + 1]!;
      o[i] = Math.hypot(gx, gy);
    }
  return { w, h, data: o };
}

function sample(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * g.w + x0, d = g.data;
  return (d[i]! * (1 - fx) + d[i + 1]! * fx) * (1 - fy) + (d[i + g.w]! * (1 - fx) + d[i + g.w + 1]! * fx) * fy;
}

function median(a: ArrayLike<number>): number {
  const s = Float32Array.from(a).sort();
  return s[s.length >> 1] ?? 0;
}

function inside(ring: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Every k-th of a list, so that at most n remain. */
const thin = <T>(a: T[], n: number): T[] => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0));

interface Probe {
  edge: [number, number][];
  fill: [number, number][];
  /** Median of the coarse scores (the normaliser). */
  med: number;
}

export function photoOffset(img: Gray, footprints: AlignFootprint[], mPerPx: number, o: AlignOptions = {}): PhotoOffset | undefined {
  const rangeM = o.rangeM ?? 12, minH = o.minHeightM ?? 2.5, maxH = o.maxHeightM ?? 7.5;
  const L = blur(img);
  const G = blur(blur(gradient(L)));
  const lum: number[] = [];
  for (let i = 0; i < L.data.length; i += 7) lum.push(L.data[i]!);
  const lmed = Math.max(1, median(lum));
  const score = (p: Probe, sx: number, sy: number) => {
    let e = 0, f = 0;
    for (const [x, y] of p.edge) e += sample(G, x + sx, y + sy);
    for (const [x, y] of p.fill) f += sample(L, x + sx, y + sy);
    const b = Math.min(1, f / p.fill.length / lmed);
    return (e / p.edge.length) * b * b;
  };
  // Coarse: 1 m steps over the whole range.
  const n = Math.round(rangeM), N = 2 * n + 1, stepPx = 1 / mPerPx, R = rangeM / mPerPx + 2;
  const acc = new Float64Array(N * N);
  const probes: Probe[] = [];
  const map = new Float64Array(N * N);
  for (const fp of footprints) {
    if (fp.heightM < minH || fp.heightM > maxH || fp.ring.length < 3) continue;
    const xs = fp.ring.map((p) => p[0]), ys = fp.ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x0 < R || y0 < R || x1 > img.w - 1 - R || y1 > img.h - 1 - R) continue;
    const edge: [number, number][] = [];
    const ring = fp.ring;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!, [bx, by] = ring[(i + 1) % ring.length]!;
      const k = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / (0.5 * stepPx)));
      for (let j = 0; j < k; j++) edge.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
    }
    const fill: [number, number][] = [];
    for (let y = y0 + stepPx / 2; y < y1; y += stepPx) for (let x = x0 + stepPx / 2; x < x1; x += stepPx) if (inside(ring, x, y)) fill.push([x, y]);
    if (edge.length < 12 || fill.length < 4) continue;
    const p: Probe = { edge: thin(edge, 120), fill: thin(fill, 64), med: 0 };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) map[j * N + i] = score(p, (i - n) * stepPx, (j - n) * stepPx);
    p.med = median(map);
    if (!(p.med > 0)) continue;
    for (let k = 0; k < N * N; k++) acc[k]! += map[k]! / p.med;
    probes.push(p);
  }
  if (probes.length < (o.minBuildings ?? 20)) return undefined;
  let best = 0;
  for (let k = 1; k < N * N; k++) if (acc[k]! > acc[best]!) best = k;
  const quality = acc[best]! / median(acc);
  if (quality < (o.minQuality ?? 1.05)) return undefined;
  // Fine: quarter metres within a metre of the coarse peak, then a parabola through the best.
  const cx = ((best % N) - n) * stepPx, cy = (Math.floor(best / N) - n) * stepPx;
  const F = 9, h = stepPx / 4, fine = new Float64Array(F * F);
  for (let j = 0; j < F; j++)
    for (let i = 0; i < F; i++) {
      let s = 0;
      for (const p of probes) s += score(p, cx + (i - 4) * h, cy + (j - 4) * h) / p.med;
      fine[j * F + i] = s;
    }
  let fb = 0;
  for (let k = 1; k < F * F; k++) if (fine[k]! > fine[fb]!) fb = k;
  const fi = fb % F, fj = Math.floor(fb / F);
  const vertex = (a: number, b: number, c: number) => (a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
  const ox = fi > 0 && fi < F - 1 ? vertex(fine[fb - 1]!, fine[fb]!, fine[fb + 1]!) : 0;
  const oy = fj > 0 && fj < F - 1 ? vertex(fine[fb - F]!, fine[fb]!, fine[fb + F]!) : 0;
  return { dx: cx + (fi - 4 + ox) * h, dy: cy + (fj - 4 + oy) * h, buildings: probes.length, quality };
}
