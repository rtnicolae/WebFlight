/**
 * Google Photorealistic 3D Tiles (via Cesium ion, asset 2275207) as the world: real buildings,
 * trees and ground from Google's photogrammetry, in place of the globe, the aerial photo and
 * our OSM buildings and trees. The default; ?world=globe for the globe with Bing photos.
 *
 * What makes it sit in our scene:
 *  - Height. Our world uses Terrarium heights (above mean sea level) as heights above the
 *    ellipsoid (terrain.ts); Google's tiles are true ellipsoidal heights, 35–38 m higher round
 *    Brașov (the geoid). So the tiles are lowered by what they stand above our terrain:
 *    in the air, the 20th percentile over 25 points within ~1 km (roofs and treetops only
 *    ever add), again every 10 km; on the ground (below 5 m), the median of the tiles round
 *    the glider itself, every quarter second, so the wheels stand on Google's runway (the
 *    1 km figure left the glider buried a metre or two at Ghimbav). Changes are blended in
 *    at up to 2 m/s; the first one is applied at once.
 *  - Haze. Cesium hazes 3D tiles with scene.atmosphere, whose defaults give a dark navy that
 *    doesn't match the pale summer haze we give the ground (scene.ts sets it on the globe):
 *    the same settings go on scene.atmosphere.
 *  - Light. The photos carry midday light. Away from midday they are dimmed and tinted like
 *    our ground (LOOK.ground, the sky's light and the sun's colour): warm and dimmer in the
 *    evening, dark blue at night.
 *  - Colour. Google's photos here run grey-green on grass and blue-magenta on bare fields:
 *    vegetation is made a little more saturated and the cast is taken out (?g3dgrade=0..1).
 *  - Close up. From a cockpit on the runway the tiles are a smear: the same grass, soil and
 *    gravel grain as on our photo ground (ground-detail.ts) is multiplied onto their level
 *    surfaces near the camera (not walls; level found from the screen-space slope of the
 *    surface), keeping the photo's colour.
 *  - Cloud shadows. The cumulus (scene.ts ThermalLayer) are projected along the sun onto a
 *    soft map round the camera (512 px over 50 km, redrawn every 2 s or 3 km), which darkens
 *    the tiles under them.
 *  - Shadows. The photos already carry the sun's shadows: the tiles only receive ours (the
 *    glider's), they don't cast into the shadow map (Brașov at 300 m: 103 fps, casting too 81).
 *  - Detail. At Cesium's default (screen-space error 16) the forests near the glider are
 *    coarse meshes that look like melted spikes; at 8 they are tree crowns, but that alone
 *    halved the frame rate (99 → 51 fps at Brașov, 300 m). So 8, with the detail falling off
 *    faster with distance (dynamic screen-space error density 1e-3 instead of 2e-4): the same
 *    crowns near the glider at 67 fps (107 fps at 1,000 m over the basin). Quality low: 16.
 *    ?g3dsse= overrides.
 *
 * Google's terms (via Cesium's Terms for Google): display only, attributions shown unchanged,
 * no caching beyond what Google allows, nothing derived from the content.
 */
import { Cartesian2, Cartesian3, Cartographic, createGooglePhotorealistic3DTileset, CustomShader, RequestScheduler, DynamicAtmosphereLightingType, Ellipsoid, Math as CesiumMath, Matrix4, ShadowMode, TextureMagnificationFilter, TextureMinificationFilter, TextureUniform, UniformType, type Cesium3DTileset, type Viewer } from "cesium";
import type { CloudSpec } from "./clouds.ts";
import { DETAIL_GLSL, detailSettings, detailTexturePixels, followCameraOnGround } from "./ground-detail.ts";
import { LOOK } from "./lighting.ts";

type GroundFn = (latDeg: number, lonDeg: number) => number | undefined;

/** The cloud shadow map: pixels, and metres across (centred on the camera when drawn). */
const SHADOW_PX = 512;
const SHADOW_M = 50_000;

/** The light the photos are dimmed and tinted with (1 at midday). */
function photoLight(viewer: Viewer): Cartesian3 {
  const c = viewer.scene.light.color;
  // Normalised by the midday sun's colour (lighting.ts), so midday leaves the photos as they are.
  const sun = [c.red / 1, c.green / 0.97, c.blue / 0.93];
  const t = LOOK.ambient.map((a, i) => LOOK.ground * Math.min(1, 0.5 * a + 0.5 * sun[i]!));
  return new Cartesian3(t[0], t[1], t[2]);
}

export class Google3D {
  /** Lowered by this much [m] now (tiles above our terrain). */
  offsetM = 0;
  /** What the offset is blending towards. */
  private targetM: number | undefined;
  private wideAt: [number, number] | undefined;
  private wideM: number | undefined;
  private measuring = false;
  private nearT = 0;
  private lastNear = -1e9;
  private lastFrame = performance.now();

  private constructor(
    private readonly viewer: Viewer,
    readonly tileset: Cesium3DTileset,
    private readonly groundAt: GroundFn,
  ) {}

  static async create(viewer: Viewer, groundAt: GroundFn, opts: { screenSpaceError?: number; texBase?: string; grade?: number; maxRequests?: number } = {}): Promise<Google3D> {
    // Tiles downloading at once from Google (Cesium's default 18 per server).
    // 6, not 18: fewer tiles arriving in one frame (3 min at 180 km/h: frames over 33 ms 133 → 103,
    // the slowest 5% 27 → 24 ms, same detail at the end).
    RequestScheduler.requestsByServer["tile.googleapis.com:443"] = opts.maxRequests ?? 6;
    const tileset = await createGooglePhotorealistic3DTileset(undefined, {
      shadows: ShadowMode.RECEIVE_ONLY,
      maximumScreenSpaceError: opts.screenSpaceError ?? 8,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 1e-3,
    });
    const st = detailSettings();
    const white = () => new TextureUniform({ typedArray: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 });
    const shader = new CustomShader({
      uniforms: {
        u_photoLight: { type: UniformType.VEC3, value: photoLight(viewer) },
        u_grade: { type: UniformType.FLOAT, value: opts.grade ?? 1 },
        u_grain: { type: UniformType.FLOAT, value: opts.texBase ? 1 : 0 },
        wfTex: { type: UniformType.SAMPLER_2D, value: white() },
        wfCam: { type: UniformType.VEC2, value: new Cartesian2() },
        wfFine: { type: UniformType.VEC2, value: new Cartesian2(...st.fine) },
        wfMid: { type: UniformType.VEC2, value: new Cartesian2(...st.mid) },
        wfMacro: { type: UniformType.VEC2, value: new Cartesian2(...st.macro) },
        wfStrength: { type: UniformType.VEC3, value: new Cartesian3(...st.strength) },
        wfGain: { type: UniformType.VEC3, value: new Cartesian3(...st.gain) },
        u_cloudShadow: { type: UniformType.SAMPLER_2D, value: new TextureUniform({ typedArray: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, repeat: false }) },
        u_shadowCentre: { type: UniformType.VEC2, value: new Cartesian2() },
        u_shadowSize: { type: UniformType.FLOAT, value: SHADOW_M },
        u_shadowK: { type: UniformType.FLOAT, value: 0 },
      },
      fragmentShaderText: `${DETAIL_GLSL}
// Google's photos run grey-green on grass and blue-magenta on bare fields round here: green
// vegetation a little more saturated and yellower, the cast taken out (display values in and
// out).
vec3 wfGrade(vec3 s) {
  vec3 hsb = czm_RGBToHSB(s);
  float h = hsb.x * 360.0;
  float veg = smoothstep(50.0, 70.0, h) * (1.0 - smoothstep(170.0, 190.0, h));
  float tint = smoothstep(220.0, 250.0, h) * (1.0 - smoothstep(330.0, 350.0, h));
  // Greens towards a natural yellow-green (95°): saturating the photos' blue-greens alone
  // turned the grass teal.
  hsb.x = (h + (95.0 - h) * 0.45 * veg * u_grade) / 360.0;
  hsb.y = clamp(hsb.y * (1.0 + u_grade * (0.55 * veg - 0.6 * tint)), 0.0, 1.0);
  hsb.z *= 1.0 + u_grade * 0.05 * veg;
  return czm_HSBToRGB(hsb);
}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 c = material.diffuse;
  if (u_grade > 0.0) c = czm_srgbToLinear(wfGrade(czm_linearToSrgb(c)));
  vec3 rel = fsInput.attributes.positionEC;
  float d = length(rel);
  // How level the surface is (1 flat ground, 0 walls), from its screen-space derivatives.
  vec3 upW = normalize(czm_viewerPositionWC);
  vec3 faceEC = normalize(cross(dFdx(rel), dFdy(rel)));
  float level = smoothstep(0.8, 0.93, abs(dot(faceEC, czm_viewRotation * upW)));
  if (u_grain > 0.5 && d < wfMacro.y && level > 0.0) {
    vec3 relWC = czm_inverseViewRotation * rel;
    vec3 east = normalize(vec3(-upW.y, upW.x, 0.0));
    vec3 north = cross(upW, east);
    vec2 w = wfCam + vec2(dot(relWC, east), dot(relWC, north));
    // The grain works on display values; the material is linear.
    c *= pow(mix(1.0, wfFactor(czm_linearToSrgb(c), w, d), level), 2.2);
  }
  // Under a cloud: the cloud shadow map, in metres east/north of the camera.
  if (u_shadowK > 0.0) {
    vec3 relW = czm_inverseViewRotation * rel;
    vec3 e = normalize(vec3(-upW.y, upW.x, 0.0));
    vec3 nn = cross(upW, e);
    vec2 uv = (vec2(dot(relW, e), dot(relW, nn)) - u_shadowCentre) / u_shadowSize + 0.5;
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) c *= 1.0 - u_shadowK * texture(u_cloudShadow, uv).r;
  }
  material.diffuse = c * u_photoLight;
}`,
    });
    tileset.customShader = shader;
    let g3: Google3D | undefined;
    followCameraOnGround(viewer.scene, (e, n) => {
      shader.setUniform("wfCam", new Cartesian2(e, n));
      g3?.followShadow();
    });
    if (opts.texBase)
      void detailTexturePixels(opts.texBase)
        .then(({ data, size }) =>
          shader.setUniform(
            "wfTex",
            new TextureUniform({ typedArray: data, width: size, height: size, repeat: true, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8 }),
          ),
        )
        .catch((e: unknown) => console.warn("google3d: ground grain textures not loaded", e));
    const scene = viewer.scene;
    scene.primitives.add(tileset);
    scene.globe.show = false;
    g3 = new Google3D(viewer, tileset, groundAt);
    g3.relight();
    return g3;
  }

  /** After applyLighting (each flight: the time of day may differ): light and haze on the tiles. */
  relight(): void {
    const scene = this.viewer.scene, g = scene.globe, a = scene.atmosphere;
    (this.tileset.customShader as CustomShader | undefined)?.setUniform("u_photoLight", photoLight(this.viewer));
    a.lightIntensity = g.atmosphereLightIntensity;
    a.hueShift = g.atmosphereHueShift;
    // After sunset our ground's haze turns to a dark blue-grey (lighting.ts twilightHaze);
    // Cesium's would glow orange on the far ridges: greyed and darkened as far.
    const k = LOOK.haze.k;
    a.saturationShift = g.atmosphereSaturationShift + (-0.9 - g.atmosphereSaturationShift) * k;
    a.brightnessShift = g.atmosphereBrightnessShift + (-0.6 - g.atmosphereBrightnessShift) * k;
    // …and darkened with the light like the globe's (else the haze glows grey at night).
    a.dynamicLighting = !g.dynamicAtmosphereLighting ? DynamicAtmosphereLightingType.NONE : g.dynamicAtmosphereLightingFromSun ? DynamicAtmosphereLightingType.SUNLIGHT : DynamicAtmosphereLightingType.SCENE_LIGHT;
  }

  private shadowAt: Cartesian3 | undefined;
  private shadowT = -1e9;
  private readonly shadowCanvas = new OffscreenCanvas(SHADOW_PX, SHADOW_PX);

  /**
   * The clouds' shadows on the ground (each cloud a soft disc, moved away from the sun by its
   * height over the ground ÷ tan(sun elevation)). At most every 2 s, or after 3 km.
   */
  setCloudShadows(clouds: CloudSpec[], sun: { azimuthDeg: number; elevationDeg: number }): void {
    const shader = this.tileset.customShader as CustomShader | undefined;
    if (!shader) return;
    // Under a cumulus the sunlit ground gets about a third of the light (the sky's): 0.65.
    const k = 0.65 * Math.min(1, Math.max(0, (sun.elevationDeg - 2) / 10));
    if (!clouds.length || k <= 0) {
      shader.setUniform("u_shadowK", 0);
      this.shadowAt = undefined;
      return;
    }
    const now = performance.now(), cam = this.viewer.camera.positionWC;
    if (now - this.shadowT < 2000 && this.shadowAt && Cartesian3.distance(cam, this.shadowAt) < 3000) return;
    this.shadowT = now;
    this.shadowAt = Cartesian3.clone(cam, this.shadowAt);
    const up = Cartesian3.normalize(cam, new Cartesian3());
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.cross(up, east, new Cartesian3());
    const az = (sun.azimuthDeg * Math.PI) / 180, tanEl = Math.tan((Math.max(5, sun.elevationDeg) * Math.PI) / 180);
    const g = this.shadowCanvas.getContext("2d")!;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, SHADOW_PX, SHADOW_PX);
    g.globalCompositeOperation = "lighten"; // overlapping shadows: the darker, not the sum
    const px = SHADOW_PX / SHADOW_M, d = new Cartesian3();
    for (const c of clouds) {
      if (c.size <= 0 || c.opacity <= 0) continue;
      Cartesian3.subtract(Cartesian3.fromDegrees(c.lonDeg, c.latDeg, c.baseM, undefined, d), cam, d);
      const R = c.radiusM * 1.4 * c.size;
      // The cloud's middle over the ground, cast away from the sun.
      const h = c.baseM - (c.groundM ?? c.baseM - 1500) + Math.min(1000, R * 0.45 * (c.tall ?? 1));
      const e = Cartesian3.dot(d, east) - (Math.sin(az) * h) / tanEl, n = Cartesian3.dot(d, north) - (Math.cos(az) * h) / tanEl;
      // The footprint of the volume (vclouds.ts: towers out to ~1.2 R), soft at the rim.
      const x = (0.5 + e / SHADOW_M) * SHADOW_PX, y = (0.5 + n / SHADOW_M) * SHADOW_PX, r = Math.max(2, R * 1.2 * px);
      if (x < -r || y < -r || x > SHADOW_PX + r || y > SHADOW_PX + r) continue;
      const v = Math.round(255 * c.opacity);
      const grad = g.createRadialGradient(x, y, r * 0.75, x, y, r);
      grad.addColorStop(0, `rgb(${v},${v},${v})`);
      grad.addColorStop(1, "rgb(0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // Canvas rows top-down = texture rows bottom-up: row y is (0.5 + north / size) as drawn.
    const img = g.getImageData(0, 0, SHADOW_PX, SHADOW_PX);
    shader.setUniform("u_cloudShadow", new TextureUniform({ typedArray: new Uint8Array(img.data.buffer), width: SHADOW_PX, height: SHADOW_PX, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR }));
    shader.setUniform("u_shadowK", k);
    this.followShadow();
  }

  /** Each frame: where the shadow map's centre is, in metres east/north of the camera. */
  followShadow(): void {
    if (!this.shadowAt) return;
    const cam = this.viewer.camera.positionWC;
    const up = Cartesian3.normalize(cam, new Cartesian3());
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.cross(up, east, new Cartesian3());
    const d = Cartesian3.subtract(this.shadowAt, cam, new Cartesian3());
    (this.tileset.customShader as CustomShader).setUniform("u_shadowCentre", new Cartesian2(Cartesian3.dot(d, east), Cartesian3.dot(d, north)));
  }

  /** Every frame, with the glider's position and height above our terrain. */
  update(latDeg: number, lonDeg: number, aglM: number): void {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    // In the air: the wide measurement at the start and every 10 km.
    const w = this.wideAt;
    if (!this.measuring && (!w || distanceM(w[0], w[1], latDeg, lonDeg) > 10_000)) {
      this.measuring = true;
      void this.measureWide(latDeg, lonDeg).finally(() => (this.measuring = false));
    }
    // On the ground: the tiles round the glider.
    if (aglM < 5 && now - this.nearT > 250) {
      this.nearT = now;
      this.measureNear(latDeg, lonDeg);
    }
    // Blend towards the target.
    if (this.targetM === undefined) return;
    const d = this.targetM - this.offsetM;
    if (Math.abs(d) < 0.005) return;
    // On the ground, quickly (the glider stands on it); in the air, gently.
    this.setOffset(this.offsetM + Math.sign(d) * Math.min(Math.abs(d), (aglM < 5 ? 6 : 2) * dt));
  }

  private setOffset(m: number): void {
    this.offsetM = m;
    const c = Cartographic.fromCartesian(this.viewer.camera.positionWC);
    const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(new Cartographic(c.longitude, c.latitude, 0));
    this.tileset.modelMatrix = Matrix4.fromTranslation(Cartesian3.multiplyByScalar(up, -m, new Cartesian3()));
  }

  /** A new target; the first is applied at once. */
  private aim(m: number): void {
    const first = this.targetM === undefined;
    this.targetM = m;
    if (first) this.setOffset(m);
  }

  /**
   * Median of Google minus ours at the glider and 6 points 12 m round it, from the tiles drawn
   * now, each within 15 m of the wide figure (a coarse tile can answer kilometres off; the
   * geoid moves only a few metres over a flight). It used to wait for every tile in view to
   * load: ~20 s at a ground start, with the glider 2.5 m under the ground meanwhile.
   */
  private measureNear(latDeg: number, lonDeg: number): void {
    if (this.wideM === undefined) return;
    const kx = 111_320 * Math.cos((latDeg * Math.PI) / 180), ky = 110_540;
    const d: number[] = [];
    for (let i = -1; i < 6; i++) {
      const a = (i * Math.PI) / 3, r = i < 0 ? 0 : 12;
      const lat = latDeg + (r * Math.sin(a)) / ky, lon = lonDeg + (r * Math.cos(a)) / kx;
      const h = this.tileset.getHeight(Cartographic.fromDegrees(lon, lat), this.viewer.scene), o = this.groundAt(lat, lon);
      if (h === undefined || o === undefined || !Number.isFinite(h)) continue;
      const di = h + this.offsetM - o;
      if (Math.abs(di - this.wideM) < 15) d.push(di);
    }
    if (d.length < 4) return;
    d.sort((x, y) => x - y);
    this.lastNear = performance.now();
    this.aim(d[Math.floor(d.length / 2)]!);
  }

  /** The 20th percentile of Google minus ours at 25 points within ~1 km. */
  private async measureWide(latDeg: number, lonDeg: number): Promise<void> {
    const pts: Cartographic[] = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) pts.push(Cartographic.fromDegrees(lonDeg + (j * 450) / (111_320 * Math.cos((latDeg * Math.PI) / 180)), latDeg + (i * 450) / 110_540));
    const ours = pts.map((p) => this.groundAt(CesiumMath.toDegrees(p.latitude), CesiumMath.toDegrees(p.longitude)));
    let sampled: (Cartographic | undefined)[];
    try {
      sampled = await this.viewer.scene.sampleHeightMostDetailed(pts.map((p) => Cartographic.clone(p)), [], 0.5);
    } catch (e) {
      console.warn("google3d: could not sample heights", e);
      return;
    }
    // Sampled where the tiles are drawn now (lowered by the current offset): added back.
    const was = this.offsetM;
    const d: number[] = [];
    sampled.forEach((s, i) => {
      const o = ours[i];
      if (s?.height !== undefined && Number.isFinite(s.height) && o !== undefined) d.push(s.height + was - o);
    });
    if (d.length < 8) return;
    d.sort((x, y) => x - y);
    const off = d[Math.floor(d.length * 0.2)]!;
    this.wideAt = [latDeg, lonDeg];
    this.wideM = off;
    console.info(`google3d: tiles ${off.toFixed(1)} m above our terrain here (spread ${d[0]!.toFixed(1)}…${d[d.length - 1]!.toFixed(1)} m, ${d.length} points)`);
    // On the ground the glider's own spot decides.
    if (performance.now() - this.lastNear > 5000) this.aim(off);
  }
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180, x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k), y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6_371_000;
}
