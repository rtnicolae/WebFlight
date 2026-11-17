/// <reference lib="webworker" />
/**
 * 3D grass for one cell of the ground near the camera (MSFS-style close-range grass):
 * tufts of three tapered blades where the ground is grass — green in the satellite image
 * and not a road, runway, building, water or forest in OpenStreetMap; short mown grass
 * inside aerodromes. Positions in a local east-north-up frame at the cell centre, on the
 * renderer's terrain. Colours come from the satellite pixel under each tuft, so the 3D grass
 * matches the textured ground it stands on. Visual only.
 */
import { TerrariumTerrain, lonLatToTile } from "@webflight/environment";
import { decodeMvt, LocalFrame, rng, type MvtLayer } from "@webflight/scenery";
import { tileUrl } from "../tile-url.ts";

declare const self: DedicatedWorkerGlobalScope;

export interface GrassRequest {
  id: number;
  /** Cell centre and size [m]. */
  lat: number;
  lon: number;
  cellM: number;
  /** Tufts per m² on full grass. */
  density: number;
  osmUrl: string;
  s2Url: string;
  /** Aerial photo tiles (URL template, tile-url.ts): colour and grass test from the photo. */
  photoUrl?: string;
  /** East, north [m] to move OpenStreetMap's roads, buildings etc. by, onto the photo (photo-align.ts). */
  osmShift?: [number, number];
  seed: number;
}

export interface GrassResult {
  id: number;
  origin: [number, number, number];
  positions: Float32Array;
  /** 0 at a blade's base, 1 at its tip (wind sway, fade). */
  sway: Float32Array;
  /** Per vertex: its tuft's root (local frame), so a tuft fades as one. */
  roots: Float32Array;
  colors: Uint8Array;
  count: number;
}

const terrain = new TerrariumTerrain({ zoom: 13, maxTiles: 64 });
const osmCache = new Map<string, Promise<MvtLayer[]>>();
const s2Cache = new Map<string, Promise<Uint8ClampedArray>>();
const fill = (u: string, z: number, x: number, y: number) => u.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

function osm(url: string, x: number, y: number): Promise<MvtLayer[]> {
  const k = `${x}/${y}`;
  let p = osmCache.get(k);
  if (!p) {
    p = fetch(fill(url, 14, x, y)).then(async (r) => {
      if (!r.ok) throw new Error(`osm ${r.status}`);
      return decodeMvt(new Uint8Array(await r.arrayBuffer()));
    });
    p.catch(() => osmCache.delete(k));
    osmCache.set(k, p);
    if (osmCache.size > 16) osmCache.delete(osmCache.keys().next().value!);
  }
  return p;
}
/** Photo tiles at this zoom (~1.2 m pixels at 45° N) for the tuft colours. */
const PHOTO_Z = 17;
const photoCache = new Map<string, Promise<Uint8ClampedArray | undefined>>();
function photoTile(url: string, x: number, y: number): Promise<Uint8ClampedArray | undefined> {
  const k = `${x}/${y}`;
  let p = photoCache.get(k);
  if (!p) {
    p = fetch(tileUrl(url, x, y, PHOTO_Z))
      .then(async (r) => {
        if (!r.ok) return undefined;
        const b = await createImageBitmap(await r.blob());
        const c = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
        c.drawImage(b, 0, 0, 256, 256);
        return c.getImageData(0, 0, 256, 256).data;
      })
      .catch(() => undefined);
    photoCache.set(k, p);
    if (photoCache.size > 32) photoCache.delete(photoCache.keys().next().value!);
  }
  return p;
}

function s2(url: string, x: number, y: number): Promise<Uint8ClampedArray> {
  const k = `${x}/${y}`;
  let p = s2Cache.get(k);
  if (!p) {
    p = fetch(fill(url, 14, x, y)).then(async (r) => {
      if (!r.ok) throw new Error(`s2 ${r.status}`);
      const b = await createImageBitmap(await r.blob());
      const c = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
      c.drawImage(b, 0, 0);
      return c.getImageData(0, 0, 256, 256).data;
    });
    p.catch(() => s2Cache.delete(k));
    s2Cache.set(k, p);
    if (s2Cache.size > 16) s2Cache.delete(s2Cache.keys().next().value!);
  }
  return p;
}

const ROAD_W: Record<string, number> = { motorway: 22, trunk: 16, primary: 12, secondary: 9, tertiary: 7.5, minor: 5.5, service: 3.5, track: 3, path: 1.3, rail: 4, transit: 4 };

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const inside = (ring: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

self.onmessage = async (ev: MessageEvent<GrassRequest>) => {
  try {
    const out = await build(ev.data);
    self.postMessage(out, [out.positions.buffer, out.sway.buffer, out.roots.buffer, out.colors.buffer]);
  } catch (e) {
    self.postMessage({ id: ev.data.id, error: String(e) });
  }
};

async function build(q: GrassRequest): Promise<GrassResult> {
  const [fx, fy] = lonLatToTile(q.lon, q.lat, 14);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  await terrain.load(q.lat, q.lon, q.cellM + 100);
  const [layers, sat] = await Promise.all([osm(q.osmUrl, tx, ty), s2(q.s2Url, tx, ty)]);
  const ground = (lon: number, lat: number) => terrain.heightAt(lat, lon) ?? 0;
  const frame = new LocalFrame(q.lon, q.lat, ground(q.lon, q.lat));
  // The aerial photo under the cell (the tiles its corners fall in), when there is one.
  const photo = new Map<string, Uint8ClampedArray | undefined>();
  if (q.photoUrl) {
    const keys = new Set<string>();
    for (const [de, dn] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const [lon, lat] = frame.lonLat((de * q.cellM) / 2, (dn * q.cellM) / 2);
      const [px, py] = lonLatToTile(lon, lat, PHOTO_Z);
      keys.add(`${Math.floor(px)}/${Math.floor(py)}`);
    }
    await Promise.all([...keys].map(async (k) => {
      const [x, y] = k.split("/").map(Number) as [number, number];
      photo.set(k, await photoTile(q.photoUrl!, x, y));
    }));
  }
  const photoAt = (lon: number, lat: number): [number, number, number] | undefined => {
    if (!photo.size) return undefined;
    const [px, py] = lonLatToTile(lon, lat, PHOTO_Z);
    const d = photo.get(`${Math.floor(px)}/${Math.floor(py)}`);
    if (!d) return undefined;
    const i = (Math.min(255, Math.floor((py % 1) * 256)) * 256 + Math.min(255, Math.floor((px % 1) * 256))) * 4;
    return [d[i]!, d[i + 1]!, d[i + 2]!];
  };
  // Tile pixel (MVT extent e) → local metres.
  const tileLL = (px: number, py: number, e: number): [number, number] => {
    const X = tx + px / e, Y = ty + py / e, n = 2 ** 14;
    return [(X / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI];
  };
  const half = q.cellM / 2 + 30;
  // Whether a feature can touch the cell: its bounding box overlaps the cell's (not its
  // vertices: a runway or a long road has its vertices far away at the ends).
  const near = (pts: [number, number][]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return x0 < half && x1 > -half && y0 < half && y1 > -half;
  };
  // Exclusions in local metres: lines with a half-width, polygons.
  const lines: { pts: [number, number][]; hw: number }[] = [];
  const polys: [number, number][][][] = [];
  const mown: [number, number][][][] = [];
  const mownLines: { pts: [number, number][]; hw: number }[] = [];
  const [se, sn] = q.osmShift ?? [0, 0];
  for (const l of layers) {
    const toLocal = (r: [number, number][]) =>
      r.map(([a, b]) => {
        const [e, n] = frame.en(...tileLL(a, b, l.extent));
        return [e + se, n + sn] as [number, number];
      });
    for (const f of l.features) {
      const cls = String(f.properties["class"] ?? "");
      if (l.name === "transportation" && f.type === 2 && ROAD_W[cls]) {
        for (const g of f.geometry) {
          const pts = toLocal(g);
          if (near(pts)) lines.push({ pts, hw: ROAD_W[cls]! / 2 + 0.4 });
        }
      } else if (l.name === "aeroway") {
        const geo = f.geometry.map(toLocal);
        if (!geo.some(near)) continue;
        if (f.type === 2 && (cls === "runway" || cls === "taxiway")) {
          // Paved runways have no grass; grass strips get short mown grass. Untagged: paved
          // only if long (as the detail layer judges, with the airfield data there).
          const surf = String(f.properties["surface"] ?? "");
          let len = 0;
          for (const pts of geo) for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
          const paved = /asphalt|concrete|paved/.test(surf) || (surf === "" && len > 1500);
          if (paved) for (const pts of geo) lines.push({ pts, hw: cls === "runway" ? 16 : 7 });
          else for (const pts of geo) mownLines.push({ pts, hw: cls === "runway" ? 18 : 8 });
        } else if (f.type === 3 && cls === "aerodrome") mown.push(geo);
        else if (f.type === 3 && (cls === "apron" || cls === "runway" || cls === "taxiway" || cls === "helipad")) polys.push(geo);
      } else if ((l.name === "building" || l.name === "water") && f.type === 3) {
        for (const g of f.geometry) {
          const pts = toLocal(g);
          if (near(pts)) polys.push([pts]);
        }
      } else if (l.name === "landcover" && f.type === 3 && cls === "wood") {
        const geo = f.geometry.map(toLocal);
        if (geo.some(near)) polys.push(geo);
      }
    }
  }
  const inPoly = (p: [number, number][][], x: number, y: number) => p.length > 0 && inside(p[0]!, x, y) && !p.slice(1).some((h) => inside(h, x, y));

  const r = rng(q.seed);
  const n = Math.round(q.cellM * q.cellM * q.density);
  const pos: number[] = [], sway: number[] = [], col: number[] = [], roots: number[] = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const e = (r() - 0.5) * q.cellM, nn = (r() - 0.5) * q.cellM;
    const rot = r() * Math.PI, jitter = r();
    if (lines.some((L) => L.pts.some((_, k) => k > 0 && segDist(e, nn, L.pts[k - 1]![0], L.pts[k - 1]![1], L.pts[k]![0], L.pts[k]![1]) < L.hw))) continue;
    if (polys.some((p) => inPoly(p, e, nn))) continue;
    const [lon, lat] = frame.lonLat(e, nn);
    // Colour under the tuft: the aerial photo's where there is one (the blades then match the
    // ground they stand on), else Sentinel-2's. Only green ground gets grass.
    const [sx, sy] = lonLatToTile(lon, lat, 14);
    const px = Math.min(255, Math.max(0, Math.floor((sx - tx) * 256))), py = Math.min(255, Math.max(0, Math.floor((sy - ty) * 256)));
    const k = (py * 256 + px) * 4;
    const ph = photoAt(lon, lat);
    const [R, G, B] = ph ?? [sat[k]!, sat[k + 1]!, sat[k + 2]!];
    const green = G - (R + B) / 2;
    if (green < 2 + jitter * 6) continue;
    const onLine = (L: { pts: [number, number][]; hw: number }) => L.pts.some((_, k) => k > 0 && segDist(e, nn, L.pts[k - 1]![0], L.pts[k - 1]![1], L.pts[k]![0], L.pts[k]![1]) < L.hw);
    const short = mownLines.some(onLine) || mown.some((p) => inPoly(p, e, nn));
    const h = short ? 0.04 + 0.05 * r() : 0.12 + 0.24 * r();
    const z = frame.up(e, nn, ground(lon, lat)) - 0.01;
    const v = 0.9 + 0.2 * r();
    // On the photo: its colour, roots a little darker, tips a little lighter (they catch the
    // light). Sentinel-2's 10 m pixels average in soil and shadow, so without a photo they are
    // brought towards a lush grass tone as before.
    const gR = ph ? R * v : (R * 1.15 * 0.4 + 98 * 0.6) * v, gG = ph ? G * v : (G * 1.25 * 0.4 + 128 * 0.6) * v, gB = ph ? B * v : (B * 0.95 * 0.4 + 56 * 0.6) * v;
    const BL = 3;
    // Per tuft: a random byte in the colour's alpha, so the renderer thins grass out with
    // distance tuft by tuft (stable as the camera moves) rather than pixel by pixel.
    const keep = Math.floor(r() * 255);
    for (let b = 0; b < BL; b++) {
      const a = rot + (b * Math.PI * 2) / BL + (r() - 0.5) * 0.8;
      const w = (short ? 0.015 : 0.02) * (0.7 + 0.6 * r()); // three wider blades per tuft
      const lean = (short ? 0.15 : 0.3) * h * r();
      const ca = Math.cos(a), sa = Math.sin(a);
      const rad = (short ? 0.03 : 0.05) * r();
      const ox = Math.cos(a + 1.3) * rad, oy = Math.sin(a + 1.3) * rad;
      const bh = h * (0.6 + 0.6 * r());
      // Base left, base right, tip (leaning outwards).
      pos.push(e + ox - sa * w, nn + oy + ca * w, z, e + ox + sa * w, nn + oy - ca * w, z, e + ox + ca * lean, nn + oy + sa * lean, z + bh);
      sway.push(0, 0, 1);
      roots.push(e, nn, z, e, nn, z, e, nn, z);
      const tipK = ph ? 1.04 + 0.08 * r() : 1.18 + 0.12 * r();
      const lift = ph ? 0 : 1;
      col.push(gR * 0.85, gG * 0.85, gB * 0.8, keep, gR * 0.85, gG * 0.85, gB * 0.8, keep, Math.min(255, gR * tipK + 8 * lift), Math.min(255, gG * tipK + 6 * lift), Math.min(255, gB * (ph ? tipK : 1.05)), keep);
    }
    count++;
  }
  return { id: q.id, origin: [q.lon, q.lat, frame.heightM], positions: new Float32Array(pos), sway: new Float32Array(sway), roots: new Float32Array(roots), colors: new Uint8Array(col), count };
}
