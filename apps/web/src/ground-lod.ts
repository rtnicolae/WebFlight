/**
 * Ground tiles chosen by where the glider is, not by where the camera looks.
 *
 * Cesium picks each ground tile's level of detail from its distance to the camera and loads
 * only what the camera sees, so orbiting or zooming the view reloads and re-levels the ground.
 * Here the distance is measured from the glider instead, and tiles within `radiusM` of it
 * count as visible whichever way the camera points (selected and loaded, but only drawn when
 * the camera really sees them): the ground near the glider is loaded once and stays as it is
 * while the camera moves.
 *
 * This wraps two methods of Cesium's (private) globe tile provider; if a Cesium update
 * removes them, the globe falls back to its normal camera-based behaviour.
 */
import { Cartesian3, Cartographic, type Viewer } from "cesium";

interface TileLike {
  rectangle: { west: number; south: number; east: number; north: number };
}
interface Provider {
  computeDistanceToTile(tile: TileLike, frameState: object): number;
  computeTileVisibility(tile: TileLike, frameState: object, occluders: unknown): number;
  computeTileLoadPriority?(tile: TileLike, frameState: object): number;
  showTileThisFrame?(tile: TileLike, frameState: object): void;
}

/** Ground detail is as Cesium would choose it up to here [m]; beyond, distances count this many times. */
const FULL_DETAIL_M = Infinity, FAR_COARSENING = 1; // no coarsening: it kept near ground coarse
const VISIBILITY_NONE = -1, VISIBILITY_PARTIAL = 0;
const R_EARTH = 6_371_000;

/** Returns a setter for the glider's position (degrees, metres), to call every frame. */
export function pinGroundToGlider(viewer: Viewer, radiusM = 30_000): (latDeg: number, lonDeg: number, altM: number) => void {
  const provider = (viewer.scene.globe as unknown as { _surface?: { tileProvider?: Provider } })._surface?.tileProvider;
  if (!provider || typeof provider.computeDistanceToTile !== "function" || typeof provider.computeTileVisibility !== "function") return () => {};
  const carto = new Cartographic();
  const eye = { positionWC: new Cartesian3(), positionCartographic: carto };
  let set = false;
  // A frame state whose camera is at the glider; everything else is the real one.
  let lastFs: object | undefined, proxy: object | undefined;
  const atGlider = (fs: object): object => {
    if (fs !== lastFs) {
      lastFs = fs;
      proxy = Object.create(fs, { camera: { value: eye } }) as object;
    }
    return proxy!;
  };
  const distance = provider.computeDistanceToTile.bind(provider);
  // Beyond FULL_DETAIL_M the ground is counted as farther than it is, so it is drawn a level or
  // two coarser: with the whole surroundings kept loaded (not just the view), full detail out
  // to the horizon would be several times the tiles. It depends on the glider's position only.
  provider.computeDistanceToTile = (tile, fs) => {
    if (!set) return distance(tile, fs);
    const d = distance(tile, atGlider(fs));
    return d < FULL_DETAIL_M ? d : FULL_DETAIL_M + (d - FULL_DETAIL_M) * FAR_COARSENING;
  };
  const visibility = provider.computeTileVisibility.bind(provider);
  provider.computeTileVisibility = (tile, fs, occluders) => {
    const v = visibility(tile, fs, occluders);
    hidden.delete(tile);
    if (v !== VISIBILITY_NONE || !set) return v;
    // Outside the view: still wanted if any part of it is within the radius of the glider.
    const r = tile.rectangle;
    const lat = Math.min(r.north, Math.max(r.south, carto.latitude)), lon = Math.min(r.east, Math.max(r.west, carto.longitude));
    const dy = (lat - carto.latitude) * R_EARTH, dx = (lon - carto.longitude) * R_EARTH * Math.cos(carto.latitude);
    if (dx * dx + dy * dy >= radiusM * radiusM) return v;
    hidden.add(tile);
    return VISIBILITY_PARTIAL;
  };
  // Tiles kept only because they are near the glider are selected and loaded like any other,
  // but not drawn: the camera does not see them, and drawing them cost frames.
  const hidden = new WeakSet<object>();
  const show = provider.showTileThisFrame?.bind(provider);
  if (show)
    provider.showTileThisFrame = (tile, fs) => {
      if (!hidden.has(tile)) show(tile, fs);
    };
  // Load order: nearest to the glider first (Cesium's order favours what the camera faces,
  // and with everything around the glider wanted, far tiles would hold up the ground under it).
  // Tiles in view go a little ahead of those behind the camera at the same distance.
  const priority = provider.computeTileLoadPriority?.bind(provider);
  if (priority)
    provider.computeTileLoadPriority = (tile, fs) => {
      if (!set) return priority(tile, fs);
      const d = (tile as unknown as { _distance?: number })._distance ?? 0;
      const facing = d > 0 ? Math.min(2, priority(tile, fs) / d) : 0; // 0 ahead … 2 behind
      return d * (1 + 0.25 * facing);
    };
  return (latDeg, lonDeg, altM) => {
    Cartographic.fromDegrees(lonDeg, latDeg, altM, carto);
    Cartesian3.fromRadians(carto.longitude, carto.latitude, altM, undefined, eye.positionWC);
    set = true;
  };
}
