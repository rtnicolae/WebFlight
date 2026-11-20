/**
 * Builds building and tree meshes from OpenFreeMap tiles off the main thread. Owns its own
 * copy of the Terrarium terrain (the HTTP cache shares the downloads with the renderer's) to
 * set buildings and trees on the same ground the renderer draws.
 */
import { lonLatToTile, TerrariumTerrain, tileToLonLat } from "@webflight/environment";
import { buildingMesh, fetchOsm, footprintColour, LAMP_HEIGHT_M, LocalFrame, townTreeInstances, treeInstances, type Mesh, type OsmPolygon, type OsmTile, type Rgba } from "@webflight/scenery";
import { tileUrl } from "./tile-url.ts";

/** shift: east, north [m] to move everything by, onto the aerial photo (photo-align.ts). */
export type OsmRequest =
  /**
   * far: the light version for towns kilometres away (buildingMesh's `far`); skyline (with
   * far): only blocks and large buildings, what still shows ~10 km away; photoUrl: aerial photo
   * tiles (URL template, tile-url.ts) the roofs take their colours from.
   */
  | { id: number; kind: "buildings"; url: string; x: number; y: number; far?: boolean; skyline?: boolean; photoUrl?: string; shift?: [number, number]; under?: boolean }
  /** Trees of one zoom-16 cell (inside zoom-14 tile x >> 2, y >> 2). */
  | { id: number; kind: "trees"; url: string; x: number; y: number; spacingM: number; shift?: [number, number] };

/**
 * Under Google's 3D tiles: each building 1.5 m inside its outline, at 65 % of its height and no
 * higher than 14 m, so where Google's tiles have the building (a mesh round the real one) they
 * hide ours, and where they have none (flat photo ground: small towns, villages) ours stands.
 * Nothing is read from Google's tiles: the depth test decides. The margins cover our ground
 * (Terrarium, ~30 m SRTM: metres high under trees and in towns) against Google's; seen from
 * ~1 km, where Google draws a city coarser and lower, some of ours still show over theirs.
 */
const UNDER = { insetM: 1.5, heightK: 0.65, capM: 14 };

export interface OsmResult {
  id: number;
  /** Local frame origin: lon, lat, height. */
  origin: [number, number, number];
  /** Buildings: a mesh. */
  mesh?: Mesh;
  /** With buildings: street lamp heads, lon/lat/height triples. */
  lamps?: Float64Array;
  /** Trees: instances, 5 floats each (see treeInstances). */
  trees?: Float32Array;
}

const terrain = new TerrariumTerrain({ zoom: 13, maxTiles: 256 });
const tiles = new Map<string, Promise<OsmTile>>();
const tile = (url: string, x: number, y: number): Promise<OsmTile> => {
  const k = `${x}/${y}`;
  let t = tiles.get(k);
  if (!t) {
    t = fetchOsm(url, 14, x, y).catch(() => ({ buildings: [], forests: [], greens: [], roads: [], lamps: [] }));
    tiles.set(k, t);
    // Keep the last few dozen decoded tiles: trees ask for the same parent many times.
    if (tiles.size > 40) tiles.delete(tiles.keys().next().value!);
  }
  return t;
};


/**
 * The aerial photo over zoom-14 tile x, y at zoom z, as one image (missing tiles transparent);
 * undefined if most of it is missing.
 */
async function photoOver(url: string, x: number, y: number, z: number): Promise<{ img: Rgba; x0: number; y0: number } | undefined> {
  const n = 2 ** (z - 14), size = n * 256;
  const c = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true })!;
  let got = 0;
  const jobs: Promise<void>[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      jobs.push(
        fetch(tileUrl(url, x * n + i, y * n + j, z))
          .then(async (r) => {
            if (!r.ok) return;
            c.drawImage(await createImageBitmap(await r.blob()), i * 256, j * 256, 256, 256);
            got++;
          })
          .catch(() => undefined),
      );
  await Promise.all(jobs);
  if (got < (n * n) / 2) return undefined;
  return { img: { w: size, h: size, data: c.getImageData(0, 0, size, size).data }, x0: x * n, y0: y * n };
}

/** Blocks (12 m and up) and large buildings (1500 m² and up): the skyline of a town ~10 km away. */
function skyline(b: OsmPolygon, frame: LocalFrame): boolean {
  if (Number(b.properties["render_height"] ?? 5) >= 12) return true;
  const r = b.rings[0]!.map(([lon, lat]) => frame.en(lon, lat));
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return Math.abs(a / 2) >= 1500;
}

/**
 * Our shader lights a roof in full sun to ~1.1× its colour (osm-layer.ts); the photo shows it
 * lit already. Divided by this, a roof in the midday sun comes out the photo's colour.
 */
const ROOF_LIT = 1.1;

/**
 * Roof colours from the photo (shift: where OSM's outlines sit on it, degrees). Roofs the photo
 * doesn't show (under trees) get the tile's typical roof colour, a little lighter or darker
 * each: a palette colour would stand out among the photo's.
 */
function roofColours(photo: { img: Rgba; x0: number; y0: number }, z: number, dLon: number, dLat: number, clearM: number, polys: OsmPolygon[]): (poly: OsmPolygon) => number[] | undefined {
  const mPerPx = (40_075_016 * Math.cos((tileToLonLat(photo.x0, photo.y0, z)[1] * Math.PI) / 180)) / (256 * 2 ** z);
  const toPx = (lon: number, lat: number): [number, number] => {
    const [tx, ty] = lonLatToTile(lon + dLon, lat + dLat, z);
    return [(tx - photo.x0) * 256, (ty - photo.y0) * 256];
  };
  const seen = new Map<OsmPolygon, number[]>();
  for (const p of polys) {
    const c = footprintColour(photo.img, p.rings[0]!.map(([lon, lat]) => toPx(lon, lat)), clearM / mPerPx);
    if (c) seen.set(p, c.map((v) => Math.min(255, v / ROOF_LIT)));
  }
  if (seen.size < 5) return (p) => seen.get(p);
  const median = [0, 1, 2].map((k) => {
    const v = [...seen.values()].map((c) => c[k]!).sort((a, b) => a - b);
    return v[v.length >> 1]!;
  });
  return (p) => {
    const c = seen.get(p);
    if (c) return c;
    const [lon, lat] = p.rings[0]![0]!;
    const f = 0.88 + 0.24 * (Math.abs(Math.sin(lon * 7.31e5 + lat * 3.17e5)) % 1);
    return median.map((v) => v * f);
  };
}

// One request at a time: tiles are built in the order the renderer asks (nearest first).
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<OsmRequest>) => {
  const req = e.data;
  queue = queue.then(() => build(req)).catch((err: unknown) => console.warn("osm:", err));
};

async function build(req: OsmRequest): Promise<void> {
  const z = req.kind === "buildings" ? 14 : 16;
  const [lon0, lat0] = tileToLonLat(req.x, req.y, z);
  const [lon1, lat1] = tileToLonLat(req.x + 1, req.y + 1, z);
  const [clon, clat] = [(lon0 + lon1) / 2, (lat0 + lat1) / 2];
  const halfM = (Math.abs(lat0 - lat1) * 111_320) / 2 + 300;
  // Roof colours from the photo: ~1.7 m pixels round the glider, ~3.3 m for distant towns,
  // ~6.7 m (one photo tile) for the skyline's large roofs.
  const pz = req.kind !== "buildings" ? 16 : req.skyline ? 14 : req.far ? 15 : 16;
  const [osm, , photo] = await Promise.all([
    req.kind === "buildings" ? tile(req.url, req.x, req.y) : tile(req.url, req.x >> 2, req.y >> 2),
    terrain.load(clat, clon, halfM),
    req.kind === "buildings" && req.photoUrl ? photoOver(req.photoUrl, req.x, req.y, pz) : undefined,
  ]);
  // Built around the tile's centre from the OSM positions, drawn moved by the shift (the
  // origin moves; heights are taken where things end up).
  const [se, sn] = req.shift ?? [0, 0];
  const dLat = sn / 111_195, dLon = se / (111_195 * Math.cos((clat * Math.PI) / 180));
  const ground = (lon: number, lat: number) => terrain.heightAt(lat + dLat, lon + dLon) ?? 0;
  const frame = new LocalFrame(clon, clat, ground(clon, clat));
  const origin: [number, number, number] = [clon + dLon, clat + dLat, frame.heightM];
  if (req.kind === "buildings") {
    // (A copy: the decoded tile is cached and may be asked for again at another level.)
    const buildings = req.skyline ? osm.buildings.filter((b) => skyline(b, frame)) : osm.buildings;
    // Kept ~1.2 m inside the outline (eaves, the street, shadows beside the walls).
    const roofColour = photo ? roofColours(photo, pz, dLon, dLat, 1.2, buildings) : undefined;
    // Near the glider the small parts (balconies, rooftop units, parapets, lamp posts) come
    // in quarters of the tile (west/east × north/south), drawn only when close (osm-layer.ts).
    const detailPart = req.far ? undefined : { count: 4, of: (lon: number, lat: number) => (lon >= clon ? 1 : 0) + (lat < clat ? 2 : 0) };
    const mesh = buildingMesh(buildings, frame, ground, osm.lamps, { far: req.far ?? false, ...(req.far ? { simplifyM: req.skyline ? 2 : 1 } : {}), ...(roofColour ? { roofColour } : {}), ...(detailPart ? { detailPart } : {}), ...(req.under ? { under: UNDER } : {}) });
    const lamps = new Float64Array(osm.lamps.length * 3);
    // The glow sits at the lamp head: 1.55 m from the pole towards the street.
    osm.lamps.forEach((l, i) => {
      const [px, py] = frame.en(...l.pole), [sx, sy] = frame.en(...l.street), d = Math.hypot(sx - px, sy - py) || 1;
      const [lon, lat] = frame.lonLat(px + ((sx - px) / d) * 1.55, py + ((sy - py) / d) * 1.55);
      lamps.set([lon + dLon, lat + dLat, ground(...l.pole) + LAMP_HEIGHT_M - 0.25], i * 3);
    });
    const out: OsmResult = { id: req.id, origin, mesh, lamps };
    const buffers = (x: Mesh) => [x.positions.buffer, x.normals.buffer, x.colors.buffer, x.indices.buffer, x.uvm.buffer];
    (self as unknown as Worker).postMessage(out, [...buffers(mesh), ...(mesh.parts ?? []).flatMap(buffers)]);
  } else {
    const [e0, n1] = frame.en(lon0, lat0), [e1, n0] = frame.en(lon1, lat1);
    const forest = treeInstances(osm.forests, frame, ground, { spacingM: req.spacingM, bounds: { e0, n0, e1, n1 }, max: 6000 });
    // Single trees in gardens, along streets and in parks.
    const town = townTreeInstances(osm, frame, ground, { e0, n0, e1, n1 });
    const trees = new Float32Array(forest.length + town.length);
    trees.set(forest);
    trees.set(town, forest.length);
    const out: OsmResult = { id: req.id, origin, trees };
    (self as unknown as Worker).postMessage(out, [trees.buffer]);
  }
}
