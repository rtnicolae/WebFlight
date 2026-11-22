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
 *  - Colour. Google's photos here run grey-green on grass and blue-magenta to mauve on bare
 *    fields: vegetation is made a little yellower and richer, the cast taken out and washed-out
 *    pinks turned brown (?g3dgrade=0..1).
 *  - Close up. From a cockpit on the runway the tiles are a smear: the same grass, soil and
 *    gravel grain as on our photo ground (ground-detail.ts) is multiplied onto their level
 *    surfaces near the camera (not walls; level found from the screen-space slope of the
 *    surface), keeping the photo's colour; within ~120 m only (their photos have the rest).
 *  - Cloud shadows. The cumulus (scene.ts ThermalLayer) are projected along the sun onto a
 *    soft map round the camera (1024 px over 50 km, redrawn every 2 s or 3 km), which darkens
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
import { Cartesian2, Cartesian3, Cartesian4, Cartographic, createGooglePhotorealistic3DTileset, CustomShader, RequestScheduler, DynamicAtmosphereLightingType, Ellipsoid, Math as CesiumMath, Matrix4, ShadowMode, TextureMagnificationFilter, TextureMinificationFilter, TextureUniform, UniformType, type Cesium3DTileset, type Viewer } from "cesium";
import type { CloudSpec } from "./clouds.ts";
import * as CesiumAll from "cesium";
import { cloudGeometry } from "./vclouds.ts";
import { cloudNoiseAsync } from "./cloud-noise.ts";
import { DETAIL_GLSL, detailSettings, detailTexturePixels, followCameraOnGround } from "./ground-detail.ts";
import { LOOK } from "./lighting.ts";
import { RUNWAY_GLSL, runwayUniforms } from "./runway-paint.ts";
import { CLOUD_SHADE, cloudShadeRamp, placeScaleByte, SUN_THROUGH_GLSL } from "./sun-through.ts";
import type { DeckShade } from "./vclouds.ts";

type GroundFn = (latDeg: number, lonDeg: number) => number | undefined;

/** The cloud shadow map: pixels, and metres across (centred on the camera when drawn). */
const SHADOW_PX = 1024;
const SHADOW_M = 50_000;

/** The light the photos are dimmed and tinted with (1 at midday). */
function photoLight(viewer: Viewer): Cartesian3 {
  const c = viewer.scene.light.color;
  // Normalised by the midday sun's colour (lighting.ts), so midday leaves the photos as they are.
  const sun = [c.red / 1, c.green / 0.97, c.blue / 0.93];
  const t = LOOK.ambient.map((a, i) => LOOK.ground * Math.min(1, 0.5 * a + 0.5 * sun[i]!));
  return new Cartesian3(t[0], t[1], t[2]);
}

/**
 * Cesium picks 3D tiles on the CPU from their triangles, and in WebGL2 reads them back from
 * the GPU for every pick (ModelReader → buffer.getBufferData, no cache): a pipeline stall,
 * ~6 ms a pick inside a frame against 0.5 ms between frames. The wheels' and the grass's
 * height picks on the tiles round the glider doubled frames on the ground several times a
 * second. Each tile's positions and indices are now read once and kept while it is loaded
 * (a WeakMap on Cesium's attribute objects; tile geometry never changes). Internal API, so
 * guarded: without it picks work as before.
 */
/**
 * Google's tiles leave their textures' sampler unset, and Cesium's glTF default for that is
 * plain LINEAR: no mipmaps, no anisotropic filtering. Wherever a tile's 256 px photo is
 * minified (every slanting view from a glider: fields, forest, roofs towards the horizon) it
 * was point-sampled: moiré in crop rows, sand in tree crowns, shimmer as the camera moves.
 * Every glTF texture without a mipmapped filter now gets trilinear mipmaps (generated as the
 * tile loads) and 8× anisotropic filtering. Compressed textures without mipmaps are left as
 * they are (WebGL can't generate theirs). Internal API, so guarded.
 */
let texturesFiltered = false;
function filterTextures(anisotropy: number): void {
  if (texturesFiltered) return;
  texturesFiltered = true;
  type Sampler = { wrapS: number; wrapT: number; minificationFilter: number; magnificationFilter: number; maximumAnisotropy: number };
  const C = CesiumAll as unknown as { GltfLoaderUtil?: { createSampler?: (o: { compressedTextureNoMipmap?: boolean }) => Sampler }; Sampler?: new (o: Partial<Sampler>) => Sampler };
  const U = C.GltfLoaderUtil, orig = U?.createSampler, Sampler = C.Sampler;
  if (!U || typeof orig !== "function" || !Sampler) return;
  U.createSampler = (o) => {
    const s = orig.call(U, o);
    if (o.compressedTextureNoMipmap) return s;
    const min = s.minificationFilter;
    const mip = min === TextureMinificationFilter.LINEAR ? TextureMinificationFilter.LINEAR_MIPMAP_LINEAR : min === TextureMinificationFilter.NEAREST ? TextureMinificationFilter.NEAREST_MIPMAP_LINEAR : min;
    return new Sampler({ wrapS: s.wrapS, wrapT: s.wrapT, minificationFilter: mip, magnificationFilter: s.magnificationFilter, maximumAnisotropy: Math.max(s.maximumAnisotropy, anisotropy) });
  };
}

/** The fog's light on the tiles in HDR, relative to LDR (see relight). */
const HDR_FOG = 0.45;
let readbackCached = false;
function cachePickReadback(): void {
  if (readbackCached) return;
  readbackCached = true;
  const R = (CesiumAll as unknown as { ModelReader?: Record<string, ((o: object) => unknown) | undefined> }).ModelReader;
  if (!R) return;
  for (const k of ["readAttributeAsTypedArray", "readIndicesAsTypedArray"]) {
    const orig = R[k];
    if (typeof orig !== "function") continue;
    const cache = new WeakMap<object, unknown>();
    R[k] = (o: object) => {
      let v = cache.get(o);
      if (v === undefined) cache.set(o, (v = orig.call(R, o)));
      return v;
    };
  }
}

export class Google3D {
  /** Lowered by this much [m] now (tiles above our terrain). */
  offsetM = 0;
  /** What the offset is blending towards. */
  private targetM: number | undefined;
  private wideAt: [number, number] | undefined;
  private wideM: number | undefined;
  private measuring = false;
  private lastNear = -1e9;
  /**
   * The measurement under the glider, one tile pick a frame (a pick costs ~0.4 ms; the 5–11 of
   * a measurement in one frame, every 250 ms, doubled every fourth frame on the ground:
   * 59 → 76 fps, 95th-percentile frame 34 → 15 ms without them).
   */
  private near: { ring: boolean; k: number; vals: number[] } | undefined;
  private nearLast: { lat: number; lon: number; m: number } | undefined;
  private nearIdleUntil = 0;
  private lastFrame = performance.now();

  private constructor(
    private readonly viewer: Viewer,
    readonly tileset: Cesium3DTileset,
    private readonly groundAt: GroundFn,
  ) {}

  static async create(viewer: Viewer, groundAt: GroundFn, opts: { screenSpaceError?: number; texBase?: string; grade?: number; maxRequests?: number; anisotropy?: number } = {}): Promise<Google3D> {
    // Before the first tile loads. ?g3daniso=0: Cesium's own filtering.
    if ((opts.anisotropy ?? 8) > 0) filterTextures(opts.anisotropy ?? 8);
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
    // The grain on Google's tiles: only near the camera. Their photos already carry the clumps
    // and field mottling the globe's aerial photo lacked; the ×4 and ×16 layers (to 400 m and
    // 1.5 km, contrast ×2 and ×2.5) only added a streaky repeating pattern over fields seen
    // from 60–300 m. The true-scale grain stays (the runway under the wheels), the ×4 one
    // faint and short, the ×16 one off. (?gd= still overrides, for tuning.)
    const st = detailSettings();
    if (!new URLSearchParams(location.search).has("gd")) Object.assign(st, { fine: [10, 60], mid: [30, 120], macro: [100, 130], strength: [0.6, 0.2, 0], gain: [1, 1.2, 1] });
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
        // The clouds' shade (sun-through.ts): the cumulus' shadow map (setCloudShadows), the
        // decks (vclouds.ts, setDeckShade).
        wfcShadow: { type: UniformType.SAMPLER_2D, value: new TextureUniform({ typedArray: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, repeat: false }) },
        wfcShadowP: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcDeckMap: { type: UniformType.SAMPLER_2D, value: white() },
        wfcDeck0: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcDeck1: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcDeckP0: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcDeckP1: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcDeckH: { type: UniformType.VEC4, value: new Cartesian4() },
        wfcPlace: { type: UniformType.SAMPLER_2D, value: new TextureUniform({ typedArray: new Uint8Array([255, 255, placeScaleByte(1), 255]), width: 1, height: 1, repeat: false }) },
        wfcPlaceP: { type: UniformType.VEC4, value: new Cartesian4(0.5, 0.5, 0, 0) },
        // Runways painted on the tiles (runway-paint.ts).
        ...runwayUniforms(),
      },
      fragmentShaderText: `${DETAIL_GLSL}
${RUNWAY_GLSL}
// Google's photos run grey-green on grass and blue-magenta to mauve on bare fields round here:
// greens a little yellower and richer, the blue cast taken out, washed-out pinks (bare soil,
// not red roofs: those are saturated) turned towards a warm brown (display values in and out).
// At +55% saturation on vegetation (before) the forests read as moss and the town parks neon.
vec3 wfGrade(vec3 s) {
  vec3 hsb = czm_RGBToHSB(s);
  float h = hsb.x * 360.0;
  // (Up to ~150°: teal lake water, 160–190°, was boosted into neon green with them.)
  float veg = smoothstep(50.0, 70.0, h) * (1.0 - smoothstep(140.0, 158.0, h));
  float tint = smoothstep(220.0, 250.0, h) * (1.0 - smoothstep(290.0, 310.0, h));
  float mauve = max(smoothstep(285.0, 315.0, h), 1.0 - smoothstep(10.0, 24.0, h)) * (1.0 - smoothstep(0.3, 0.45, hsb.y));
  // Greens towards a natural yellow-green (95°): saturating the photos' blue-greens alone
  // turned the grass teal.
  h += (95.0 - h) * 0.35 * veg * u_grade;
  // Pinks towards 28° (brown), through 0° (h above 180 counts as negative).
  float hp = h > 180.0 ? h - 360.0 : h;
  h = mix(h, hp + (28.0 - hp) * 0.6, mauve * u_grade);
  hsb.x = fract(h / 360.0 + 1.0);
  hsb.y = clamp(hsb.y * (1.0 + u_grade * (0.2 * veg - 0.6 * tint + 0.15 * mauve)), 0.0, 1.0);
  hsb.z *= 1.0 + u_grade * 0.04 * veg;
  // Saturated teal is the photos' water (on land only pools): towards our water's deep blue-teal
  // (water.ts), so where Google's water shows past ours (a rim the satellite map misses) the two
  // meet without a bright teal band.
  float water = smoothstep(150.0, 165.0, h) * (1.0 - smoothstep(200.0, 215.0, h)) * smoothstep(0.18, 0.32, hsb.y);
  hsb.x = mix(hsb.x, 198.0 / 360.0, water * u_grade);
  hsb.y *= 1.0 - 0.35 * water * u_grade;
  hsb.z *= 1.0 - 0.45 * water * u_grade;
  return czm_HSBToRGB(hsb);
}
// Under the clouds (sun-through.ts): their shade, as on our buildings and water.
${SUN_THROUGH_GLSL}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 c = material.diffuse;
  if (u_grade > 0.0) c = czm_srgbToLinear(wfGrade(czm_linearToSrgb(c)));
  vec3 rel = fsInput.attributes.positionEC;
  float d = length(rel);
  // How level the surface is (1 flat ground, 0 walls), from its screen-space derivatives.
  vec3 upW = normalize(czm_viewerPositionWC);
  vec3 faceEC = normalize(cross(dFdx(rel), dFdy(rel)));
  float level = smoothstep(0.8, 0.93, abs(dot(faceEC, czm_viewRotation * upW)));
  // Runways (runway-paint.ts); paved ones bring their own grain.
  float painted;
  c = wfRunwayPaint(c, czm_inverseViewRotation * rel, level, painted);
  if (u_grain > 0.5 && d < wfMacro.y && level > 0.0 && painted < 0.5) {
    vec3 relWC = czm_inverseViewRotation * rel;
    vec3 east = normalize(vec3(-upW.y, upW.x, 0.0));
    vec3 north = cross(upW, east);
    vec2 w = wfCam + vec2(dot(relWC, east), dot(relWC, north));
    // The grain works on display values; the material is linear.
    c *= pow(mix(1.0, wfFactor(czm_linearToSrgb(c), w, d), level), 2.2);
  }
  // Under a cumulus or a deck (where both, the darker): the photo's light, of which the sun's
  // is ${CLOUD_SHADE}, by the share of the sun's that gets through.
  if (wfcShadowP.w > 0.5 || wfcDeckH.y > 0.5) c *= 1.0 - ${CLOUD_SHADE.toFixed(2)} * (1.0 - wfSunThrough(czm_inverseViewRotation * rel));
  material.diffuse = c * u_photoLight;
}`,
    });
    tileset.customShader = shader;
    let g3: Google3D | undefined;
    followCameraOnGround(viewer.scene, (e, n) => {
      shader.setUniform("wfCam", new Cartesian2(e, n));
      g3?.followShadow();
      g3?.followDecks();
    });
    // The decks' holes: the clouds' noise (cloud-noise.ts), shared with vclouds.ts.
    void cloudNoiseAsync().then((noise) => {
      shader.setUniform("wfcDeckMap", new TextureUniform({ typedArray: noise.deck, width: noise.deckSize, height: noise.deckSize, repeat: true, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR }));
      g3?.deckNoise(noise.deck, noise.deckSize);
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
    cachePickReadback();
    g3 = new Google3D(viewer, tileset, groundAt);
    g3.relight();
    return g3;
  }

  /** After applyLighting (each flight: the time of day may differ): light and haze on the tiles. */
  relight(): void {
    const scene = this.viewer.scene, g = scene.globe, a = scene.atmosphere;
    (this.tileset.customShader as CustomShader | undefined)?.setUniform("u_photoLight", photoLight(this.viewer));
    // In HDR the fog colour is blended in before the tonemap (in LDR after it): much brighter,
    // so scaled down to match (hdr.ts). ?hdrfog= for tuning.
    const hdrFog = Number(new URLSearchParams(location.search).get("hdrfog") ?? HDR_FOG);
    a.lightIntensity = g.atmosphereLightIntensity * (scene.highDynamicRange ? hdrFog : 1);
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
  private readonly shadowBuf = new Uint8Array(SHADOW_PX * SHADOW_PX * 4);

  /**
   * The clouds' shadows on the ground (each cloud a soft disc, moved away from the sun by its
   * height over the ground ÷ tan(sun elevation)). At most every 2 s, or after 3 km.
   */
  setCloudShadows(clouds: CloudSpec[], sun: { azimuthDeg: number; elevationDeg: number }): void {
    const shader = this.tileset.customShader as CustomShader | undefined;
    if (!shader) return;
    // The share of the sun's light the clouds take by its height (under a cumulus the sunlit
    // ground then gets about a third of the light, the sky's: CLOUD_SHADE); the decks' too.
    this.ramp = cloudShadeRamp(sun.elevationDeg);
    if (!clouds.length || this.ramp <= 0) {
      this.shade.shadowP.w = 0;
      shader.setUniform("wfcShadowP", Cartesian4.clone(this.shade.shadowP));
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
    // Drawn straight into the texture's bytes, soft discs as max (overlapping shadows: the
    // darker, not the sum). A canvas cost 30–40 ms a redraw (reading a GPU canvas back), or
    // 0.5 s drawing on a CPU-backed one; this ~3 ms.
    const buf = this.shadowBuf;
    buf.fill(0);
    const px = SHADOW_PX / SHADOW_M, d = new Cartesian3();
    const disc = (x: number, y: number, r: number, v: number) => {
      const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(SHADOW_PX - 1, Math.ceil(x + r));
      const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(SHADOW_PX - 1, Math.ceil(y + r));
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const q = Math.hypot(i + 0.5 - x, j + 0.5 - y) / r;
          if (q >= 1) continue;
          const a = q < 0.55 ? v : v * (1 - (q - 0.55) / 0.45);
          const k = 4 * (j * SHADOW_PX + i);
          if (a > buf[k]!) buf[k] = a;
        }
    };
    for (const c of clouds) {
      if (c.size <= 0 || c.opacity <= 0) continue;
      Cartesian3.subtract(Cartesian3.fromDegrees(c.lonDeg, c.latDeg, c.baseM, undefined, d), cam, d);
      // The cloud's own towers (vclouds.ts), each cast away from the sun from its own height:
      // a lumpy footprint, not a disc.
      const e0 = Cartesian3.dot(d, east), n0 = Cartesian3.dot(d, north);
      if (Math.abs(e0) > SHADOW_M * 0.7 || Math.abs(n0) > SHADOW_M * 0.7) continue;
      const geo = cloudGeometry(c);
      const above = c.baseM - (c.groundM ?? c.baseM - 1500);
      const v = Math.round(255 * c.opacity);
      for (let k = 0; k < geo.towers.length / 4; k++) {
        const te = geo.towers[k * 4]!, tn = geo.towers[k * 4 + 1]!, tz = geo.towers[k * 4 + 2]!, tr = geo.towers[k * 4 + 3]!;
        const h = above + tz;
        const e = e0 + te - (Math.sin(az) * h) / tanEl, n = n0 + tn - (Math.cos(az) * h) / tanEl;
        const x = (0.5 + e / SHADOW_M) * SHADOW_PX, y = (0.5 + n / SHADOW_M) * SHADOW_PX, r = Math.max(1.5, tr * 1.05 * px);
        if (x < -r || y < -r || x > SHADOW_PX + r || y > SHADOW_PX + r) continue;
        disc(x, y, r, v);
      }
    }
    // Row y is (0.5 + north / size): texture rows bottom-up, as the shader reads them.
    shader.setUniform("wfcShadow", new TextureUniform({ typedArray: buf, width: SHADOW_PX, height: SHADOW_PX, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR }));
    this.shadowVersion++;
    this.shade.shadowP.z = SHADOW_M;
    this.shade.shadowP.w = 1;
    this.followShadow();
  }

  /**
   * The clouds' shade as the shaders take it (sun-through.ts SUN_THROUGH_DECLS: wfcShadowP,
   * wfcDeck0…, without the textures, shadeTextures): the tiles', and our buildings' and water's.
   */
  readonly shade = { shadowP: new Cartesian4(), deck0: new Cartesian4(), deck1: new Cartesian4(), deckP0: new Cartesian4(), deckP1: new Cartesian4(), deckH: new Cartesian4(), placeP: new Cartesian4(0.5, 0.5, 0, 0) };
  /** The decks by place as last taken (vclouds.ts u_place), at most once a second. */
  private place: { data: Uint8Array; cols: number; rows: number; version: number; at: number } | undefined;
  private ramp = 0;
  private shadowVersion = 0;
  private texVersion = -1;
  private deckData: { data: Uint8Array; size: number } | undefined;
  private textures: { shadow: { copyFrom(o: unknown): void; destroy(): void }; deck: { destroy(): void } | undefined; place?: { tex: { copyFrom(o: unknown): void }; cols: number; rows: number; version: number } } | undefined;

  /** The decks' field (cloud-noise.ts), for shadeTextures. */
  deckNoise(data: Uint8Array, size: number): void {
    this.deckData = { data, size };
  }

  /**
   * The shade's textures for shaders outside the tiles (Cesium's renderer textures; the tiles'
   * own are the custom shader's): the cumulus' shadow map (as last drawn) and the decks' field
   * (undefined until it is made). Shared: a Cesium Material destroys a texture it is given when
   * it gets another, so each is given once.
   */
  shadeTextures(): { shadow: unknown; deck: unknown | undefined; place: unknown | undefined } {
    const C = CesiumAll as unknown as Record<string, any>, context = (this.viewer.scene as unknown as { context: unknown }).context;
    const t: NonNullable<typeof this.textures> = (this.textures ??= {
      shadow: new C.Texture({ context, width: SHADOW_PX, height: SHADOW_PX, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, source: { arrayBufferView: this.shadowBuf }, flipY: false, sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }) }),
      deck: undefined,
    });
    if (this.texVersion !== this.shadowVersion) {
      t.shadow.copyFrom({ source: { width: SHADOW_PX, height: SHADOW_PX, arrayBufferView: this.shadowBuf } });
      this.texVersion = this.shadowVersion;
    }
    if (!t.deck && this.deckData) {
      const d = new C.Texture({ context, width: this.deckData.size, height: this.deckData.size, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, source: { arrayBufferView: this.deckData.data }, flipY: false, sampler: new C.Sampler({ wrapS: C.TextureWrap.REPEAT, wrapT: C.TextureWrap.REPEAT, minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }) });
      d.generateMipmap();
      t.deck = d;
    }
    // The decks by place: a new texture when the map's size changes (the old one left to whoever
    // holds it: a building material destroys it when given this one).
    const p = this.place;
    if (p && (!t.place || t.place.version !== p.version)) {
      if (!t.place || t.place.cols !== p.cols || t.place.rows !== p.rows)
        t.place = { tex: new C.Texture({ context, width: p.cols, height: p.rows, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, source: { arrayBufferView: p.data }, flipY: false, sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }) }), cols: p.cols, rows: p.rows, version: p.version };
      else {
        t.place.tex.copyFrom({ source: { width: p.cols, height: p.rows, arrayBufferView: p.data } });
        t.place.version = p.version;
      }
    }
    return { shadow: t.shadow, deck: t.deck, place: t.place?.tex };
  }

  private deckSource: (() => DeckShade | undefined) | undefined;
  /** Where the cloud decks are (vclouds.ts deckShade): their shade on the tiles. */
  setDeckShade(source: (() => DeckShade | undefined) | undefined): void {
    this.deckSource = source;
  }

  /** Each frame: the decks' shade on the tiles (and the ramp, the cumulus' too). */
  followDecks(): void {
    const shader = this.tileset.customShader as CustomShader | undefined, d = this.deckSource?.(), sh = this.shade;
    if (!shader) return;
    sh.deckH.z = this.ramp;
    if (!d || d.n === 0 || this.ramp <= 0) sh.deckH.y = 0;
    else {
      Cartesian4.clone(d.decks[0]!, sh.deck0);
      Cartesian4.clone(d.decks[1]!, sh.deck1);
      Cartesian4.clone(d.at[0]!, sh.deckP0);
      Cartesian4.clone(d.at[1]!, sh.deckP1);
      sh.deckH.x = d.camH;
      sh.deckH.y = d.n;
      // The decks by place: where the camera is on the map every frame; its values (changing
      // slowly) at most once a second.
      Cartesian4.clone(d.placeP, sh.placeP);
      shader.setUniform("wfcPlaceP", Cartesian4.clone(sh.placeP));
      const now = performance.now(), p = this.place;
      if (!p || (p.version !== d.placeVersion && now - p.at > 1000)) {
        this.place = { data: Uint8Array.from(d.place), cols: d.placeCols, rows: d.placeRows, version: d.placeVersion, at: now };
        shader.setUniform("wfcPlace", new TextureUniform({ typedArray: this.place.data, width: d.placeCols, height: d.placeRows, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR }));
      }
      shader.setUniform("wfcDeck0", Cartesian4.clone(sh.deck0));
      shader.setUniform("wfcDeck1", Cartesian4.clone(sh.deck1));
      shader.setUniform("wfcDeckP0", Cartesian4.clone(sh.deckP0));
      shader.setUniform("wfcDeckP1", Cartesian4.clone(sh.deckP1));
    }
    shader.setUniform("wfcDeckH", Cartesian4.clone(sh.deckH));
  }

  /** Each frame: where the shadow map's centre is, in metres east/north of the camera. */
  followShadow(): void {
    if (!this.shadowAt) return;
    const cam = this.viewer.camera.positionWC;
    const up = Cartesian3.normalize(cam, new Cartesian3());
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.cross(up, east, new Cartesian3());
    const d = Cartesian3.subtract(this.shadowAt, cam, new Cartesian3());
    this.shade.shadowP.x = Cartesian3.dot(d, east);
    this.shade.shadowP.y = Cartesian3.dot(d, north);
    (this.tileset.customShader as CustomShader).setUniform("wfcShadowP", Cartesian4.clone(this.shade.shadowP));
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
    if (aglM < 5) this.nearStep(latDeg, lonDeg, now);
    else this.near = undefined;
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
   * Median of Google minus ours under the glider (its spot and 4 points 1.5 m round it: the
   * wheels stand there; the median of a 12 m ring left the main wheel 11 cm in Google's bumpier
   * ground), else 6 points 12 m round it, from the tiles drawn now, each within 15 m of the wide
   * figure (a coarse tile can answer kilometres off; the geoid moves only a few metres over a
   * flight). One point a frame; parked with the same answer, a round a second.
   */
  private nearStep(latDeg: number, lonDeg: number, now: number): void {
    if (this.wideM === undefined || now < this.nearIdleUntil) return;
    const kx = 111_320 * Math.cos((latDeg * Math.PI) / 180), ky = 110_540;
    let n = this.near;
    if (!n) n = this.near = { ring: false, k: 0, vals: [] };
    const count = n.ring ? 6 : 5;
    const r = n.ring ? 12 : n.k === 0 ? 0 : 1.5, a = n.ring ? (n.k * Math.PI) / 3 : ((n.k - 1) * Math.PI) / 2;
    // Round the glider where it is now (it moves during a round on a take-off run).
    const lat = latDeg + (r * Math.sin(a)) / ky, lon = lonDeg + (r * Math.cos(a)) / kx;
    const h = this.tileset.getHeight(Cartographic.fromDegrees(lon, lat), this.viewer.scene), o = this.groundAt(lat, lon);
    if (h !== undefined && o !== undefined && Number.isFinite(h)) {
      const di = h + this.offsetM - o;
      if (Math.abs(di - this.wideM) < 15) n.vals.push(di);
    }
    if (++n.k < count) return;
    // A round done.
    this.near = undefined;
    const v = n.vals.sort((x, y) => x - y);
    if (v.length < 3) {
      if (!n.ring) this.near = { ring: true, k: 0, vals: [] };
      return;
    }
    const m = v[Math.floor(v.length / 2)]!;
    const last = this.nearLast;
    const parked = last && distanceM(last.lat, last.lon, latDeg, lonDeg) < 0.3 && Math.abs(last.m - m) < 0.01;
    this.nearLast = { lat: latDeg, lon: lonDeg, m };
    if (parked) this.nearIdleUntil = now + 1000;
    this.lastNear = now;
    this.aim(m);
  }

  /** The height offset has been measured (offsetM means something). */
  get offsetKnown(): boolean {
    return this.targetM !== undefined;
  }

  /** Whether the tiles in view are in and the height offset is set (a flight can start). */
  get settled(): boolean {
    return this.wideM !== undefined && this.targetM !== undefined && this.tileset.tilesLoaded && Math.abs(this.targetM - this.offsetM) < 0.02;
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
