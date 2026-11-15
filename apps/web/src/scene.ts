/** Cesium viewer: real terrain (Terrarium) or the plain ellipsoid, light and atmosphere, runways, cumulus. */
import {
  Cartesian2,
  Cartesian3,
  CloudCollection,
  Color,
  type CumulusCloud,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  WebMercatorTilingScheme,
  JulianDate,
  ShadowMode,
  Viewer,
  type Entity,
  type TerrainProvider,
} from "cesium";
import type { TerrariumTerrain } from "@webflight/environment";
import type { ThermalView } from "./protocol.ts";

const M_PER_DEG_LAT = 111_132;

export interface LookOptions {
  terrain?: TerrariumTerrain;
  /** Simulation date/time (sun position). */
  time: Date;
  /** Glider shadow on the ground (costs a shadow map pass). */
  shadows: boolean;
  /**
   * "low": no shadows, no HDR, no MSAA. "high" (default): soft shadows + FXAA.
   * "ultra": + HDR and 4× MSAA (not verified on every GPU: in a software renderer MSAA, and
   * HDR together with shadows, broke the globe).
   */
  quality?: "low" | "high" | "ultra";
}

export function createViewer(container: HTMLElement, opts: LookOptions): Viewer {
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
    msaaSamples: opts.quality === "ultra" ? 4 : 1,
    shadows: opts.shadows,
    terrainShadows: opts.shadows ? ShadowMode.RECEIVE_ONLY : ShadowMode.DISABLED,
  });
  const scene = viewer.scene;
  // Ground colour while imagery streams in.
  scene.globe.baseColor = Color.fromCssColorString("#56703c");
  // Sun-lit globe with atmosphere: haze towards the horizon, warm light at low sun.
  scene.highDynamicRange = opts.quality === "ultra";
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.atmosphereLightIntensity = 12;
  scene.globe.maximumScreenSpaceError = 1.5;
  scene.globe.tileCacheSize = 400;
  scene.globe.preloadSiblings = true;
  scene.fog.enabled = true;
  scene.fog.density = 1.6e-4;
  scene.fog.minimumBrightness = 0.08;
  scene.fog.screenSpaceErrorFactor = 4;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.hueShift = -0.02;
    scene.skyAtmosphere.saturationShift = 0.05;
    scene.skyAtmosphere.brightnessShift = 0.04;
  }
  scene.postProcessStages.fxaa.enabled = true;
  if (opts.shadows) {
    const sm = scene.shadowMap;
    sm.softShadows = true;
    sm.size = 2048;
    sm.maximumDistance = 800;
    sm.darkness = 0.35;
  }
  viewer.clock.currentTime = JulianDate.fromDate(opts.time);
  viewer.clock.shouldAnimate = false;
  // The app drives the camera; keep Cesium's mouse handlers out of the way.
  scene.screenSpaceCameraController.enableInputs = false;
  viewer.cesiumWidget.creditContainer.setAttribute("style", "opacity:0.55;font-size:10px");
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
 * Cesium terrain from the same Terrarium tiles and decoder the FDM uses, in the Web Mercator
 * tiling of the tiles themselves (and of all our imagery, so nothing is reprojected): tile
 * (z, x, y) samples Terrarium zoom min(z, 13) on a 65×65 edge-aligned grid. From level 15
 * the grid is finer than the 13 m Terrarium pixels, so near the glider the drawn ground is
 * the physics ground.
 */
export function terrariumTerrainProvider(terrain: TerrariumTerrain): TerrainProvider {
  return new CustomHeightmapTerrainProvider({
    width: 65,
    height: 65,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: "Terrain Tiles © Mapzen and others (SRTM, GMTED2010, ETOPO1, …)",
    callback: (x, y, level) => terrain.mercatorHeightmap(level, x, y, 65),
  });
}

/**
 * A cumulus over each thermal (Cesium's procedural cumulus impostors): a cluster of puffs
 * with a flat base at the thermal top (cloud base), growing while the thermal forms and
 * fading as it dies. With `columns`, the lift columns are drawn too.
 */
export class ThermalLayer {
  private readonly clouds = new CloudCollection({ noiseDetail: 16.0, noiseOffset: Cartesian3.ZERO });
  private readonly sets = new Map<number, { puffs: { cloud: CumulusCloud; w: number; h: number }[]; column?: Entity }>();

  constructor(
    private readonly viewer: Viewer,
    private readonly columns = false,
  ) {
    viewer.scene.primitives.add(this.clouds);
  }

  update(list: ThermalView[]): void {
    list.forEach((t, i) => {
      let set = this.sets.get(i);
      if (!set) {
        set = { puffs: [] };
        // Deterministic per thermal: a few puffs around the core, the tallest in the middle.
        let seed = (i + 1) * 9301;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const n = 5 + Math.floor(rnd() * 4);
        const r = Math.max(250, t.radiusM);
        const cosLat = Math.cos((t.latDeg * Math.PI) / 180);
        for (let k = 0; k < n; k++) {
          const a = rnd() * 2 * Math.PI, d = k === 0 ? 0 : r * (0.4 + 0.9 * rnd());
          const w = r * (k === 0 ? 2.2 : 1.2 + 0.8 * rnd());
          const h = w * (k === 0 ? 0.75 : 0.45 + 0.25 * rnd());
          const lat = t.latDeg + (d * Math.cos(a)) / M_PER_DEG_LAT, lon = t.lonDeg + (d * Math.sin(a)) / (M_PER_DEG_LAT * cosLat);
          const cloud = this.clouds.add({
            position: Cartesian3.fromDegrees(lon, lat, t.topM + h * 0.42),
            scale: new Cartesian2(w, h),
            maximumSize: new Cartesian3(w, h, w * 0.7),
            slice: 0.36 + 0.1 * rnd(),
            brightness: 1.0,
          });
          set.puffs.push({ cloud, w, h });
        }
        if (this.columns) {
          const len = t.topM - t.groundM;
          set.column = this.viewer.entities.add({
            position: Cartesian3.fromDegrees(t.lonDeg, t.latDeg, t.groundM + len / 2),
            cylinder: { length: len, topRadius: t.radiusM, bottomRadius: t.radiusM, material: Color.ORANGE.withAlpha(0.12), outline: false },
          });
        }
        this.sets.set(i, set);
      }
      const size = t.phase === "formed" ? 1 : t.phase === "forming" ? 0.65 : t.phase === "dying" ? 0.8 : 0;
      const bright = t.phase === "dying" ? 0.82 : 1;
      for (const p of set.puffs) {
        p.cloud.show = size > 0;
        p.cloud.scale = new Cartesian2(p.w * size, p.h * size);
        p.cloud.brightness = bright;
      }
      if (set.column) set.column.show = size > 0;
    });
  }
}

export const offsetNorthDeg = (m: number) => m / M_PER_DEG_LAT;
export { Cartesian3 };
