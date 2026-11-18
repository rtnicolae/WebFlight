/// <reference lib="webworker" />
/**
 * The grass field's maps for a square of ground round a centre (grass-field.ts draws the
 * blades from them on the GPU):
 *  - where grass grows and its colour (RGBA): ground with green in it in Sentinel-2 (10 m, CC BY;
 *    not Google's imagery: its terms rule out analysing it), denser where that green is
 *    saturated, and not a road, runway, building, water or forest in OpenStreetMap; the colour from
 *    Sentinel-2, brought towards a lush grass tone (its 10 m pixels average in soil and shade);
 *  - which of it is mown (R): inside aerodromes and along grass runways and taxiways; how lush
 *    it is (G) from Sentinel-2's saturation: washed-out green is degraded grass;
 *  - the ground's height (Terrarium, as the renderer and the flight model use) every 2 m.
 * Maps are rasterised with OffscreenCanvas (roads stroked at their width, areas filled): fast
 * and antialiased. Visual only.
 */
import { TerrariumTerrain, lonLatToTile } from "@webflight/environment";
import { decodeMvt, LocalFrame, type MvtLayer } from "@webflight/scenery";

declare const self: DedicatedWorkerGlobalScope;

export interface FieldRequest {
  id: number;
  /** Centre and size of the square [deg, m]; res: map texels across. */
  lat: number;
  lon: number;
  sizeM: number;
  res: number;
  /** Height samples across (spacing sizeM / (heightRes − 1)). */
  heightRes: number;
  osmUrl: string;
  s2Url: string;
  /** East, north [m] to move OpenStreetMap's roads, buildings etc. by, onto the photo (photo-align.ts). */
  osmShift?: [number, number];
}

export interface FieldResult {
  id: number;
  /** Ground height at the centre [m] (the local frame's origin). */
  originM: number;
  /** res² RGBA, rows south to north: colour, A coverage. */
  mask: Uint8Array;
  /** res² RGBA: R mown (0–255). */
  params: Uint8Array;
  /** heightRes² ground heights above the origin [m], rows south to north. */
  heights: Float32Array;
}

const terrain = new TerrariumTerrain({ zoom: 13, maxTiles: 64 });
const osmCache = new Map<string, Promise<MvtLayer[]>>();
const s2Cache = new Map<string, Promise<Uint8ClampedArray>>();
const fill = (u: string, z: number, x: number, y: number) => u.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

function cached<T>(m: Map<string, Promise<T>>, k: string, make: () => Promise<T>, max = 16): Promise<T> {
  let p = m.get(k);
  if (!p) {
    p = make();
    p.catch(() => m.delete(k));
    m.set(k, p);
    if (m.size > max) m.delete(m.keys().next().value!);
  }
  return p;
}
const osm = (url: string, x: number, y: number) =>
  cached(osmCache, `${x}/${y}`, async () => {
    const r = await fetch(fill(url, 14, x, y));
    if (!r.ok) throw new Error(`osm ${r.status}`);
    return decodeMvt(new Uint8Array(await r.arrayBuffer()));
  });
const s2 = (url: string, x: number, y: number) =>
  cached(s2Cache, `${x}/${y}`, async () => {
    const r = await fetch(fill(url, 14, x, y));
    if (!r.ok) throw new Error(`s2 ${r.status}`);
    const b = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
    c.drawImage(b, 0, 0);
    return c.getImageData(0, 0, 256, 256).data;
  });

const ROAD_W: Record<string, number> = { motorway: 22, trunk: 16, primary: 12, secondary: 9, tertiary: 7.5, minor: 5.5, service: 3.5, track: 3, path: 1.3, rail: 4, transit: 4 };

self.onmessage = async (ev: MessageEvent<FieldRequest>) => {
  try {
    const out = await build(ev.data);
    self.postMessage(out, [out.mask.buffer, out.params.buffer, out.heights.buffer]);
  } catch (e) {
    self.postMessage({ id: ev.data.id, error: String(e) });
  }
};

async function build(q: FieldRequest): Promise<FieldResult> {
  const half = q.sizeM / 2;
  await terrain.load(q.lat, q.lon, q.sizeM + 100);
  const ground = (lon: number, lat: number) => terrain.heightAt(lat, lon) ?? 0;
  const frame = new LocalFrame(q.lon, q.lat, ground(q.lon, q.lat));
  // The zoom-14 tiles the square touches (up to four).
  const tiles = new Map<string, [number, number]>();
  for (const [de, dn] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const [lon, lat] = frame.lonLat(de * half, dn * half);
    const [fx, fy] = lonLatToTile(lon, lat, 14);
    tiles.set(`${Math.floor(fx)}/${Math.floor(fy)}`, [Math.floor(fx), Math.floor(fy)]);
  }
  const loaded = await Promise.all([...tiles.values()].map(async ([x, y]) => ({ x, y, layers: await osm(q.osmUrl, x, y), sat: await s2(q.s2Url, x, y) })));

  // Rasterise: canvas pixel (0,0) is the square's north-west corner.
  const R = q.res, px = R / q.sizeM;
  const toPx = (e: number, n: number): [number, number] => [(e + half) * px, (half - n) * px];
  const allow = new OffscreenCanvas(R, R).getContext("2d", { willReadFrequently: true })!;
  const mown = new OffscreenCanvas(R, R).getContext("2d", { willReadFrequently: true })!;
  allow.fillStyle = "#fff";
  allow.fillRect(0, 0, R, R);
  mown.fillStyle = "#000";
  mown.fillRect(0, 0, R, R);
  for (const g of [allow, mown]) (g.lineCap = "round"), (g.lineJoin = "round");
  const [se, sn] = q.osmShift ?? [0, 0];
  const path = (g: OffscreenCanvasRenderingContext2D, rings: [number, number][][]) => {
    g.beginPath();
    for (const ring of rings)
      ring.forEach(([e, n], i) => {
        const [x, y] = toPx(e, n);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
  };
  for (const { x: tx, y: ty, layers } of loaded) {
    const tileLL = (ppx: number, ppy: number, ext: number): [number, number] => {
      const X = tx + ppx / ext, Y = ty + ppy / ext, n2 = 2 ** 14;
      return [(X / n2) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n2))) * 180) / Math.PI];
    };
    for (const l of layers) {
      const toLocal = (r: [number, number][]) =>
        r.map(([a, b]) => {
          const [e, n] = frame.en(...tileLL(a, b, l.extent));
          return [e + se, n + sn] as [number, number];
        });
      for (const f of l.features) {
        const cls = String(f.properties["class"] ?? "");
        const geo = () => f.geometry.map(toLocal);
        if (l.name === "transportation" && f.type === 2 && ROAD_W[cls]) {
          allow.strokeStyle = "#000";
          allow.lineWidth = (ROAD_W[cls]! + 0.8) * px;
          path(allow, geo());
          allow.stroke();
        } else if (l.name === "aeroway") {
          const g = geo();
          if (f.type === 2 && (cls === "runway" || cls === "taxiway")) {
            // Paved runways have no grass; grass strips get mown grass. Untagged: paved only
            // if long.
            const surf = String(f.properties["surface"] ?? "");
            let len = 0;
            for (const pts of g) for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
            const paved = /asphalt|concrete|paved/.test(surf) || (surf === "" && len > 1500);
            const ctx = paved ? allow : mown;
            ctx.strokeStyle = paved ? "#000" : "#fff";
            ctx.lineWidth = (cls === "runway" ? (paved ? 32 : 36) : paved ? 14 : 16) * px;
            path(ctx, g);
            ctx.stroke();
          } else if (f.type === 3 && cls === "aerodrome") {
            mown.fillStyle = "#fff";
            path(mown, g);
            mown.fill("evenodd");
          } else if (f.type === 3 && (cls === "apron" || cls === "runway" || cls === "taxiway" || cls === "helipad")) {
            allow.fillStyle = "#000";
            path(allow, g);
            allow.fill("evenodd");
          }
        } else if ((l.name === "building" || l.name === "water" || (l.name === "landcover" && cls === "wood")) && f.type === 3) {
          allow.fillStyle = "#000";
          path(allow, geo());
          allow.fill("evenodd");
        }
      }
    }
  }
  const A = allow.getImageData(0, 0, R, R).data, M = mown.getImageData(0, 0, R, R).data;

  // Colour and coverage per texel (rows from the south: texture v up = north).
  const mask = new Uint8Array(R * R * 4), params = new Uint8Array(R * R * 4);
  const satAt = (lon: number, lat: number): [number, number, number] => {
    const [fx, fy] = lonLatToTile(lon, lat, 14);
    const t = loaded.find((s) => s.x === Math.floor(fx) && s.y === Math.floor(fy)) ?? loaded[0]!;
    // Bilinear in the 256² tile.
    const x = Math.min(254.999, Math.max(0, (fx - t.x) * 256 - 0.5)), y = Math.min(254.999, Math.max(0, (fy - t.y) * 256 - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), ax = x - x0, ay = y - y0, d = t.sat;
    const c = [0, 0, 0] as [number, number, number];
    for (let k = 0; k < 3; k++) {
      const v = (xx: number, yy: number) => d[(yy * 256 + xx) * 4 + k]!;
      c[k] = (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) + (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay;
    }
    return c;
  };
  for (let j = 0; j < R; j++) {
    const n = ((j + 0.5) / R) * q.sizeM - half, cy = R - 1 - j; // canvas row of this texel
    for (let i = 0; i < R; i++) {
      const e = ((i + 0.5) / R) * q.sizeM - half;
      const [lon, lat] = frame.lonLat(e, n);
      const [r, g, b] = satAt(lon, lat);
      // The ground's colour decides: saturated green is lush grass; the same hue washed out
      // (low saturation) is degraded grass, sparse and dry; brown or grey with no green in it
      // (soil, ploughed land, gravel) has none.
      const green = g - (r + b) / 2;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx > 0 ? (mx - mn) / mx : 0;
      const smooth = (a0: number, a1: number, x: number) => {
        const t = Math.min(1, Math.max(0, (x - a0) / (a1 - a0)));
        return t * t * (3 - 2 * t);
      };
      const hasGreen = smooth(-2, 6, green);
      const lush = smooth(0.12, 0.32, sat) * smooth(2, 12, green);
      const cov = (A[(cy * R + i) * 4]! / 255) * hasGreen * (0.3 + 0.7 * lush);
      const o = (j * R + i) * 4;
      // Towards lush grass: Sentinel-2's pixels mix in soil and shade.
      mask[o] = Math.min(255, r * 1.15 * 0.4 + 98 * 0.6);
      mask[o + 1] = Math.min(255, g * 1.25 * 0.4 + 128 * 0.6);
      mask[o + 2] = Math.min(255, b * 0.95 * 0.4 + 56 * 0.6);
      mask[o + 3] = Math.round(255 * cov);
      params[o] = M[(cy * R + i) * 4]!;
      params[o + 1] = Math.round(255 * lush);
      params[o + 3] = 255;
    }
  }

  const H = q.heightRes, heights = new Float32Array(H * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < H; i++) {
      const e = (i / (H - 1)) * q.sizeM - half, n = (j / (H - 1)) * q.sizeM - half;
      const [lon, lat] = frame.lonLat(e, n);
      heights[j * H + i] = frame.up(e, n, ground(lon, lat));
    }
  return { id: q.id, originM: frame.heightM, mask, params, heights };
}
