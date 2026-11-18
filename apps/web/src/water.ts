/**
 * Water on Google's 3D tiles: lakes, ponds and rivers from OpenStreetMap (OpenFreeMap vector
 * tiles), drawn as level surfaces that reflect our sky (atmosphere.ts) with wind ripples and
 * the sun's glint, instead of Google's photo of water (flat, dull, the sky of the day it was
 * taken, often noisy).
 *
 * Each polygon is a plane laid on the ellipsoid (1 km subdivisions: a 10 km lake sags 2 m),
 * set at Google's own water level there: the median of height picks on the tiles inside the
 * polygon, taken once the tiles are in. The shoreline is then where Google's banks rise out of
 * our plane (closer to the real one than OSM's outline); Google's water mesh, a few cm below,
 * is hidden by it. Polygons without a level yet are not drawn.
 *
 * Light (in HDR, scene units): Fresnel (2% looking straight down, all at grazing angles)
 * between the sky's radiance in the reflected direction and the water's own dark body colour,
 * plus the sun's glint (GGX on the rippled normal: bright enough to bloom). Ripples: six wave
 * trains round the wind direction, longer and slower in a stronger wind, faded with distance
 * (no shimmer far away).
 *
 * Standing water only (lakes, ponds): OSM's river polygons cover whole gravel beds. Streams z11
 * tiles (lakes: ±2, ~±40 km) and z14 tiles (ponds: ±1) round the glider. With the atmosphere only (HDR, Google 3D);
 * ?water3d=0: off.
 */
import * as Cesium from "cesium";
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Cartographic, Intersect, Matrix4, PolygonGeometry, PolygonHierarchy, PostProcessStage, Transforms, VertexFormat, type Viewer } from "cesium";
import { fetchWater, type WaterPolygon } from "@webflight/scenery";
import { lonLatToTile } from "@webflight/environment";
import type { Google3D } from "./google3d.ts";
import { SCENE_DIST_GLSL, SKY_LOOKUP_GLSL, type Atmosphere } from "./atmosphere.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

const VS = /* glsl */ `
in vec3 position;
uniform vec2 u_origin;   // this polygon's frame origin, metres east/north in a global frame (mod 4096)
out vec3 v_posEC;
out vec2 v_xy;
void main() {
  vec4 p = czm_modelView * vec4(position, 1.0);
  // Drawn 0.15% of its distance nearer the camera (4.5 m at 3 km, 15 cm at 100 m): Google's own
  // water mesh, noisy and near the shores often a little above our plane, won the depth test
  // there (a band of dull photo water along the far shore). Clipping Google's tiles instead
  // cost 20–25% of the frame rate.
  p.xyz *= 0.9985;
  v_posEC = p.xyz;
  v_xy = position.xy + u_origin;
  gl_Position = czm_projection * p;
}`;

const FS = /* glsl */ `${SKY_LOOKUP_GLSL}
in vec3 v_posEC;
in vec2 v_xy;
uniform vec4 u_wind;     // direction to (x east, y north), strength 0–1, time [s]
uniform vec3 u_body;     // the water's own colour, relative to the sky's light
uniform float u_glint;   // the sun's glint strength
uniform float u_hor[16]; // the terrain's horizon round this water: elevation [rad] every 22.5° from north
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
// Slopes of ten wave trains scattered round the wind (east, north), each faded where it is
// smaller than a few pixels (from the screen footprint, so grazing views don't shimmer in
// stripes), in slow gust patches.
vec2 waveSlope(vec2 p, float fp) {
  vec2 w = normalize(u_wind.xy + vec2(1e-4));
  float t = u_wind.w, k = 0.6 + 1.4 * u_wind.z;
  float gust = 0.55 + 0.9 * wNoise(p / 90.0 + w * t * 0.05);
  vec2 g = vec2(0.0);
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float L = 0.3 * pow(1.55, fi) * k;                    // wavelength 0.3 m … 15 m
    float a = (wHash(vec2(fi, 3.7)) - 0.5) * 2.2;          // angle off the wind
    vec2 d = vec2(w.x * cos(a) - w.y * sin(a), w.x * sin(a) + w.y * cos(a));
    float kk = 6.2831853 / L, om = sqrt(9.81 * kk);        // deep-water dispersion
    float s = 0.07 * (0.4 + 0.6 * u_wind.z) * gust * (1.0 - smoothstep(L * 0.12, L * 0.45, fp));
    g += d * s * cos(dot(d, p) * kk - om * t + 6.2831853 * wHash(vec2(fi, 9.1)));
  }
  return g;
}
void main() {
  float fp = max(length(dFdx(v_xy)), length(dFdy(v_xy)));
  vec2 sl = waveSlope(v_xy, fp);
  // The normal in the polygon's frame, then eye space.
  vec3 n = normalize(czm_normal * normalize(vec3(-sl, 1.0)));
  vec3 V = normalize(-v_posEC);
  if (dot(n, V) < 0.02) n = normalize(n + V * (0.02 - dot(n, V)));
  float NV = max(dot(n, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = wfSkyRadiance(normalize(czm_inverseViewRotation * R));
  vec3 skyUp = wfSkyRadiance(normalize(czm_inverseViewRotation * czm_normal * vec3(0.0, 0.0, 1.0)));
  // Below the hills round the water the reflection is of them, not of the sky (a lake in a
  // valley at low sun was a sheet of bright sky): their lit slopes, dim and green-brown.
  vec3 Rl = transpose(czm_normal) * R;  // in the water's own east/north/up
  float az = atan(Rl.x, Rl.y) / 6.2831853 * 16.0;
  az = az < 0.0 ? az + 16.0 : az;
  int i0 = int(floor(az)) - (int(floor(az)) / 16) * 16, i1 = i0 == 15 ? 0 : i0 + 1;
  float hor = mix(u_hor[i0], u_hor[i1], fract(az));
  float el = asin(clamp(Rl.z, -1.0, 1.0));
  float skyLum = dot(skyUp, vec3(0.2126, 0.7152, 0.0722));
  vec3 hill = vec3(0.07, 0.085, 0.055) * (dot(czm_lightColorHdr, vec3(0.33)) * 0.5 + skyLum * 0.8);
  float skyPart = smoothstep(hor - 0.01, hor + 0.015, el);
  sky = mix(hill, sky, skyPart);
  vec3 body = u_body * dot(skyUp, vec3(0.2126, 0.7152, 0.0722));
  vec3 col = mix(body, sky, F);
  // The sun's glint: GGX. Where the ripples are too small to draw (far, grazing) they become
  // roughness, and the path glitters: many small facets catch the sun, most don't (a hashed
  // sparkle mask on a fine grid; a solid lobe was a sheet of white).
  vec3 L = czm_lightDirectionEC;
  float NL = max(dot(n, L), 0.0);
  if (NL > 0.0) {
    vec3 H = normalize(L + V);
    float NH = max(dot(n, H), 0.0);
    float a = mix(0.03, 0.07, u_wind.z) + clamp(fp * 0.012, 0.0, 0.05), a2 = a * a;
    float dd = NH * NH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    vec2 cell = floor(v_xy / max(fp * 1.5, 0.4) + u_wind.w * 0.7);
    float sparkle = mix(1.0, step(0.9, wHash(cell)) * 5.0, clamp(fp * 0.5, 0.0, 0.9));
    col += min(czm_lightColorHdr * D * Fs / (4.0 * NV + 1e-3) * u_glint * sparkle, vec3(15.0));
  }
#ifdef WATER_DEBUG
  col = vec3(4.0, 0.0, 0.0);
#endif
#ifdef WATER_MASK
  // The reflection pass's mask (its own target): water here, how much of the reflection above
  // was sky (the rest the estimated hills), and the distance (the pass checks the scene's).
  out_FragColor = vec4(1.0, skyPart, length(v_posEC), 1.0);
#else
  out_FragColor = vec4(col, 1.0);
#endif
}`;

/**
 * Screen-space reflections on the water (a pass after the clouds, before the tonemap): the
 * reflected ray from each water pixel is marched through the depth buffer; what it hits (hills,
 * trees, houses, the far shore) replaces the water shader's fallback (the sky table, or the
 * estimated hills below the terrain's horizon). A ray that leaves towards the sky takes the
 * screen's sky there, clouds and all. Off-screen: the fallback. Water pixels are marked by
 * their alpha (the water shader's), which also says how much of the fallback was sky.
 */
const REFLECT_FS = /* glsl */ `${SCENE_DIST_GLSL}${SKY_LOOKUP_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec2 u_camEN;   // the camera's position, metres east/north, mod 1000 (ripples stay put)
uniform sampler2D u_mask;  // the water shader's mask: flag, sky part, distance
uniform float u_time;
in vec2 v_textureCoordinates;
// Eye space → screen (the inverse of wfEyeRay, from the frustum's planes).
vec2 toUv(vec3 p) {
  vec4 fp = czm_frustumPlanes;   // top, bottom, left, right at the near distance
  float n = czm_currentFrustum.x;
  vec2 q = p.xy * (n / -p.z);
  return vec2((q.x - fp.z) / (fp.w - fp.z), (q.y - fp.y) / (fp.x - fp.y));
}
// Water at q: the mask says so and nothing stands in front of it (the scene's distance there is
// the water's).
bool isWater(vec2 q, float d) {
  vec4 m = texture(u_mask, q);
  // (Tight: the mask has no depth test, so a pond behind a hill is in it; at 5% the hill in front
  // passed, and was darkened into a black blob.)
  return m.r > 0.5 && abs(m.b - d) < 0.015 * d + 0.5;
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  float dist = wfSceneDist(depthTexture, uv);
  bool water = isWater(uv, dist);
#ifdef SSR_DEBUG
  out_FragColor = vec4(water ? vec3(0.0, 4.0, 0.0) : c.rgb * 0.3, 1.0);
  return;
#endif
  if (!water) { out_FragColor = c; return; }
  float skyPart = texture(u_mask, uv).g;
  vec3 ray = wfEyeRay(uv);
  vec3 P = ray * (dist / length(ray));
  vec3 V = normalize(P);
  // The water's normal: up at the camera, with slow world-anchored ripples (a little).
  vec3 rel = czm_inverseViewRotation * P;
  vec2 en = vec2(dot(rel, u_weast), dot(rel, u_wnorth)) + u_camEN;
  // (Faded where they are under a few pixels: far away they aliased into dashed stripes.)
  float fpx = max(length(dFdx(en)), length(dFdy(en)));
  vec2 sl = 0.012 * (1.0 - smoothstep(0.4, 1.6, fpx)) * vec2(sin(en.x * 0.9 + u_time * 1.3) + 0.6 * sin(en.y * 1.7 - u_time * 1.9), sin(en.y * 1.1 + u_time * 1.1) + 0.6 * sin((en.x + en.y) * 1.4 + u_time * 2.3));
  vec3 nW = normalize(u_wup - u_weast * sl.x - u_wnorth * sl.y);
  vec3 n = czm_viewRotation * nW;
  vec3 R = reflect(V, n);
  // Keep it above the water (at grazing angles a ripple could send it into the water itself).
  vec3 upE = czm_viewRotation * u_wup;
  float ru = dot(R, upE);
  if (ru < 0.004) R = normalize(R + upE * (0.004 - ru));
  float NV = max(dot(-V, n), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  // Looking steeply down the reflection is a few percent: not worth a march.
  if (F < 0.035) { out_FragColor = c; return; }
  // What the water shader reflected: the sky table, or below the hills its estimate of them.
  vec3 RW = normalize(czm_inverseViewRotation * R);
  vec3 skyR = wfSkyRadiance(RW);
  float skyLum = dot(wfSkyRadiance(u_wup), vec3(0.2126, 0.7152, 0.0722));
  vec3 hill = vec3(0.07, 0.085, 0.055) * (dot(czm_lightColorHdr, vec3(0.33)) * 0.5 + skyLum * 0.8);
  vec3 fallback = mix(hill, skyR, skyPart);
  // Ours only if at least about as bright as the reflection it carries (the glint only adds):
  // where our plane lies just under Google's ground (a pond in a gorge) the mask still says
  // water, and a dark rock pixel minus a bright sky went black.
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  if (dot(c.rgb, LW) < 0.5 * F * dot(fallback, LW)) { out_FragColor = c; return; }
  vec3 refl = fallback;
  float w = 0.0;
  // March the reflected ray: steps growing from ~1% of the distance, jittered per pixel (the
  // pattern it leaves is finer than the stair-steps it replaces).
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = max(dist * 0.01, 1.5) * (0.6 + 0.8 * jit), tPrev = 0.0;
  bool hit = false, onScreen = true;
  vec2 q = uv;
  for (int i = 0; i < 24; i++) {
    vec3 Q = P + R * t;
    if (Q.z > -1.0) { onScreen = false; break; }
    vec2 qn = toUv(Q);
    if (qn.x < 0.0 || qn.y < 0.0 || qn.x > 1.0 || qn.y > 1.0) { onScreen = false; break; }
    q = qn;
    float sd = wfSceneDist(depthTexture, q), qd = length(Q);
    // Thick: the scene is mostly terrain (a height field), and a thin test let rays at grazing
    // angles slip behind the far shore's hills and miss (a dark band along it).
    if (sd < qd && qd - sd < max((t - tPrev) * 3.0, qd * 0.3)) {
      // Refine between the last two steps.
      float a = tPrev, b = t;
      for (int k = 0; k < 4; k++) {
        float m = 0.5 * (a + b);
        vec3 M = P + R * m;
        vec2 mq = toUv(M);
        if (wfSceneDist(depthTexture, mq) < length(M)) { b = m; q = mq; } else a = m;
      }
      hit = true;
      break;
    }
    tPrev = t;
    t *= 1.32;
  }
  vec2 edge = min(q, 1.0 - q);
  float edgeFade = smoothstep(0.0, 0.06, min(edge.x, edge.y));
  // Out of steps while still on screen: what it was over last (far hills, as a rule).
  if (!hit && onScreen && R.z < 0.0) hit = wfSceneDist(depthTexture, q) < 1e8;
  if (hit) {
    if (!isWater(q, wfSceneDist(depthTexture, q))) { refl = texture(colorTexture, q).rgb; w = edgeFade; }
  } else if (R.z < 0.0) {
    // Towards the sky: the screen's sky in that direction (clouds and all), if it is on screen.
    vec2 qi = toUv(R * 1e5);
    if (qi.x > 0.0 && qi.y > 0.0 && qi.x < 1.0 && qi.y < 1.0 && wfSceneDist(depthTexture, qi) > 1e8) {
      vec2 e2 = min(qi, 1.0 - qi);
      refl = texture(colorTexture, qi).rgb;
      w = smoothstep(0.0, 0.06, min(e2.x, e2.y)) * skyPart;
    }
  }
  c.rgb = max(c.rgb + F * w * (refl - fallback), vec3(0.0));
#ifdef SSR_CASES
  // green: hit something; red: hit water; blue: left the screen; yellow: sky branch used; grey: nothing.
  bool hw = hit && isWater(q, wfSceneDist(depthTexture, q));
  c.rgb = hit ? (hw ? vec3(3.0, 0.0, 0.0) : vec3(0.0, 3.0, 0.0)) : (!onScreen ? (w > 0.0 ? vec3(3.0, 3.0, 0.0) : vec3(0.0, 0.0, 3.0)) : vec3(0.5));
#endif
  out_FragColor = c;
}`;

/**
 * After the reflections: water pixels averaged with their neighbours above and below (rippled
 * water smears reflections vertically), only over water, more on a rougher surface (wind). It
 * also hides the march's comb along reflected edges.
 */
const SMEAR_FS = /* glsl */ `${SCENE_DIST_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_mask;
uniform float u_rough;
in vec2 v_textureCoordinates;
bool isWater(vec2 q) {
  vec4 m = texture(u_mask, q);
  float d = wfSceneDist(depthTexture, q);
  return m.r > 0.5 && abs(m.b - d) < 0.015 * d + 0.5;
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  if (!isWater(uv)) { out_FragColor = c; return; }
  vec2 px = vec2(0.0, 1.0 / float(textureSize(colorTexture, 0).y)) * u_rough;
  vec3 sum = c.rgb;
  float w = 1.0;
  for (int k = 1; k <= 3; k++) {
    float wk = 1.0 - float(k) / 4.0;
    vec2 a = uv + px * float(k), b = uv - px * float(k);
    if (isWater(a)) { sum += texture(colorTexture, a).rgb * wk; w += wk; }
    if (isWater(b)) { sum += texture(colorTexture, b).rgb * wk; w += wk; }
  }
  out_FragColor = vec4(sum / w, c.a);
}`;

interface Body {
  poly: WaterPolygon;
  /** Frame at the polygon's centre on the ellipsoid; the plane is raised by `level`. */
  frame: Matrix4;
  model: Matrix4;
  centre: Cartographic;
  origin: Cartesian2;
  /** Points inside the polygon where Google's height is picked [lon, lat] (triangle centroids). */
  probes: [number, number][];
  /** The plane's own height at each probe above its base (0: level). */
  probeBase: number[];
  heights: number[];
  probeNext: number;
  /** When the level was last measured (it is measured again: tiles sharpen). */
  probedAt: number;
  /** The terrain's horizon seen from the water (16 directions), once the level is known. */
  horizon: number[];
  /** Water level in Google's own (unshifted) heights; drawn lowered by its current offset. */
  level: number | undefined;
  va: unknown;
  count: number;
  sphere: BoundingSphere;
  cmd: unknown;
  maskCmd: unknown;
}

export class Water {
  private readonly tiles = new Map<string, Body[] | null>();
  private readonly centres: Record<number, string> = {};
  private program: unknown;
  private wind = { dir: new Cartesian2(1, 0), strength: 0.2 };
  private readonly t0 = performance.now();
  /** Deep water's own colour (light scattered back from inside), relative to the sky's light. */
  private readonly body = new Cartesian3(0.045, 0.11, 0.11);
  private readonly sky: Record<string, () => unknown>;
  show = true;
  /** Behind the loading screen: the levelling may take more of each frame. */
  loading = false;
  readonly reflect: PostProcessStage;
  readonly smear: PostProcessStage;
  /** The reflection pass's mask target (drawing-buffer sized) and its program. */
  private mask: { tex: unknown; fb: unknown; w: number; h: number; clear: unknown } | undefined;

  private maskProgram: unknown;
  /** ?wglint= the sun's glint strength (tuning). */
  private readonly glint = Number(new URLSearchParams(location.search).get("wglint") ?? 0.25);

  constructor(
    private readonly viewer: Viewer,
    private readonly google3d: Google3D,
    atmosphere: Atmosphere,
    private readonly url: string,
    /** Our terrain's height [m] (Google's tiles are drawn lowered to match it). */
    private readonly groundAt: (latDeg: number, lonDeg: number, zoom?: number) => number | undefined,
  ) {
    this.sky = atmosphere.skyUniforms();
    viewer.scene.primitives.add(this);

    // The reflections: after the clouds, before the tonemap (main.ts adds that later).
    const t0 = this.t0, camEN = new Cartesian2();
    this.reflect = new PostProcessStage({
      fragmentShader: ({ "1": "#define SSR_DEBUG\n", "2": "#define SSR_CASES\n" }[new URLSearchParams(location.search).get("wssrdbg") ?? ""] ?? "") + REFLECT_FS,
      pixelDatatype: C.PixelDatatype.HALF_FLOAT,
      uniforms: {
        ...this.sky,
        u_time: () => (performance.now() - t0) / 1000,
        u_mask: () => this.mask?.tex ?? null,
        u_camEN: () => {
          const c = viewer.camera.positionCartographic, kx = 111_320 * Math.cos(c.latitude);
          return Cartesian2.fromElements(((Cesium.Math.toDegrees(c.longitude) * kx) % 1000 + 1000) % 1000, ((Cesium.Math.toDegrees(c.latitude) * 111_132) % 1000 + 1000) % 1000, camEN);
        },
      },
    });
    viewer.scene.postProcessStages.add(this.reflect);
    this.smear = new PostProcessStage({
      fragmentShader: SMEAR_FS,
      pixelDatatype: C.PixelDatatype.HALF_FLOAT,
      uniforms: { u_mask: () => this.mask?.tex ?? null, u_rough: () => 1.2 + 2.5 * this.wind.strength },
    });
    viewer.scene.postProcessStages.add(this.smear);
    if (new URLSearchParams(location.search).get("wssr") === "0") this.reflect.enabled = this.smear.enabled = false;
  }

  /** The day's wind: from [deg], speed [kt]. */
  setWind(fromDeg: number, kt: number): void {
    const to = ((fromDeg + 180) * Math.PI) / 180;
    this.wind = { dir: new Cartesian2(Math.sin(to), Math.cos(to)), strength: Math.min(1, kt / 20) };
  }

  /** Every frame with the glider's position: tiles round it. */
  follow(latDeg: number, lonDeg: number): void {
    const ring = (z: number, r: number, keep: number, kinds: (k: string) => boolean, minAreaM2: number, maxAreaM2 = Infinity) => {
      const [fx, fy] = lonLatToTile(lonDeg, latDeg, z);
      const cx = Math.floor(fx), cy = Math.floor(fy), key = `${cx}/${cy}`;
      if (this.centres[z] === key) return;
      this.centres[z] = key;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.load(z, cx + dx, cy + dy, kinds, minAreaM2, maxAreaM2);
      for (const [k, bodies] of this.tiles) {
        const [tz, x, y] = k.split("/").map(Number) as [number, number, number];
        if (tz === z && (Math.abs(x - cx) > keep || Math.abs(y - cy) > keep)) {
          for (const b of bodies ?? []) (b.va as { destroy(): void }).destroy();
          this.tiles.delete(k);
        }
      }
    };
    // Standing water only: OSM maps rivers here as polygons over their whole gravel bed (at
    // Codlea a 300 m band of mostly dry stones became a sheet of water).
    ring(11, 2, 3, (k) => k === "lake" || k === "ocean", 20_000);
    // Zoom 14: only what zoom 11 leaves out (the same lake from both made two planes at
    // slightly different levels).
    ring(14, 1, 2, (k) => k === "pond" || k === "lake", 800, 20_000);
  }

  private load(z: number, x: number, y: number, kinds: (k: string) => boolean, minAreaM2: number, maxAreaM2: number): void {
    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, null);
    void fetchWater(z, x, y, kinds, this.url)
      .then((all) => {
        if (!this.tiles.has(key)) return;
        const bodies = all
          .map((p) => ({ p, a: areaM2(p.rings[0]!) }))
          .filter((e) => e.a >= minAreaM2 && e.a < maxAreaM2)
          .sort((a, b) => b.a - a.a)
          .slice(0, 80)
          .map((e) => this.build(e.p))
          .filter((b): b is Body => !!b);
        this.tiles.set(key, bodies);
      })
      .catch(() => {});
  }

  private build(poly: WaterPolygon): Body | undefined {
    const context = (this.viewer.scene as unknown as { context: unknown }).context;
    const ring = (r: [number, number][]) => Cartesian3.fromDegreesArray(r.slice(0, -1).flat());
    const triangulate = (rings: [number, number][][]) =>
      PolygonGeometry.createGeometry(new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(ring(rings[0]!), rings.slice(1).map((h) => new PolygonHierarchy(ring(h)))), vertexFormat: VertexFormat.POSITION_ONLY, granularity: Cesium.Math.toRadians(0.01) }));
    // Drawn 40 m past OSM's outline (at a reservoir in Google's photo the water reached well
    // past it: a teal rim round ours). Where the shore is higher than the water it hides the
    // plane anyway, so the shoreline is Google's; the levels are probed inside the outline.
    const geom = triangulate([offsetRing(poly.rings[0]!, 40), ...poly.rings.slice(1).map((h) => offsetRing(h, -40))]);
    const inner = triangulate(poly.rings);
    if (!geom || !inner) return undefined;
    const pos = geom.attributes.position!.values as unknown as Float64Array, idx = geom.indices as unknown as Uint16Array | Uint32Array;
    // Frame at the centre of the vertices, on the ellipsoid.
    const centreWC = BoundingSphere.fromVertices(Array.from(pos)).center;
    const centre = Cartographic.fromCartesian(centreWC);
    centre.height = 0;
    const frame = Transforms.eastNorthUpToFixedFrame(Cartographic.toCartesian(centre));
    const inv = Matrix4.inverseTransformation(frame, new Matrix4());
    const local = new Float32Array(pos.length), p = new Cartesian3(), n = pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) {
      Matrix4.multiplyByPoint(inv, Cartesian3.fromElements(pos[i]!, pos[i + 1]!, pos[i + 2]!, p), p);
      local[i] = p.x;
      local[i + 1] = p.y;
      local[i + 2] = p.z;
    }
    // Probes: centroids of the largest triangles of the outline itself (inside it).
    const tris: { a: number; c: [number, number]; b: number }[] = [];
    const ipos = inner.attributes.position!.values as unknown as Float64Array, iidx = inner.indices as unknown as Uint16Array | Uint32Array;
    const P = (k: number) => Cartesian3.fromElements(ipos[3 * k]!, ipos[3 * k + 1]!, ipos[3 * k + 2]!);
    for (let t = 0; t < iidx.length; t += 3) {
      const A = P(iidx[t]!), B = P(iidx[t + 1]!), Cc = P(iidx[t + 2]!);
      const area = Cartesian3.magnitude(Cartesian3.cross(Cartesian3.subtract(B, A, new Cartesian3()), Cartesian3.subtract(Cc, A, new Cartesian3()), new Cartesian3())) / 2;
      const cc = Cartographic.fromCartesian(Cartesian3.multiplyByScalar(Cartesian3.add(Cartesian3.add(A, B, new Cartesian3()), Cc, new Cartesian3()), 1 / 3, new Cartesian3()));
      tris.push({ a: area, c: [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)], b: 0 });
    }
    // Many, spread out: only those in view can be measured (Google's tiles answer only where
    // they are drawn), and a lake half behind the camera must level from its visible half.
    const best = tris.sort((a, b) => b.a - a.a).slice(0, 24);
    // Plus the outline's centre (on some small ponds every triangle-centre pick missed while the
    // centre answered; why is not known).
    const probes = [...best.map((t) => t.c), [Cesium.Math.toDegrees(centre.longitude), Cesium.Math.toDegrees(centre.latitude)] as [number, number]], probeBase = [...best.map((t) => t.b), 0];
    const vb = C.Buffer.createVertexBuffer({ context, typedArray: local, usage: C.BufferUsage.STATIC_DRAW });
    const ib = C.Buffer.createIndexBuffer({ context, typedArray: idx instanceof Uint32Array ? idx : new Uint16Array(idx), usage: C.BufferUsage.STATIC_DRAW, indexDatatype: idx instanceof Uint32Array ? C.IndexDatatype.UNSIGNED_INT : C.IndexDatatype.UNSIGNED_SHORT });
    const va = new C.VertexArray({ context, indexBuffer: ib, attributes: [{ index: 0, vertexBuffer: vb, componentsPerAttribute: 3, componentDatatype: C.ComponentDatatype.FLOAT }] });
    const kx = 111_320 * Math.cos(centre.latitude);
    const origin = new Cartesian2(((Cesium.Math.toDegrees(centre.longitude) * kx) % 4096 + 4096) % 4096, ((Cesium.Math.toDegrees(centre.latitude) * 111_132) % 4096 + 4096) % 4096);
    // At the ground's height (the outline is on the ellipsoid, hundreds of metres below: small
    // ponds were culled as out of view, so never measured nor drawn); at the water once levelled.
    const sphere = BoundingSphere.fromVertices(Array.from(pos));
    const cla = Cesium.Math.toDegrees(centre.latitude), clo = Cesium.Math.toDegrees(centre.longitude);
    const g0 = this.groundAt(cla, clo, 13) ?? this.groundAt(cla, clo, 11) ?? this.groundAt(cla, clo, 9) ?? 0;
    sphere.center = Cartesian3.fromRadians(centre.longitude, centre.latitude, g0);
    sphere.radius += 30;
    return { poly, frame, model: Matrix4.clone(frame), centre, origin, probes, probeBase, heights: [], probeNext: 0, level: undefined, horizon: new Array(16).fill(0), probedAt: 0, va, count: idx.length, sphere, cmd: undefined, maskCmd: undefined };
  }

  /**
   * Google's water level: a few height picks a frame (0.8 ms) among the bodies in view still
   * without one, or measured more than 15 s ago (finer tiles have come since). A pick counts
   * only within 60 m of our terrain: on a coarse tile (before the fine ones load) it lands on
   * a chord of a triangle hundreds of km across, kilometres below the ground; a reservoir's
   * water can be tens of metres above the valley floor the terrain data has.
   */
  private probe(cull: { computeVisibility(b: BoundingSphere): number }): void {
    const t0 = performance.now(), budget = this.loading ? 4 : 0.8;
    for (const bodies of this.tiles.values())
      for (const b of bodies ?? []) {
        if (b.probeNext >= b.probes.length) {
          if (b.level === undefined || t0 - b.probedAt > 15_000) (b.probeNext = 0), (b.heights = []);
          else continue;
        }
        if (cull.computeVisibility(b.sphere) === Intersect.OUTSIDE) continue;
        while (b.probeNext < b.probes.length && performance.now() - t0 < budget) {
          const [lon, lat] = b.probes[b.probeNext++]!;
          probeSphere.center = Cartesian3.fromDegrees(lon, lat, b.level !== undefined ? b.level - this.google3d.offsetM : (this.groundAt(lat, lon) ?? 0), undefined, probeSphere.center);
          if (cull.computeVisibility(probeSphere) === Intersect.OUTSIDE) continue;
          const h = this.google3d.tileset.getHeight(Cartographic.fromDegrees(lon, lat), this.viewer.scene), o = this.groundAt(lat, lon);
          if (h !== undefined && o !== undefined && Number.isFinite(h) && Math.abs(h - o) < 60) b.heights.push(h - b.probeBase[b.probeNext - 1]!);
        }
        if (b.probeNext >= b.probes.length) {
          b.probedAt = t0;
          // Three answers for a lake; one is enough for a small pond (often only its centre answers).
          if (b.heights.length >= (b.sphere.radius < 400 ? 1 : 3)) {
            const v = [...b.heights].sort((x, y) => x - y);
            // The median, a little above (Google's water mesh is noisy; ours covers it).
            b.level = v[Math.floor(v.length / 2)]! + 0.25 + this.google3d.offsetM;
            this.place(b);
            this.horizonOf(b);
          }
        }
        if (performance.now() - t0 >= budget) return;
      }
  }

  /**
   * The highest elevation angle of our terrain in 16 directions from the water's centre, out to
   * 8 km (ground beyond the shore only: the first 60 m skipped).
   */
  private horizonOf(b: Body): void {
    const lat0 = Cesium.Math.toDegrees(b.centre.latitude), lon0 = Cesium.Math.toDegrees(b.centre.longitude);
    const kx = 111_320 * Math.cos(b.centre.latitude), ky = 111_132, h0 = b.level! - this.google3d.offsetM;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      let best = 0;
      for (let d = 60 + b.sphere.radius * 0.5; d < 8000; d *= 1.18) {
        const h = this.groundAt(lat0 + (Math.cos(a) * d) / ky, lon0 + (Math.sin(a) * d) / kx, 12);
        if (h !== undefined) best = Math.max(best, Math.atan2(h - h0, d));
      }
      b.horizon[k] = best;
    }
  }

  /** The plane at its level, as Google's tiles are drawn now (lowered by their offset). */
  private place(b: Body): void {
    const h = b.level! - this.google3d.offsetM, f = b.frame;
    Matrix4.setTranslation(f, new Cartesian3(f[12]! + f[8]! * h, f[13]! + f[9]! * h, f[14]! + f[10]! * h), b.model);
    b.sphere.center = Cartesian3.fromRadians(b.centre.longitude, b.centre.latitude, h, undefined, b.sphere.center);
  }
  private placedOffset = Number.NaN;

  /** One body's uniforms (all of them, in one place). */
  private uniforms(b: Body, wind: Cartesian4): Record<string, () => unknown> {
    return { ...this.sky, u_origin: () => b.origin, u_wind: () => wind, u_body: () => this.body, u_glint: () => this.glint, u_hor: () => b.horizon };
  }

  /** Cesium primitive interface. */
  update(frameState: { commandList: unknown[]; context: unknown; cullingVolume: { computeVisibility(b: BoundingSphere): number }; passes: { render: boolean } }): void {
    if (!this.show || !frameState.passes.render) return;
    this.probe(frameState.cullingVolume);
    // Google's offset moved (it is blended in): every plane with it.
    if (this.google3d.offsetM !== this.placedOffset) {
      this.placedOffset = this.google3d.offsetM;
      for (const bodies of this.tiles.values()) for (const b of bodies ?? []) if (b.level !== undefined) this.place(b);
    }
    const context = frameState.context;
    if (!this.program) this.program = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: (new URLSearchParams(location.search).get("waterdbg") === "1" ? "#define WATER_DEBUG\n" : "") + FS, attributeLocations: { position: 0 } });
    if (!this.maskProgram) this.maskProgram = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: "#define WATER_MASK\n" + FS, attributeLocations: { position: 0 } });
    // The mask target, as big as the drawing buffer; cleared each frame before the water.
    const ctx = context as { drawingBufferWidth: number; drawingBufferHeight: number };
    const W = ctx.drawingBufferWidth, Hh = ctx.drawingBufferHeight;
    if (!this.mask || this.mask.w !== W || this.mask.h !== Hh) {
      (this.mask?.fb as { destroy?(): void } | undefined)?.destroy?.();
      const tex = new C.Texture({ context, width: W, height: Hh, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.FLOAT, sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }) });
      const fb = new C.Framebuffer({ context, colorTextures: [tex], destroyAttachments: true });
      this.mask = { tex, fb, w: W, h: Hh, clear: new C.ClearCommand({ color: new Cesium.Color(0, 0, 0, 0), framebuffer: fb, pass: C.Pass.OPAQUE, owner: this }) };
      for (const bodies of this.tiles.values()) for (const b of bodies ?? []) b.maskCmd = undefined;
    }
    frameState.commandList.push(this.mask.clear);
    const w = this.wind, t = (performance.now() - this.t0) / 1000;
    const wind = new Cartesian4(w.dir.x, w.dir.y, w.strength, t);
    for (const bodies of this.tiles.values())
      for (const b of bodies ?? []) {
        if (b.level === undefined) continue;
        if (frameState.cullingVolume.computeVisibility(b.sphere) === Intersect.OUTSIDE) continue;
        if (!b.cmd)
          b.cmd = new C.DrawCommand({
            vertexArray: b.va,
            primitiveType: C.PrimitiveType.TRIANGLES,
            shaderProgram: this.program,
            renderState: C.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } }),
            pass: C.Pass.OPAQUE,
            owner: this,
            modelMatrix: b.model,
            boundingVolume: b.sphere,
            count: b.count,
            uniformMap: this.uniforms(b, wind),
          });
        const cmd = b.cmd as Record<string, unknown>;
        cmd["uniformMap"] = this.uniforms(b, wind);
        frameState.commandList.push(b.cmd);
        if (!b.maskCmd)
          b.maskCmd = new C.DrawCommand({
            vertexArray: b.va,
            primitiveType: C.PrimitiveType.TRIANGLES,
            shaderProgram: this.maskProgram,
            renderState: C.RenderState.fromCache({ depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } }),
            pass: C.Pass.OPAQUE,
            owner: this,
            modelMatrix: b.model,
            boundingVolume: b.sphere,
            count: b.count,
            framebuffer: this.mask.fb,
            uniformMap: this.uniforms(b, wind),
          });
        (b.maskCmd as Record<string, unknown>)["uniformMap"] = cmd["uniformMap"];
        frameState.commandList.push(b.maskCmd);
      }
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    for (const bodies of this.tiles.values()) for (const b of bodies ?? []) (b.va as { destroy(): void }).destroy();
    this.tiles.clear();
    (this.mask?.fb as { destroy?(): void } | undefined)?.destroy?.();
    this.mask = undefined;

  }
}

/**
 * A closed [lon, lat] ring moved outwards (away from its inside) by d metres, each vertex along
 * its corner's bisector (miter, limited). Enough for tens of metres round a lake.
 */
function offsetRing(r: [number, number][], d: number): [number, number][] {
  const lat0 = r[0]![1], kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 111_132;
  const pts = r.slice(0, -1).map(([lo, la]) => [lo * kx, la * ky] as [number, number]);
  const n = pts.length;
  if (n < 3) return r;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]!, [x2, y2] = pts[(i + 1) % n]!;
    area += x1 * y2 - x2 * y1;
  }
  // Outward normal of an edge: right of it for a counter-clockwise ring, left for clockwise.
  const sgn = area > 0 ? 1 : -1;
  const normal = (a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [(sgn * dy) / l, (-sgn * dx) / l] as [number, number];
  };
  const out = pts.map((p, i) => {
    const n1 = normal(pts[(i - 1 + n) % n]!, p), n2 = normal(p, pts[(i + 1) % n]!);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const k = d / Math.max(0.4, mx * n1[0] + my * n1[1]);
    return [(p[0] + mx * k) / kx, (p[1] + my * k) / ky] as [number, number];
  });
  out.push(out[0]!);
  return out;
}

const probeSphere = new BoundingSphere(new Cartesian3(), 5);

/** Area of a closed [lon, lat] ring [m²] (local equirectangular). */
function areaM2(r: [number, number][]): number {
  const k = 111_320 * Math.cos(((r[0]?.[1] ?? 0) * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * k * (r[j]![1] + r[i]![1]) * 111_132;
  return Math.abs(a / 2);
}
