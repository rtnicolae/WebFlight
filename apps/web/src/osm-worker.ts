/**
 * Builds building and tree meshes from OpenFreeMap tiles off the main thread. Owns its own
 * copy of the Terrarium terrain (the HTTP cache shares the downloads with the renderer's) to
 * set buildings and trees on the same ground the renderer draws.
 */
import { TerrariumTerrain, tileToLonLat } from "@webflight/environment";
import { buildingMesh, fetchOsm, LocalFrame, treeInstances, type Mesh, type OsmTile } from "@webflight/scenery";

export type OsmRequest =
  | { id: number; kind: "buildings"; url: string; x: number; y: number }
  /** Trees of one zoom-16 cell (inside zoom-14 tile x >> 2, y >> 2). */
  | { id: number; kind: "trees"; url: string; x: number; y: number; spacingM: number };

export interface OsmResult {
  id: number;
  /** Local frame origin: lon, lat, height. */
  origin: [number, number, number];
  /** Buildings: a mesh. */
  mesh?: Mesh;
  /** Trees: instances, 5 floats each (see treeInstances). */
  trees?: Float32Array;
}

const terrain = new TerrariumTerrain({ zoom: 13, maxTiles: 256 });
const tiles = new Map<string, Promise<OsmTile>>();
const tile = (url: string, x: number, y: number): Promise<OsmTile> => {
  const k = `${x}/${y}`;
  let t = tiles.get(k);
  if (!t) {
    t = fetchOsm(url, 14, x, y).catch(() => ({ buildings: [], forests: [] }));
    tiles.set(k, t);
    // Keep the last few dozen decoded tiles: trees ask for the same parent many times.
    if (tiles.size > 40) tiles.delete(tiles.keys().next().value!);
  }
  return t;
};

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
  const [osm] = await Promise.all([req.kind === "buildings" ? tile(req.url, req.x, req.y) : tile(req.url, req.x >> 2, req.y >> 2), terrain.load(clat, clon, halfM)]);
  const ground = (lon: number, lat: number) => terrain.heightAt(lat, lon) ?? 0;
  const frame = new LocalFrame(clon, clat, ground(clon, clat));
  if (req.kind === "buildings") {
    const mesh = buildingMesh(osm.buildings, frame, ground);
    const out: OsmResult = { id: req.id, origin: [clon, clat, frame.heightM], mesh };
    (self as unknown as Worker).postMessage(out, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer]);
  } else {
    const [e0, n1] = frame.en(lon0, lat0), [e1, n0] = frame.en(lon1, lat1);
    const trees = treeInstances(osm.forests, frame, ground, { spacingM: req.spacingM, bounds: { e0, n0, e1, n1 }, max: 6000 });
    const out: OsmResult = { id: req.id, origin: [clon, clat, frame.heightM], trees };
    (self as unknown as Worker).postMessage(out, [trees.buffer]);
  }
}
