/** Cesium viewer on the plain WGS84 ellipsoid with a grid for motion cues and a grass strip. */
import {
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  GridImageryProvider,
  ImageryLayer,
  JulianDate,
  OpenStreetMapImageryProvider,
  Rectangle,
  sampleTerrainMostDetailed,
  Viewer,
  type TerrainProvider,
} from "cesium";

export interface Airfield {
  latDeg: number;
  lonDeg: number;
  /** Runway heading [deg true]; runway is drawn north-aligned for now. */
  lengthM: number;
  widthM: number;
}

const M_PER_DEG_LAT = 111_132;

export function createViewer(container: HTMLElement, opts: { osm: boolean }): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shadows: false,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Color.fromCssColorString("#5f7f3e");
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  if (opts.osm) {
    viewer.imageryLayers.add(new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })));
  } else {
    viewer.imageryLayers.add(
      new ImageryLayer(
        new GridImageryProvider({
          cells: 8,
          color: Color.fromCssColorString("#d9e6c3").withAlpha(0.55),
          glowColor: Color.fromCssColorString("#d9e6c3").withAlpha(0.08),
          backgroundColor: Color.fromCssColorString("#5f7f3e"),
        }),
      ),
    );
  }
  // Midday light (summer, central Europe).
  viewer.clock.currentTime = JulianDate.fromIso8601("2026-06-21T10:30:00Z");
  viewer.clock.shouldAnimate = false;
  // The app drives the camera; keep Cesium's mouse handlers out of the way.
  scene.screenSpaceCameraController.enableInputs = false;
  viewer.cesiumWidget.creditContainer.setAttribute("style", "opacity:0.6;font-size:10px");
  return viewer;
}

/** Grass strip with threshold bars, north-aligned, centred on the airfield point. */
export function addAirfield(viewer: Viewer, a: Airfield): void {
  const dLat = a.lengthM / 2 / M_PER_DEG_LAT;
  const dLon = a.widthM / 2 / (M_PER_DEG_LAT * Math.cos((a.latDeg * Math.PI) / 180));
  const rect = (lat0: number, lat1: number, lon0: number, lon1: number, color: Color) =>
    viewer.entities.add({ rectangle: { coordinates: Rectangle.fromDegrees(lon0, lat0, lon1, lat1), material: color } });
  rect(a.latDeg - dLat, a.latDeg + dLat, a.lonDeg - dLon, a.lonDeg + dLon, Color.fromCssColorString("#7da552"));
  // Threshold and centre-line markers.
  const mLat = 1 / M_PER_DEG_LAT;
  for (const end of [-1, 1]) {
    const lat = a.latDeg + end * (dLat - 15 * mLat);
    for (let i = -3; i <= 3; i++) {
      const lon = a.lonDeg + (i / 3.5) * dLon * 0.85;
      rect(lat - 10 * mLat, lat + 10 * mLat, lon - dLon * 0.05, lon + dLon * 0.05, Color.WHITE.withAlpha(0.85));
    }
  }
  for (let d = -dLat + 60 * mLat; d < dLat - 60 * mLat; d += 50 * mLat) {
    rect(a.latDeg + d, a.latDeg + d + 20 * mLat, a.lonDeg - dLon * 0.04, a.lonDeg + dLon * 0.04, Color.WHITE.withAlpha(0.7));
  }
}

/**
 * Ground height for the FDM. globe.getHeight() reads whatever tiles happen to be loaded,
 * and coarse tiles can be kilometres off (their facets cut below the ellipsoid), so this
 * queries the terrain provider at its most detailed level instead, in the background,
 * and re-queries when the aircraft has moved. heightAt() is undefined until the first
 * accurate answer for the area arrives.
 */
export class TerrainSampler {
  private lastQuery: { lat: number; lon: number } | undefined;
  private value: number | undefined;
  private pending = false;

  constructor(
    private readonly provider: TerrainProvider,
    /** Re-sample after moving this far [m]. */
    private readonly spacingM = 15,
  ) {}

  /** The plain ellipsoid is height 0 everywhere, exactly (and has no tile availability). */
  private get flat(): boolean {
    return this.provider instanceof EllipsoidTerrainProvider;
  }

  /** Await an accurate height at a point (e.g. before starting the FDM there). */
  async prime(latDeg: number, lonDeg: number): Promise<number> {
    if (this.flat) return (this.value = 0);
    const [c] = await sampleTerrainMostDetailed(this.provider, [Cartographic.fromDegrees(lonDeg, latDeg)]);
    this.value = c?.height ?? 0;
    this.lastQuery = { lat: latDeg, lon: lonDeg };
    return this.value;
  }

  heightAt(latDeg: number, lonDeg: number): number | undefined {
    if (this.flat) return 0;
    const q = this.lastQuery;
    const moved = q ? Math.hypot((latDeg - q.lat) * M_PER_DEG_LAT, (lonDeg - q.lon) * M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180)) : Infinity;
    if (moved > this.spacingM && !this.pending) {
      this.pending = true;
      this.lastQuery = { lat: latDeg, lon: lonDeg };
      sampleTerrainMostDetailed(this.provider, [Cartographic.fromDegrees(lonDeg, latDeg)])
        .then(([c]) => {
          if (c && Number.isFinite(c.height)) this.value = c.height;
        })
        .catch(() => {})
        .finally(() => (this.pending = false));
    }
    return this.value;
  }
}

export const offsetNorthDeg = (m: number) => m / M_PER_DEG_LAT;
export { Cartesian3 };
