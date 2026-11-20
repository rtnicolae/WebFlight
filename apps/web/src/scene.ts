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
import { LOOK } from "./lighting.ts";
import type { TerrariumTerrain } from "@webflight/environment";
import type { ThermalView } from "./protocol.ts";
import { CloudLayer, type CloudSpec } from "./clouds.ts";
import type { Thermal } from "@webflight/environment";
import { VOLUME_RANGE_M, VolumetricClouds } from "./vclouds.ts";
import type { Atmosphere } from "./atmosphere.ts";

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
  /** MSAA samples (default: 4 on ultra, else 1). */
  msaa?: number;
  /** How far shadows reach [m] (default: with the glider's height, see followShadows). */
  shadowDistanceM?: number;
}

/**
 * Contrast-adaptive sharpening (after AMD FidelityFX CAS): each pixel is pushed away from its
 * four neighbours by an amount that shrinks where local contrast is already high, so texture
 * detail softened by mip filtering at grazing angles comes back without halos at edges.
 */
export const SHARPEN_FS = `
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

let fixedShadowReach = false;

/** How far shadows reach [m] at a height above the ground [m]: ~the ground in view, 1–4 km. */
export function shadowReachFor(aglM: number): number {
  return Math.min(4000, Math.max(1000, 1000 + 3 * aglM));
}

/** Shadows reach as far as the ground the glider sees at its height (unless ?shadowdist= fixed them). */
export function followShadows(viewer: Viewer, aglM: number, cockpit = false): void {
  if (!viewer.shadows) return;
  // Cascade depths (Cesium clamps them like this near a small model): from the cockpit the
  // nearest is 2.5 m deep, so the canopy frame's shadow on the sill half a metre from the eye
  // is sharp (with the chase view's 25 m one, ~1.7 cm a shadow texel, it fell in steps).
  const caps = (viewer.scene.shadowMap as unknown as { _maximumCascadeDistances?: number[] })._maximumCascadeDistances;
  const want3 = cockpit ? COCKPIT_CASCADES : CHASE_CASCADES;
  if (caps?.length === 4 && caps[0] !== want3[0]) caps.splice(0, 3, ...want3);
  if (fixedShadowReach) return;
  const want = Math.round(shadowReachFor(aglM) / 50) * 50;
  if (viewer.scene.shadowMap.maximumDistance !== want) viewer.scene.shadowMap.maximumDistance = want;
}
const CHASE_CASCADES = [25, 60, 150], COCKPIT_CASCADES = [2.5, 20, 100];

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
    msaaSamples: opts.msaa ?? (opts.quality === "ultra" ? 4 : 1),
    shadows: opts.shadows,
    terrainShadows: opts.shadows ? ShadowMode.RECEIVE_ONLY : ShadowMode.DISABLED,
  });
  const scene = viewer.scene;
  // Ground colour while imagery streams in.
  scene.globe.baseColor = Color.fromCssColorString("#56703c");
  // The ground hides what is below or behind it. Off (Cesium's default), the globe's depth is
  // cleared before everything else is drawn, so buildings' walls below the ground (they reach
  // 10 m down for slopes) showed as dark bands under every building, and hills did not hide
  // what was behind them.
  scene.globe.depthTestAgainstTerrain = true;
  // Sun-lit globe with atmosphere: haze towards the horizon, warm light at low sun.
  scene.highDynamicRange = opts.quality === "ultra";
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  scene.globe.showGroundAtmosphere = true;
  // Aerial perspective: Cesium colours the ground fog with the atmosphere's scattering at the
  // ground point (GlobeFS.glsl), which on its own is a dark navy, so distant hills went dark
  // instead of fading into haze. Brighter, less saturated scattering on the globe (these feed
  // only the ground and its fog, not the sky) gives the pale blue-grey of summer air.
  scene.globe.atmosphereLightIntensity = 25;
  scene.globe.atmosphereBrightnessShift = 0.3;
  scene.globe.atmosphereSaturationShift = -0.4;
  // Finer than Cesium's default 2: it only saved ~10% of the tiles and blurred the ground.
  scene.globe.maximumScreenSpaceError = 1.5;
  // Tiles out of view stay loaded (turning the camera back shows them at once).
  scene.globe.tileCacheSize = 1200;
  scene.globe.preloadSiblings = true;
  scene.fog.enabled = true;
  // Haze: Cesium's fog is 1 − exp(−(d·ρ)²), ρ = density·heightScalar·(h/800 km)^−0.59 (×~70 at
  // 600 m), thinner with altitude. 4.5e-4 (was 1.9e-4): low down, the mountains 20–40 km away
  // read as pale shapes behind the haze and the near ground stays clear (checked over Brașov
  // at 100 m and Ghimbav at 250 m).
  scene.fog.density = 4.5e-4;
  scene.fog.visualDensityScalar = 1;
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
    // How far shadows reach follows the glider's height (followShadows); a fixed 800 m left
    // every building in view without one from a few hundred metres up, where all the ground
    // in view is further than that. Cesium splits the range into 4 cascades; with a small model
    // close by (the glider) it caps their depths at 25 / 150 / 700 m, which at a few km would
    // stretch the middle ones and blur the shadows round the glider. Capped tighter (internal,
    // so guarded): ~0–25, 25–85, 85–235 m, then the rest, about as sharp near as before; only
    // the last cascade is coarser, where things are far away.
    fixedShadowReach = opts.shadowDistanceM !== undefined;
    sm.maximumDistance = opts.shadowDistanceM ?? shadowReachFor(0);
    const caps = (sm as unknown as { _maximumCascadeDistances?: number[] })._maximumCascadeDistances;
    if (caps?.length === 4) caps.splice(0, 3, ...CHASE_CASCADES);
    sm.darkness = 0.35;
    // More bias than Cesium's defaults: walls nearly edge-on to the sun showed diagonal
    // stripes (shadow acne). Internal, so guarded.
    const bias = (sm as unknown as { _primitiveBias?: { normalOffsetScale: number; depthBias: number } })._primitiveBias;
    if (bias) {
      bias.normalOffsetScale = 0.5;
      bias.depthBias = 0.0001;
    }
  }
  viewer.clock.currentTime = JulianDate.fromDate(opts.time);
  viewer.clock.shouldAnimate = false;
  // The app drives the camera; keep Cesium's mouse handlers out of the way.
  scene.screenSpaceCameraController.enableInputs = false;
  // Nor its terrain collision check: a height query on the ground tile every frame (a linear
  // search over its triangles, ~3% of the main thread in a profile); camera.ts keeps the chase
  // camera above the ground itself.
  scene.screenSpaceCameraController.enableCollisionDetection = false;
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
    viewer.entities.add({ polygon: { hierarchy: [at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)], material: new Color(color.red * LOOK.ground, color.green * LOOK.ground, color.blue * LOOK.ground, color.alpha), zIndex } }); // unlit overlay: takes the time of day from LOOK
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
  // Tiles past the last level are upsampled from their parent, which needs the parent's mesh
  // (HeightmapTerrainData.upsample returns "try later" without it). But Cesium counts a parent
  // as ready as soon as its heights arrived, so a parent that is not itself being drawn (its
  // children are) never got its mesh built, and the children under the glider waited forever
  // while a much coarser ancestor was drawn there (seen: four level-20 tiles stuck for minutes,
  // `globe.tilesLoaded` never true). Reporting `canUpsample` only once the mesh exists makes
  // Cesium advance the parent first, as it does for any parent not ready.
  const request = p.requestTileGeometry.bind(p);
  p.requestTileGeometry = (x, y, level, req) => {
    const r = request(x, y, level, req);
    return r?.then((td) => {
      Object.defineProperty(td, "canUpsample", { get: () => (td as unknown as { _mesh?: unknown })._mesh !== undefined });
      return td;
    });
  };
  return p;
}
/** Deepest terrain level (~55 m tiles at 45° N, a vertex every 0.8 m). Each level deeper quadruples the tiles to load near the camera. */
export const MAX_TERRAIN_LEVEL = 19;

/** A thermal as the layers draw it (from the sky model's Thermal; the worker sends the same). */
export function thermalView(t: Thermal): ThermalView {
  const time = t.cycleTimer / (25 * 60);
  return {
    id: t.id,
    latDeg: t.spec.latDeg,
    lonDeg: t.spec.lonDeg,
    topM: t.spec.heightMslFt * 0.3048,
    groundM: t.spec.groundElevFt * 0.3048,
    radiusM: t.spec.diameterFt * 0.3048 * 0.5,
    strengthMs: t.spec.strengthFps * 0.3048,
    phase: time <= 0.2 ? "forming" : time <= 0.8 ? "formed" : time <= 1 ? "dying" : "dead",
    cycleS: t.cycleTimer,
  };
}

/** 0..1 from a string, stable (a cloud keeps its looks). */
function hash01(id: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * The cumulus through its thermal's life (FG's cycle, minutes). Forming (0–5) is the bubble
 * rising from the ground: it reaches the condensation level, and lift reaches cloud base, at 5,
 * so there is no cloud before (a cloud there promised lift that had not arrived: a pilot who
 * went to a young cloud found nothing under it). Then it grows from a small cloud to full size
 * over three minutes and stays so while the thermal feeds it (to 20); dying (20–25), the
 * thermal is cut off from the ground up and the cloud shrinks and fades, gone when lift at its
 * base stops. Without a cycle time, by phase as before.
 */
function cloudLife(t: ThermalView): { size: number; opacity: number } {
  if (t.cycleS === undefined) return { size: t.phase === "formed" ? 1 : t.phase === "forming" ? 0.6 : t.phase === "dying" ? 0.75 : 0, opacity: t.phase === "dying" ? 0.55 : t.phase === "dead" ? 0 : 1 };
  const m = t.cycleS / 60, smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  if (m < 5 || m >= 25) return { size: 0, opacity: 0 };
  if (m < 20) {
    const g = smooth((m - 5) / 3);
    return { size: 0.35 + 0.65 * g, opacity: Math.min(1, 0.35 + 1.3 * g) };
  }
  const d = smooth((m - 20) / 5);
  return { size: 1 - 0.4 * d, opacity: 1 - d };
}

/**
 * The cumulus over a thermal, sized by it: as wide as 2.2 times the thermal (the thermal
 * model gives a skewed spread of widths, thermals.ts thermalSize), and the stronger the
 * thermal the taller the cloud (flat humilis ~0.5 of the radius over 1 m/s, towers ~2 over
 * 4 m/s), with a little of its own on top.
 */
function cloudsOver(t: ThermalView): CloudSpec[] {
  const { size, opacity } = cloudLife(t);
  const strong = Math.min(1, Math.max(0, (t.strengthMs - 1) / 3));
  return [{ id: t.id, latDeg: t.latDeg, lonDeg: t.lonDeg, baseM: t.topM, groundM: t.groundM, radiusM: Math.max(200, t.radiusM * 2.2), tall: 0.5 + 1.4 * strong + 0.25 * hash01(t.id, 2), size, opacity }];
}

/** Within this distance of the camera clouds are ray-marched volumes; beyond, sprites. */
const VOLUME_M = VOLUME_RANGE_M;
/** Where sprite puffs have faded out (clouds.ts: translucencyByDistance). */
const SPRITE_FADE_M = 70_000;

/**
 * A cumulus over each thermal: flat base at the thermal's cloud base, growing while the thermal
 * forms and fading as it dies, so clouds mark the lift as real ones do. Near ones (within
 * 45 km of the camera) are ray-marched volumes (vclouds.ts), farther ones, to 160 km, the
 * volumes' far map. The flight model's thermals reach ~20 km round the glider; setFar adds the
 * same sky model's thermals farther out (visual only), so the sky is full to the horizon.
 * quality=low or ?clouds=sprites: sprite puffs (clouds.ts) instead, out to where they fade (70 km;
 * a fifth of the puffs beyond 45 km). With `columns`, the lift columns are drawn too.
 */
export class ThermalLayer {
  private readonly sprites?: CloudLayer;
  private readonly volumes?: VolumetricClouds;
  private readonly columns = new Map<string, Entity>();
  private near: ThermalView[] = [];
  private far: ThermalView[] = [];

  constructor(
    private readonly viewer: Viewer,
    private readonly showColumns = false,
    sun: { azimuthDeg: number; elevationDeg: number } = { azimuthDeg: 230, elevationDeg: 40 },
    /** Whether the day's thermals are marked by cumulus (else blue: no clouds drawn). */
    private readonly cumulus = true,
    /** Gets every cloud on each change (their shadows on the ground: google3d.ts). */
    private readonly shadows?: (clouds: CloudSpec[]) => void,
    /** Our sky (atmosphere.ts): the volumes take its light and haze. */
    atmosphere?: Atmosphere,
  ) {
    const q = new URLSearchParams(location.search);
    // One renderer: the sprites' sheet, billboards and per-frame sort only when they draw.
    if (q.get("clouds") !== "sprites" && !(q.get("quality") === "low" && q.get("clouds") !== "volume")) this.volumes = new VolumetricClouds(viewer, atmosphere);
    else {
      const az = (sun.azimuthDeg * Math.PI) / 180, el = (Math.max(5, sun.elevationDeg) * Math.PI) / 180;
      this.sprites = new CloudLayer(viewer.scene, { e: Math.sin(az) * Math.cos(el), n: Math.cos(az) * Math.cos(el), u: Math.sin(el) });
    }
  }

  /** The flight model's thermals (near the glider). */
  update(list: ThermalView[]): void {
    this.near = list;
    this.refresh();
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

  /** How many thermals mark clouds now (near: the flight model's; far: visual only). For checks. */
  get cloudCount(): { near: number; far: number } {
    return { near: this.cumulus ? this.near.length : 0, far: this.cumulus ? this.far.length : 0 };
  }

  /** Thermals beyond the flight model's reach: clouds only. */
  setFar(list: ThermalView[]): void {
    this.far = list;
    this.refresh();
  }

  private refresh(): void {
    const ids = new Set(this.near.map((t) => t.id));
    const all = this.cumulus ? [...this.near, ...this.far.filter((t) => !ids.has(t.id))] : [];
    const specs: CloudSpec[] = all.flatMap(cloudsOver);
    const cam = this.viewer.camera.positionWC, p = new Cartesian3();
    const near: CloudSpec[] = [], far: CloudSpec[] = [];
    for (const c of specs) {
      const d = Cartesian3.distance(Cartesian3.fromDegrees(c.lonDeg, c.latDeg, c.baseM, undefined, p), cam);
      if (d <= VOLUME_M) near.push(c);
      // Out there a cloud is a few pixels in the haze: a fifth of the puffs.
      else if (this.volumes || d <= SPRITE_FADE_M + c.radiusM * 2) far.push({ ...c, lod: 0.2 });
    }
    if (this.volumes) {
      this.volumes.set(near);
      // Beyond, the volumes' far map: sprites under the atmosphere's sky are painted over by it.
      this.volumes.setFar(far);
    } else {
      // Sprites only as far as they show (they fade out by 70 km): the whole far field (to 160 km)
      // was ~575k puffs beyond it on a flat summer test.
      this.sprites?.set([...near, ...far]);
    }
    this.shadows?.(specs);
  }
}

export const offsetNorthDeg = (m: number) => m / M_PER_DEG_LAT;
export { Cartesian3 };
