/// <reference lib="webworker" />
/**
 * Measures how far the aerial photo is displaced from OpenStreetMap around one zoom-14 tile
 * (see packages/scenery/src/photo-align.ts): the houses of the densest cluster near the tile
 * (the tile's own when it has enough, else its neighbours'), against a 6×6 block of zoom-18
 * photo tiles (~640 m, ~0.42 m pixels at 45° N) around that cluster.
 */
import { lonLatToTile, tileToLonLat } from "@webflight/environment";
import { fetchOsm, photoOffset, type AlignFootprint, type OsmTile } from "@webflight/scenery";
import { tileUrl } from "./tile-url.ts";

declare const self: DedicatedWorkerGlobalScope;

export interface AlignRequest {
  x: number;
  y: number;
  osmUrl: string;
  /** Photo tiles: URL template (tile-url.ts). */
  photoUrl: string;
}

export interface AlignResult {
  x: number;
  y: number;
  /** Where the photo shows things relative to OSM: east, north [m]; null when it can't tell. */
  shift?: [number, number] | null;
  buildings?: number;
  quality?: number;
  error?: string;
}

const PZ = 18, WIN = 6;
const D2R = Math.PI / 180;

const osmTiles = new Map<string, Promise<OsmTile>>();
function osm(url: string, x: number, y: number): Promise<OsmTile> {
  const k = `${x}/${y}`;
  let t = osmTiles.get(k);
  if (!t) {
    t = fetchOsm(url, 14, x, y);
    osmTiles.set(k, t);
    if (osmTiles.size > 30) osmTiles.delete(osmTiles.keys().next().value!);
  }
  return t;
}


async function lumTile(url: string, x: number, y: number): Promise<Float32Array | undefined> {
  try {
    const r = await fetch(tileUrl(url, x, y, PZ));
    if (!r.ok) return undefined;
    const b = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
    c.drawImage(b, 0, 0, 256, 256);
    const d = c.getImageData(0, 0, 256, 256).data, out = new Float32Array(256 * 256);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[4 * i]! + 0.587 * d[4 * i + 1]! + 0.114 * d[4 * i + 2]!;
    return out;
  } catch {
    return undefined;
  }
}

interface House {
  ring: [number, number][];
  heightM: number;
  lon: number;
  lat: number;
}

function houses(t: OsmTile): House[] {
  const out: House[] = [];
  for (const b of t.buildings) {
    const h = Number(b.properties["render_height"] ?? 5);
    const ring = b.rings[0];
    if (!ring || ring.length < 4 || h < 2.5 || h > 7.5 || b.properties["hide_3d"]) continue;
    let lon = 0, lat = 0;
    for (const [a, c] of ring) (lon += a), (lat += c);
    out.push({ ring, heightM: h, lon: lon / ring.length, lat: lat / ring.length });
  }
  return out;
}

async function measure(q: AlignRequest): Promise<AlignResult> {
  const [clon, clat] = tileToLonLat(q.x + 0.5, q.y + 0.5, 14);
  const kx = 111_320 * Math.cos(clat * D2R), ky = 111_320;
  let cand = houses(await osm(q.osmUrl, q.x, q.y));
  if (cand.length < 60) {
    const around: Promise<OsmTile>[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) around.push(osm(q.osmUrl, q.x + dx, q.y + dy).catch(() => ({ buildings: [], forests: [], greens: [], roads: [], lamps: [] })));
    for (const t of await Promise.all(around)) cand = cand.concat(houses(t));
  }
  if (cand.length < 20) return { x: q.x, y: q.y, shift: null, buildings: cand.length };
  // The densest cluster, preferring ones near the tile.
  const dist = (a: { lon: number; lat: number }, lon: number, lat: number) => Math.hypot((a.lon - lon) * kx, (a.lat - lat) * ky);
  cand = cand.sort((a, b) => dist(a, clon, clat) - dist(b, clon, clat)).slice(0, 800);
  let best = cand[0]!, bestScore = -1;
  for (const a of cand) {
    let n = 0;
    for (const b of cand) if (dist(b, a.lon, a.lat) < 250) n++;
    const s = n * Math.exp(-dist(a, clon, clat) / 1500);
    if (s > bestScore) (bestScore = s), (best = a);
  }
  const [tx, ty] = lonLatToTile(best.lon, best.lat, PZ);
  const X0 = Math.floor(tx) - WIN / 2, Y0 = Math.floor(ty) - WIN / 2;
  const tiles = await Promise.all(Array.from({ length: WIN * WIN }, (_, i) => lumTile(q.photoUrl, X0 + (i % WIN), Y0 + Math.floor(i / WIN))));
  if (tiles.filter((t) => !t).length > WIN) return { x: q.x, y: q.y, error: "photo tiles unavailable" };
  const W = WIN * 256, img = { w: W, h: W, data: new Float32Array(W * W).fill(128) };
  tiles.forEach((t, i) => {
    if (!t) return;
    const ox = (i % WIN) * 256, oy = Math.floor(i / WIN) * 256;
    for (let r = 0; r < 256; r++) img.data.set(t.subarray(r * 256, r * 256 + 256), (oy + r) * W + ox);
  });
  const fps: AlignFootprint[] = cand
    .sort((a, b) => dist(a, best.lon, best.lat) - dist(b, best.lon, best.lat))
    .slice(0, 300)
    .map((h) => ({ heightM: h.heightM, ring: h.ring.map(([lon, lat]) => { const [px, py] = lonLatToTile(lon, lat, PZ); return [(px - X0) * 256, (py - Y0) * 256] as [number, number]; }) }));
  const mpp = (156_543.034 * Math.cos(best.lat * D2R)) / 2 ** PZ;
  const o = photoOffset(img, fps, mpp);
  if (!o) return { x: q.x, y: q.y, shift: null, buildings: fps.length };
  return { x: q.x, y: q.y, shift: [o.dx * mpp, -o.dy * mpp], buildings: o.buildings, quality: o.quality };
}

// One at a time (each is ~1 s of arithmetic), in the order asked.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<AlignRequest>) => {
  const q = e.data;
  queue = queue.then(async () => {
    const r = await measure(q).catch((err: unknown) => ({ x: q.x, y: q.y, error: String(err) }) as AlignResult);
    self.postMessage(r);
  });
};
