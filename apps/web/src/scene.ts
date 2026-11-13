/** Cesium viewer: real terrain (Terrarium) or the plain ellipsoid, a grid or OSM imagery, runways, thermal clouds. */
import {
  Cartesian3,
  Color,
  ColorMaterialProperty,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  GridImageryProvider,
  ImageryLayer,
  JulianDate,
  OpenStreetMapImageryProvider,
  Viewer,
  type Entity,
  type TerrainProvider,
} from "cesium";
import type { TerrariumTerrain } from "@webflight/environment";
import type { ThermalView } from "./protocol.ts";

const M_PER_DEG_LAT = 111_132;

export function createViewer(container: HTMLElement, opts: { osm: boolean; terrain?: TerrariumTerrain }): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: false,
    terrainProvider: opts.terrain ? terrariumTerrainProvider(opts.terrain) : new EllipsoidTerrainProvider(),
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

export interface Runway {
  latDeg: number;
  lonDeg: number;
  /** True heading of the runway's low-numbered direction [deg]. */
  headingDeg: number;
  lengthM: number;
  widthM: number;
  /** Paved (grey, white markings) or grass. */
  paved: boolean;
}

/** Runway with thresholds and centre line, draped on the terrain, centred on its midpoint. */
export function addRunway(viewer: Viewer, r: Runway): void {
  const h = (r.headingDeg * Math.PI) / 180;
  const cosLat = Math.cos((r.latDeg * Math.PI) / 180);
  /** Position at `along` m in the heading direction and `across` m to its right. */
  const at = (along: number, across: number) => {
    const n = along * Math.cos(h) - across * Math.sin(h);
    const e = along * Math.sin(h) + across * Math.cos(h);
    return Cartesian3.fromDegrees(r.lonDeg + e / (M_PER_DEG_LAT * cosLat), r.latDeg + n / M_PER_DEG_LAT);
  };
  const quad = (a0: number, a1: number, c0: number, c1: number, color: Color, zIndex: number) =>
    viewer.entities.add({ polygon: { hierarchy: [at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)], material: color, zIndex } });
  const L = r.lengthM / 2, W = r.widthM / 2;
  quad(-L, L, -W, W, Color.fromCssColorString(r.paved ? "#55585c" : "#7da552"), 0);
  const mark = Color.WHITE.withAlpha(0.85);
  for (const end of [-1, 1]) {
    // Threshold bars.
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      const c = (i / 3.6) * W;
      const a = end * (L - 6);
      quad(a - end * 30, a, c - W * 0.06, c + W * 0.06, mark, 1);
    }
  }
  for (let a = -L + 60; a < L - 80; a += 50) quad(a, a + 25, -0.45, 0.45, mark, 1);
}

/**
 * Cesium terrain from the same Terrarium tiles and decoder the FDM worker uses (geographic
 * tiling, 33×33 samples per tile; at level 15+ the samples come from zoom 13, as physics).
 */
export function terrariumTerrainProvider(terrain: TerrariumTerrain): TerrainProvider {
  const tiling = new GeographicTilingScheme();
  const deg = 180 / Math.PI;
  return new CustomHeightmapTerrainProvider({
    width: 33,
    height: 33,
    tilingScheme: tiling,
    credit: "Terrain Tiles © Mapzen and others (SRTM, GMTED2010, ETOPO1, …)",
    callback: (x, y, level) => {
      const r = tiling.tileXYToRectangle(x, y, level);
      return terrain.heightmap(r.west * deg, r.south * deg, r.east * deg, r.north * deg, 33, 33);
    },
  });
}

/** Cumulus clouds at the top of each thermal; with `columns`, the lift columns too. */
export class ThermalLayer {
  private readonly entities = new Map<number, { cloud: Entity; column?: Entity }>();

  constructor(
    private readonly viewer: Viewer,
    private readonly columns = false,
  ) {}

  update(list: ThermalView[]): void {
    list.forEach((t, i) => {
      let e = this.entities.get(i);
      const alpha = t.phase === "formed" ? 0.9 : t.phase === "forming" ? 0.55 : t.phase === "dying" ? 0.35 : 0;
      const pos = Cartesian3.fromDegrees(t.lonDeg, t.latDeg, t.topM + t.radiusM * 0.5);
      if (!e) {
        const cloud = this.viewer.entities.add({
          position: pos,
          ellipsoid: { radii: new Cartesian3(t.radiusM * 1.6, t.radiusM * 1.6, t.radiusM * 0.6), material: Color.WHITE.withAlpha(alpha) },
        });
        e = { cloud };
        if (this.columns) {
          const len = t.topM - t.groundM;
          e.column = this.viewer.entities.add({
            position: Cartesian3.fromDegrees(t.lonDeg, t.latDeg, t.groundM + len / 2),
            cylinder: { length: len, topRadius: t.radiusM, bottomRadius: t.radiusM, material: Color.ORANGE.withAlpha(0.12), outline: false },
          });
        }
        this.entities.set(i, e);
      }
      const g = e.cloud.ellipsoid!;
      g.material = new ColorMaterialProperty(Color.WHITE.withAlpha(alpha));
      e.cloud.show = alpha > 0;
      if (e.column) e.column.show = alpha > 0;
    });
  }
}

export const offsetNorthDeg = (m: number) => m / M_PER_DEG_LAT;
export { Cartesian3 };
