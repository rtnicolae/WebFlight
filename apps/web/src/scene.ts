/** Cesium viewer: real terrain (Terrarium) or the plain ellipsoid, light and atmosphere, runways, cumulus. */
import {
  PostProcessStage,
  Cartesian3,
  Color,
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
import { CloudLayer } from "./clouds.ts";

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
  /** Contrast-adaptive sharpening, 0 (off) to 1. */
  sharpen?: number;
}

/**
 * Contrast-adaptive sharpening (after AMD FidelityFX CAS): each pixel is pushed away from its
 * four neighbours by an amount that shrinks where local contrast is already high, so texture
 * detail softened by mip filtering at grazing angles comes back without halos at edges.
 */
const SHARPEN_FS = `
uniform sampler2D colorTexture;
uniform float sharpness;
in vec2 v_textureCoordinates;
void main() {
  vec2 px = 1.0 / czm_viewport.zw;
  vec2 uv = v_textureCoordinates;
  vec4 c4 = texture(colorTexture, uv);
  vec3 c = c4.rgb;
  vec3 a = texture(colorTexture, uv - vec2(0.0, px.y)).rgb;
  vec3 b = texture(colorTexture, uv - vec2(px.x, 0.0)).rgb;
  vec3 d = texture(colorTexture, uv + vec2(px.x, 0.0)).rgb;
  vec3 e = texture(colorTexture, uv + vec2(0.0, px.y)).rgb;
  // Work in a 0..1 range (HDR values are scaled down by the local maximum).
  vec3 mx = max(max(max(a, b), max(c, d)), e);
  vec3 mn = min(min(min(a, b), min(c, d)), e);
  float scale = max(1.0, max(mx.r, max(mx.g, mx.b)));
  mx /= scale; mn /= scale;
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 4.5, sharpness));
  vec3 o = (c + (a + b + d + e) * w) / (1.0 + 4.0 * w);
  out_FragColor = vec4(max(o, vec3(0.0)), c4.a);
}`;

export function createViewer(container: HTMLElement, opts: LookOptions): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: false,
    // 3D only: no 2D/Columbus views, and custom primitives need only 3D positions.
    scene3DOnly: true,
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
  // Sharpening runs before FXAA (Cesium applies FXAA last), so FXAA only smooths the edges.
  if ((opts.sharpen ?? 0) > 0) scene.postProcessStages.add(new PostProcessStage({ fragmentShader: SHARPEN_FS, uniforms: { sharpness: Math.min(1, opts.sharpen!) } }));
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
  if (!r.paved) {
    // Grass strip: a mown band a shade lighter than the field, no paint (real grass strips
    // have none; the opaque lime band with white bars looked like a paved runway).
    quad(-L, L, -W, W, Color.fromCssColorString("#9db07a").withAlpha(0.22), 0);
    return;
  }
  quad(-L, L, -W, W, Color.fromCssColorString("#55585c"), 0);
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
  const p = new CustomHeightmapTerrainProvider({
    width: 65,
    height: 65,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: "Terrain Tiles © Mapzen and others (SRTM, GMTED2010, ETOPO1, …)",
    callback: (x, y, level) => terrain.mercatorHeightmap(level, x, y, 65),
  });
  // Say where detail ends. Cesium's default ("unknown") lets it refine without limit when the
  // camera is right at the ground, and past level 30 its traversal crashes ("d.southwest").
  // Beyond the last level, tiles are upsampled and refinement stops.
  p.getTileDataAvailable = (_x: number, _y: number, level: number) => level <= MAX_TERRAIN_LEVEL;
  return p;
}
/** Deepest terrain level (~10 m tiles at 45° N; the imagery stops at 21). */
export const MAX_TERRAIN_LEVEL = 22;

/**
 * A cumulus over each thermal (sprite clouds, clouds.ts): flat base at the thermal's cloud
 * base, growing while the thermal forms and fading as it dies, so clouds mark the lift as
 * real ones do. With `columns`, the lift columns are drawn too.
 */
export class ThermalLayer {
  private readonly clouds: CloudLayer;
  private readonly columns = new Map<string, Entity>();

  constructor(
    private readonly viewer: Viewer,
    private readonly showColumns = false,
    sun: { azimuthDeg: number; elevationDeg: number } = { azimuthDeg: 230, elevationDeg: 40 },
    /** Whether the day's thermals are marked by cumulus (else blue: no clouds drawn). */
    private readonly cumulus = true,
  ) {
    const az = (sun.azimuthDeg * Math.PI) / 180, el = (Math.max(5, sun.elevationDeg) * Math.PI) / 180;
    this.clouds = new CloudLayer(viewer.scene, { e: Math.sin(az) * Math.cos(el), n: Math.cos(az) * Math.cos(el), u: Math.sin(el) });
  }

  update(list: ThermalView[]): void {
    this.clouds.set(
      (this.cumulus ? list : []).map((t) => ({
        id: t.id,
        latDeg: t.latDeg,
        lonDeg: t.lonDeg,
        baseM: t.topM,
        // Cumulus are wider than the thermal feeding them.
        radiusM: Math.max(300, t.radiusM * 2.2),
        size: t.phase === "formed" ? 1 : t.phase === "forming" ? 0.6 : t.phase === "dying" ? 0.75 : 0,
        opacity: t.phase === "dying" ? 0.55 : t.phase === "dead" ? 0 : 1,
      })),
    );
    if (!this.showColumns) return;
    list.forEach((t) => {
      let col = this.columns.get(t.id);
      if (!col) {
        const len = t.topM - t.groundM;
        col = this.viewer.entities.add({
          position: Cartesian3.fromDegrees(t.lonDeg, t.latDeg, t.groundM + len / 2),
          cylinder: { length: len, topRadius: t.radiusM, bottomRadius: t.radiusM, material: Color.ORANGE.withAlpha(0.12), outline: false },
        });
        this.columns.set(t.id, col);
      }
      col.show = t.phase === "formed" || t.phase === "forming";
    });
  }
}

export const offsetNorthDeg = (m: number) => m / M_PER_DEG_LAT;
export { Cartesian3 };
