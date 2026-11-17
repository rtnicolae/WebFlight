/**
 * Google Photorealistic 3D Tiles (via Cesium ion, asset 2275207) as the world: real buildings,
 * trees and ground from Google's photogrammetry, in place of the globe, the aerial photo and
 * our OSM buildings, trees and grass (?world=google3d).
 *
 * Three things make it sit in our scene:
 *  - Height. Our world uses Terrarium heights (above mean sea level) as heights above the
 *    ellipsoid (terrain.ts); Google's tiles are true ellipsoidal heights, ~40 m higher round
 *    Brașov (the geoid). So the tiles are lowered by what they stand above our terrain where
 *    the glider is, measured on the tiles (a low percentile of many points, so roofs and
 *    treetops don't count), and measured again after every 10 km flown.
 *  - Haze. Cesium hazes 3D tiles with scene.atmosphere, whose defaults give a dark navy that
 *    doesn't match the pale summer haze we give the ground (scene.ts sets it on the globe):
 *    the same settings go on scene.atmosphere.
 *  - Shadows. The photos already carry the sun's shadows: the tiles only receive ours (the
 *    glider's), they don't cast into the shadow map (Brașov at 300 m: 103 fps, casting too 81).
 *  - Detail. At Cesium's default (screen-space error 16) the forests near the glider are
 *    coarse meshes that look like melted spikes; at 8 they are tree crowns, but that alone
 *    halved the frame rate (99 → 51 fps at Brașov, 300 m). So 8, with the detail falling off
 *    faster with distance (dynamic screen-space error density 1e-3 instead of 2e-4): the same
 *    crowns near the glider at 67 fps (107 fps at 1,000 m over the basin). ?g3dsse= overrides.
 *
 * Google's terms (via Cesium's Terms for Google): display only, attributions shown unchanged,
 * no caching beyond what Google allows, nothing derived from the content.
 */
import { Cartesian3, Cartographic, createGooglePhotorealistic3DTileset, Ellipsoid, Math as CesiumMath, Matrix4, ShadowMode, type Cesium3DTileset, type Viewer } from "cesium";

export class Google3D {
  /** Lowered by this much [m] (tiles above our terrain). */
  offsetM = 0;
  private measuredAt: [number, number] | undefined;
  private measuring = false;

  private constructor(
    private readonly viewer: Viewer,
    readonly tileset: Cesium3DTileset,
    private readonly groundAt: (latDeg: number, lonDeg: number) => number | undefined,
  ) {}

  static async create(viewer: Viewer, groundAt: (latDeg: number, lonDeg: number) => number | undefined, opts: { screenSpaceError?: number } = {}): Promise<Google3D> {
    const tileset = await createGooglePhotorealistic3DTileset(undefined, {
      shadows: ShadowMode.RECEIVE_ONLY,
      maximumScreenSpaceError: opts.screenSpaceError ?? 8,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 1e-3,
    });
    const scene = viewer.scene;
    scene.primitives.add(tileset);
    scene.globe.show = false;
    const g = scene.globe, a = scene.atmosphere;
    a.lightIntensity = g.atmosphereLightIntensity;
    a.hueShift = g.atmosphereHueShift;
    a.saturationShift = g.atmosphereSaturationShift;
    a.brightnessShift = g.atmosphereBrightnessShift;
    return new Google3D(viewer, tileset, groundAt);
  }

  /** Call as the glider moves: measures the height offset at the start and every 10 km. */
  update(latDeg: number, lonDeg: number): void {
    if (this.measuring) return;
    const m = this.measuredAt;
    if (m && distanceM(m[0], m[1], latDeg, lonDeg) < 10_000) return;
    this.measuring = true;
    void this.measure(latDeg, lonDeg).finally(() => (this.measuring = false));
  }

  /**
   * Google's ground minus our terrain at 25 points within ~1 km, the 20th percentile (roofs
   * and treetops only ever add), then the tileset lowered by it along the local vertical.
   */
  private async measure(latDeg: number, lonDeg: number): Promise<void> {
    const pts: Cartographic[] = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) pts.push(Cartographic.fromDegrees(lonDeg + (j * 450) / (111_320 * Math.cos((latDeg * Math.PI) / 180)), latDeg + (i * 450) / 110_540));
    const ours = pts.map((p) => this.groundAt(CesiumMath.toDegrees(p.latitude), CesiumMath.toDegrees(p.longitude)));
    // Sampled where the tiles are drawn now (lowered by the current offset): added back.
    const was = this.offsetM;
    let sampled: (Cartographic | undefined)[];
    try {
      sampled = await this.viewer.scene.sampleHeightMostDetailed(pts.map((p) => Cartographic.clone(p)), [], 0.5);
    } catch (e) {
      console.warn("google3d: could not sample heights", e);
      return;
    }
    const d: number[] = [];
    sampled.forEach((s, i) => {
      const o = ours[i];
      if (s?.height !== undefined && Number.isFinite(s.height) && o !== undefined) d.push(s.height + was - o);
    });
    if (d.length < 8) return;
    d.sort((x, y) => x - y);
    const off = d[Math.floor(d.length * 0.2)]!;
    const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(Cartographic.fromDegrees(lonDeg, latDeg));
    this.tileset.modelMatrix = Matrix4.fromTranslation(Cartesian3.multiplyByScalar(up, -off, new Cartesian3()));
    this.offsetM = off;
    this.measuredAt = [latDeg, lonDeg];
    console.info(`google3d: tiles ${off.toFixed(1)} m above our terrain here (spread ${d[0]!.toFixed(1)}…${d[d.length - 1]!.toFixed(1)} m, ${d.length} points)`);
  }
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180, x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k), y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6_371_000;
}
