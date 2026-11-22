/**
 * Water on Google's 3D tiles: lakes, reservoirs and rivers drawn as surfaces that reflect our sky
 * (atmosphere.ts) and the scene (screen-space reflections), with wind ripples and the sun's
 * glint, instead of Google's photo of water (flat, dull, the sky of the day it was taken).
 * MSFS-style rather than strictly photographic: deep blue-teal, lighter in the shallows.
 *
 * Where: JRC Global Surface Water (EC JRC / Google, Pekel et al. 2016: 38 years of Landsat at
 * 30 m), its occurrence layer as map tiles: every pixel where water has been seen. OSM's
 * outlines left gaps (a reservoir's arm full in Google's photo, unmapped in OSM: teal patches)
 * and mapped rivers over whole gravel beds; JRC has the water itself, seasonal margins
 * included. Each map tile with water becomes a grid laid on the ellipsoid (its curvature
 * corrected), drawn where JRC has seen water (dilated a pixel): z13 tiles (3.4 km) round the
 * glider, z11 tiles (14 km) farther out, the near ones cut out of the far.
 *
 * At which height: Google's own. Height picks on the tiles at points JRC calls water most of the
 * time, taken in view (Google's tiles answer only where drawn), each within 60 m of our terrain
 * (coarse tiles answer kilometres off); a 16×16 level grid per tile from the median of the
 * picks within ~500 m (so a dam's two basins, or a river's fall, keep their own levels), a
 * little above (Google's water mesh is noisy). Measured again every 15 s as tiles sharpen. The
 * shoreline is where Google's banks rise above our surface; Google's water mesh, just below, is
 * hidden by it. Tiles without a level yet are not drawn.
 *
 * Light (in HDR, scene units): Fresnel between the sky's radiance in the reflected direction
 * and the water's own colour; below the terrain's horizon round the tile the hills; the sun's
 * glint (GGX), glittering where ripples are too small to draw. ?water3d=0: off.
 */
import * as Cesium from "cesium";
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Cartographic, Credit, Intersect, Matrix4, PostProcessStage, Transforms, type Viewer } from "cesium";
import type { Google3D } from "./google3d.ts";
import { CLOUD_SHADE, SUN_THROUGH_DECLS, SUN_THROUGH_GLSL } from "./sun-through.ts";
import { decodeMvt } from "@webflight/scenery";
import { SCENE_DIST_GLSL, SKY_LOOKUP_GLSL, type Atmosphere } from "./atmosphere.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

/** JRC Global Surface Water, occurrence 1984–2021 (alpha: the share of the time water was seen). */
const JRC = "https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png";
/** Grid vertices across a tile, level cells across. */
const GRID = 33, LEV = 16;

const VS = /* glsl */ `
in vec2 position;          // grid uv, 0–1 (v north)
uniform vec4 u_tile;       // size east, north [m]
uniform sampler2D u_level; // LEV×LEV: height above the tile's base [m]
uniform vec2 u_origin;     // the tile centre, metres east/north in a global frame (mod 4096)
out vec3 v_posEC;
out vec2 v_xy;
out vec2 v_uv;
float levelAt(vec2 uv) {
  vec2 g = clamp(uv * ${LEV.toFixed(1)} - 0.5, 0.0, ${(LEV - 1).toFixed(1)});
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  ivec2 j = min(i + 1, ivec2(${LEV - 1}));
  return mix(mix(texelFetch(u_level, i, 0).r, texelFetch(u_level, ivec2(j.x, i.y), 0).r, f.x),
             mix(texelFetch(u_level, ivec2(i.x, j.y), 0).r, texelFetch(u_level, j, 0).r, f.x), f.y);
}
void main() {
  vec2 xy = (position - 0.5) * u_tile.xy;
  // On the ellipsoid: the plane drops away from the tile's centre (2 m at 5 km).
  float z = levelAt(position) - dot(xy, xy) / (2.0 * 6371000.0);
  vec4 p = czm_modelView * vec4(xy, z, 1.0);
  // Nearer the camera by 0.15% of the distance (2 m at 1.5 km): Google's water mesh tilts a metre
  // or so across a reservoir and won the depth test where it rose above ours (cut along a straight
  // line). Safe now that we draw only where JRC has seen water (+65 m), not over the land.
  p.xyz *= 0.9985;
  v_posEC = p.xyz;
  v_xy = xy + u_origin;
  v_uv = position;
  gl_Position = czm_projection * p;
}`;

/**
 * Ripples: a tileable normal map (CesiumJS's waterNormals.jpg) in three layers, 7, 19 and 53 m
 * across, turned against each other and drifting with the wind at their own speeds, in slow gust
 * patches. Mipmapping averages them away with distance (calm, mirror-like water far off, no
 * aliased stripes). Replaces ten sine wave trains, whose interference read as diagonal,
 * periodic bands. Needs uniforms u_normals, u_wind (direction x, y, strength, time); p in metres
 * east/north.
 */
const RIPPLES_GLSL = /* glsl */ `
uniform sampler2D u_normals;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
vec2 rippleSlope(vec2 p) {
  vec2 w = normalize(u_wind.xy + vec2(1e-4));
  float t = u_wind.w, spd = 0.25 + 0.75 * u_wind.z;
  // Rotations by 3-4-5 angles (no shared axes between the layers).
  mat2 r1 = mat2(0.8, 0.6, -0.6, 0.8), r2 = mat2(0.28, -0.96, 0.96, 0.28);
  vec2 a = texture(u_normals, p / 7.3 + w * (t * spd * 0.09)).xy * 2.0 - 1.0;
  vec2 b = texture(u_normals, r1 * p / 19.1 + (r1 * w) * (t * spd * 0.025) + 0.37).xy * 2.0 - 1.0;
  vec2 c = texture(u_normals, r2 * p / 53.0 + (r2 * w) * (t * spd * 0.006) + 0.71).xy * 2.0 - 1.0;
  float gust = 0.6 + 0.8 * wNoise(p / 140.0 + w * t * 0.03);
  return (a * 0.45 + transpose(r1) * b * 0.35 + transpose(r2) * c * 0.3) * (0.05 + 0.11 * u_wind.z) * gust;
}
`;

const FS = /* glsl */ `${SKY_LOOKUP_GLSL}
in vec3 v_posEC;
in vec2 v_xy;
in vec2 v_uv;
uniform sampler2D u_occ;  // JRC occurrence (0–1), rows north to south
uniform vec4 u_cut;       // far tiles: the near tiles' rectangle (uv), not drawn here
uniform vec4 u_wind;     // direction to (x east, y north), strength 0–1, time [s]
uniform vec3 u_body;     // the water's own colour, relative to the sky's light
uniform float u_glint;   // the sun's glint strength
uniform float u_hor[16]; // the terrain's horizon round this water: elevation [rad] every 22.5° from north
${SUN_THROUGH_DECLS}${SUN_THROUGH_GLSL}
${RIPPLES_GLSL}
void main() {
  // Only where the satellites have seen water (a little dilated, made on the CPU); the
  // shoreline itself is where Google's banks rise above our surface.
  float occ = texture(u_occ, vec2(v_uv.x, 1.0 - v_uv.y)).r;
  if (occ < 0.015) discard;
  if (v_uv.x > u_cut.x && v_uv.y > u_cut.y && v_uv.x < u_cut.z && v_uv.y < u_cut.w) discard;
  float fp = max(length(dFdx(v_xy)), length(dFdy(v_xy)));
  vec2 sl = rippleSlope(v_xy);
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
  // Dark green (wooded slopes, mostly in shade seen from the water); a grey-brown read as muddy.
  vec3 hill = vec3(0.03, 0.06, 0.04) * (dot(czm_lightColorHdr, vec3(0.33)) * 0.5 + skyLum * 0.8);
  float skyPart = smoothstep(hor - 0.01, hor + 0.015, el);
  sky = mix(hill, sky, skyPart);
  // The water's own colour: deep blue-teal, lighter and greener where it is shallow or only
  // sometimes water (low occurrence: the margins), as in MSFS.
  // (Subtle: with the grade on top a strong tint made teal blotches like Google's photo.)
  vec3 bodyCol = mix(u_body, vec3(0.08, 0.16, 0.15), 0.45 * (1.0 - smoothstep(0.15, 0.7, occ)));
  // In a cloud's shade (sun-through.ts): the light into the water as on the ground round it, the
  // sun's glint as much as gets through (the sky it mirrors is the same).
  float sunThrough = wfSunThrough(czm_inverseViewRotation * v_posEC);
  vec3 body = bodyCol * dot(skyUp, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - ${CLOUD_SHADE.toFixed(2)} * (1.0 - sunThrough));
  vec3 col = mix(body, sky, F);
  // The sun's glint: GGX. Where the ripples are too small to draw (far, grazing) they become
  // roughness. The glitter comes from the ripple normals themselves (a hashed grid of sparkles
  // read as a pattern).
  vec3 L = czm_lightDirectionEC;
  float NL = max(dot(n, L), 0.0);
  if (NL > 0.0) {
    vec3 H = normalize(L + V);
    float NH = max(dot(n, H), 0.0);
    float a = mix(0.03, 0.07, u_wind.z) + clamp(fp * 0.012, 0.0, 0.05), a2 = a * a;
    float dd = NH * NH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    col += min(czm_lightColorHdr * D * Fs / (4.0 * NV + 1e-3) * u_glint * sunThrough, vec3(15.0));
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
uniform vec4 u_wind;
${RIPPLES_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec2 u_camEN;   // the camera's position, metres east/north, mod 4096 (as the water's)
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
  // The water shader's ripples, weaker (the reflection only wobbles).
  vec2 sl = 0.2 * rippleSlope(en);
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
  // Dark green (wooded slopes, mostly in shade seen from the water); a grey-brown read as muddy.
  vec3 hill = vec3(0.03, 0.06, 0.04) * (dot(czm_lightColorHdr, vec3(0.33)) * 0.5 + skyLum * 0.8);
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
  float t = max(dist * 0.01, 1.5) * (0.85 + 0.3 * jit), tPrev = 0.0;
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
  // Out of steps while still on screen: what it is over now. Ground (far hills, as a rule): a
  // hit. Sky: the screen's sky there, clouds and all. (It used to fall back to the estimate of
  // the hills round the lake, which depended on which terrain tiles were in when the lake was
  // levelled: the same view showed sky in one run and dark hills in the next.)
  bool skyEnd = false;
  if (!hit && onScreen && R.z < 0.0) {
    if (wfSceneDist(depthTexture, q) < 1e8) hit = true;
    else skyEnd = true;
  }
  if (skyEnd) { refl = texture(colorTexture, q).rgb; w = edgeFade; }
  if (hit) {
    if (!isWater(q, wfSceneDist(depthTexture, q))) { refl = texture(colorTexture, q).rgb; w = edgeFade; }
  } else if (!skyEnd && R.z < 0.0) {
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
  for (int k = 1; k <= 2; k++) {
    float wk = 1.0 - float(k) / 3.0;
    vec2 a = uv + px * float(k), b = uv - px * float(k);
    if (isWater(a)) { sum += texture(colorTexture, a).rgb * wk; w += wk; }
    if (isWater(b)) { sum += texture(colorTexture, b).rgb * wk; w += wk; }
  }
  out_FragColor = vec4(sum / w, c.a);
}`;

interface Tile {
  z: number;
  x: number;
  y: number;
  /** Bounds [deg]. */
  west: number;
  east: number;
  south: number;
  north: number;
  size: Cartesian2;
  /** ENU frame at the tile's centre on the ellipsoid; drawn raised to its base level. */
  frame: Matrix4;
  model: Matrix4;
  centre: Cartographic;
  origin: Cartesian2;
  occ: unknown;
  /** Probe points [lon, lat] and Google's height at each (NaN: no answer yet). */
  probes: [number, number][];
  heights: Float64Array;
  /** An answer changed in this pass. */
  changed: boolean;
  /** When the tile was built [ms]. */
  born: number;
  probeNext: number;
  probedAt: number;
  /** Lowest level in Google's own (unshifted) heights; undefined until measured. */
  base: number | undefined;
  levels: Float32Array;
  levelTex: unknown;
  horizon: number[];
  sphere: BoundingSphere;
  cut: Cartesian4;
  cmd: unknown;
  maskCmd: unknown;
}

export class Water {
  private readonly tiles = new Map<string, Tile | null>();
  private readonly centres: Record<number, string> = {};
  private program: unknown;
  private maskProgram: unknown;
  private grid: { va: unknown; count: number } | undefined;
  private wind = { dir: new Cartesian2(1, 0), strength: 0.2 };
  private readonly t0 = performance.now();
  /** Deep water's own colour (light scattered back from inside), relative to the sky's light. */
  private readonly body = new Cartesian3(0.05, 0.14, 0.16);
  private readonly sky: Record<string, () => unknown>;
  show = true;
  /** Behind the loading screen: the levelling may take more of each frame. */
  loading = false;
  readonly reflect: PostProcessStage;
  readonly smear: PostProcessStage;
  /** The reflection pass's mask target (drawing-buffer sized). */
  private mask: { tex: unknown; fb: unknown; w: number; h: number; clear: unknown } | undefined;
  /** The ripple normal map (CesiumJS's waterNormals.jpg), once loaded. */
  private normals: unknown;
  private flat: unknown;
  private blank(): unknown {
    if (!this.flat) {
      const context = (this.viewer.scene as unknown as { context: unknown }).context;
      this.flat = new C.Texture({ context, width: 1, height: 1, source: { arrayBufferView: new Uint8Array([128, 128, 255, 255]) }, flipY: false });
    }
    return this.flat;
  }
  private windVec(): Cartesian4 {
    const w = this.wind;
    return new Cartesian4(w.dir.x, w.dir.y, w.strength, (performance.now() - this.t0) / 1000);
  }
  /** ?wglint= the sun's glint strength (tuning). */
  private readonly glint = Number(new URLSearchParams(location.search).get("wglint") ?? 0.25);
  /** The near tiles' bounds [deg] (cut out of the far ones). */
  private near = { west: 0, east: 0, south: 0, north: 0 };
  private readonly credit = new Credit("Water: EC JRC/Google Global Surface Water");

  constructor(
    private readonly viewer: Viewer,
    private readonly google3d: Google3D,
    atmosphere: Atmosphere,
    /** Our terrain's height [m] (Google's tiles are drawn lowered to match it). */
    private readonly groundAt: (latDeg: number, lonDeg: number, zoom?: number) => number | undefined,
    /** OpenMapTiles vector tiles (OpenFreeMap): river centrelines. */
    private readonly osmUrl?: string,
  ) {
    this.sky = atmosphere.skyUniforms();
    viewer.scene.primitives.add(this);
    void (async () => {
      const r = await fetch(C.buildModuleUrl("Assets/Textures/waterNormals.jpg"));
      const bmp = await createImageBitmap(await r.blob());
      const context = (viewer.scene as unknown as { context: unknown }).context;
      const tex = new C.Texture({
        context,
        source: bmp,
        sampler: new C.Sampler({ wrapS: C.TextureWrap.REPEAT, wrapT: C.TextureWrap.REPEAT, minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8 }),
      });
      tex.generateMipmap();
      this.normals = tex;
    })().catch((e: unknown) => console.warn("water: ripple normals not loaded", e));
    viewer.creditDisplay.addStaticCredit(this.credit);
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
          return Cartesian2.fromElements(((Cesium.Math.toDegrees(c.longitude) * kx) % 4096 + 4096) % 4096, ((Cesium.Math.toDegrees(c.latitude) * 111_132) % 4096 + 4096) % 4096, camEN);
        },
        u_normals: () => this.normals ?? this.blank(),
        u_wind: () => this.windVec(),
      },
    });
    viewer.scene.postProcessStages.add(this.reflect);
    this.smear = new PostProcessStage({
      fragmentShader: SMEAR_FS,
      pixelDatatype: C.PixelDatatype.HALF_FLOAT,
      uniforms: { u_mask: () => this.mask?.tex ?? null, u_rough: () => 0.5 + 0.7 * this.wind.strength },
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
    const ring = (z: number, r: number, keep: number) => {
      const n = 2 ** z;
      const fx = ((lonDeg + 180) / 360) * n, fy = ((1 - Math.log(Math.tan((latDeg * Math.PI) / 180) + 1 / Math.cos((latDeg * Math.PI) / 180)) / Math.PI) / 2) * n;
      const cx = Math.floor(fx), cy = Math.floor(fy), key = `${cx}/${cy}`;
      if (this.centres[z] === key) return;
      this.centres[z] = key;
      if (z === 13) {
        this.near = { west: tileLon(cx - r, z), east: tileLon(cx + r + 1, z), north: tileLat(cy - r, z), south: tileLat(cy + r + 1, z) };
        for (const t of this.tiles.values()) if (t && t.z !== 13) this.cutFor(t);
      }
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.load(z, cx + dx, cy + dy);
      for (const [k, t] of this.tiles) {
        const [tz, x, y] = k.split("/").map(Number) as [number, number, number];
        if (tz === z && (Math.abs(x - cx) > keep || Math.abs(y - cy) > keep)) {
          this.free(t);
          this.tiles.delete(k);
        }
      }
    };
    ring(13, 2, 3);
    ring(11, 2, 3);
  }

  private free(t: Tile | null): void {
    if (!t) return;
    (t.occ as { destroy(): void }).destroy();
    (t.levelTex as { destroy?(): void } | undefined)?.destroy?.();
  }

  /** The near tiles' rectangle in a far tile's uv (nothing drawn there). */
  private cutFor(t: Tile): void {
    const n = this.near;
    t.cut = new Cartesian4((n.west - t.west) / (t.east - t.west), (n.south - t.south) / (t.north - t.south), (n.east - t.west) / (t.east - t.west), (n.north - t.south) / (t.north - t.south));
  }

  private load(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, null);
    const fill = (u: string) => u.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    void (async () => {
      const [jrc, rivers] = await Promise.all([
        (async () => {
          const r = await fetch(fill(JRC));
          if (!r.ok) return undefined; // 404: no water seen here
          const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none" });
          const g = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, 256, 256).data;
        })().catch(() => undefined),
        // OSM's rivers only in the near tiles: in the far ones (zoom 11, ~54 m a pixel) a 40 m
        // river is under a pixel, drawn a pixel wide and levelled from coarse answers, so it
        // showed as dark dashes along the horizon (Google's photo has those rivers anyway).
        this.osmUrl && z >= 13 ? this.majorRivers(z, x, y).then((major) => riverMask(fill(this.osmUrl!), z, tileLat(y + 0.5, z), major)).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      if (!this.tiles.has(key) || (!jrc && !rivers)) return;
      const t = this.build(z, x, y, jrc, rivers);
      if (t) this.tiles.set(key, t);
    })().catch(() => {});
  }

  private readonly major = new Map<string, Promise<Set<string>>>();
  /**
   * The rivers OpenFreeMap keeps at zoom 8 round a tile (by name): its long ones (OpenMapTiles
   * ranks them by length), here the Olt, not the Bârsa or the Ghimbășel.
   */
  private majorRivers(z: number, x: number, y: number): Promise<Set<string>> {
    const s = 2 ** (z - 8), key = `${Math.floor(x / s)}/${Math.floor(y / s)}`;
    let p = this.major.get(key);
    if (!p) {
      const url = this.osmUrl!.replace("{z}", "8").replace("{x}", String(Math.floor(x / s))).replace("{y}", String(Math.floor(y / s)));
      p = fetch(url)
        .then(async (r) => {
          const out = new Set<string>();
          if (!r.ok) return out;
          for (const l of decodeMvt(new Uint8Array(await r.arrayBuffer())))
            if (l.name === "waterway") for (const f of l.features) if (f.properties["class"] === "river" && typeof f.properties["name"] === "string") out.add(f.properties["name"]);
          return out;
        })
        .catch(() => new Set<string>());
      this.major.set(key, p);
    }
    return p;
  }

  private build(z: number, x: number, y: number, rgba: Uint8ClampedArray | undefined, rivers: Uint8Array | undefined): Tile | undefined {
    const context = (this.viewer.scene as unknown as { context: unknown }).context;
    // Occurrence (alpha), grown by ~65 m (z13: 5 pixels; z11: 1): Google's photo often shows
    // water 30–60 m past what JRC has seen (a teal rim round ours); the shoreline is cut by
    // Google's banks anyway. Then softened (a box blur), so edges and the shallow tint have no
    // 30 m steps.
    const a = new Uint8Array(256 * 256);
    let any = 0;
    if (rgba) for (let i = 0; i < a.length; i++) any |= a[i] = rgba[4 * i + 3]!;
    if (rivers) for (let i = 0; i < a.length; i++) any |= rivers[i]!;
    if (!any) return undefined;
    const R = z >= 13 ? 5 : 1;
    const grown = new Uint8Array(256 * 256);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        let m = 0;
        for (let dj = -R; dj <= R; dj++)
          for (let di = -R; di <= R; di++) {
            const ii = i + di, jj = j + dj, d = Math.hypot(di, dj);
            if (d > R + 0.5 || ii < 0 || jj < 0 || ii > 255 || jj > 255) continue;
            m = Math.max(m, a[jj * 256 + ii]! * (1 - (0.5 * d) / (R + 1)));
          }
        grown[j * 256 + i] = m;
      }
    const occ = new Uint8Array(256 * 256 * 4);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii >= 0 && jj >= 0 && ii < 256 && jj < 256) (sum += grown[jj * 256 + ii]!), n++;
          }
        const k = 4 * (j * 256 + i);
        // Rivers from OSM at their own width (not grown: the channel, not the floodplain).
        occ[k] = occ[k + 1] = occ[k + 2] = occ[k + 3] = Math.max(Math.round(sum / n), rivers?.[j * 256 + i] ?? 0);
      }
    // Probes on rivers too (JRC misses most rivers narrower than ~60 m).
    if (rivers) for (let i = 0; i < a.length; i++) a[i] = Math.max(a[i]!, rivers[i]!);
    const tex = new C.Texture({
      context,
      width: 256,
      height: 256,
      pixelFormat: C.PixelFormat.RGBA,
      pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
      source: { arrayBufferView: occ },
      flipY: false,
      sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }),
    });
    const west = tileLon(x, z), east = tileLon(x + 1, z), north = tileLat(y, z), south = tileLat(y + 1, z);
    const centre = Cartographic.fromDegrees((west + east) / 2, (south + north) / 2, 0);
    const kx = 111_320 * Math.cos(centre.latitude), ky = 111_132;
    const size = new Cartesian2((east - west) * kx, (north - south) * ky);
    const frame = Transforms.eastNorthUpToFixedFrame(Cartographic.toCartesian(centre));
    // Probes: pixels water most of the time (else at all), spread over all of them, at most 64.
    // (On an 8-pixel grid a 50 m river, one or two pixels wide, fell between the points and its
    // tile was never built.)
    const pick = (min: number) => {
      const out: [number, number][] = [];
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) if (a[j * 256 + i]! >= min) out.push([west + ((i + 0.5) / 256) * (east - west), north - ((j + 0.5) / 256) * (north - south)]);
      return out;
    };
    let probes = pick(140);
    if (probes.length < 4) probes = pick(15);
    if (!probes.length) return undefined;
    if (probes.length > 64) {
      const k = probes.length / 64;
      probes = Array.from({ length: 64 }, (_, i) => probes[Math.floor(i * k)]!);
    }
    const g0 = this.ground((south + north) / 2, (west + east) / 2) ?? 0;
    const sphere = new BoundingSphere(Cartesian3.fromRadians(centre.longitude, centre.latitude, g0), Math.hypot(size.x, size.y) / 2 + 60);
    const t: Tile = {
      z, x, y, west, east, south, north, size, frame, model: Matrix4.clone(frame), centre,
      origin: new Cartesian2((((west + east) / 2) * kx % 4096 + 4096) % 4096, (((south + north) / 2) * ky % 4096 + 4096) % 4096),
      occ: tex, probes, heights: new Float64Array(probes.length).fill(Number.NaN), changed: false, born: performance.now(), probeNext: 0, probedAt: 0, base: undefined,
      levels: new Float32Array(LEV * LEV), levelTex: undefined, horizon: new Array(16).fill(0), sphere, cut: new Cartesian4(2, 2, -1, -1), cmd: undefined, maskCmd: undefined,
    };
    if (z !== 13) this.cutFor(t);
    return t;
  }

  /** Our terrain, finest tiles loaded first. */
  private ground(lat: number, lon: number): number | undefined {
    return this.groundAt(lat, lon, 13) ?? this.groundAt(lat, lon, 11) ?? this.groundAt(lat, lon, 9);
  }

  /**
   * Google's water levels: height picks (0.8 ms a frame, 4 behind the loading screen) at the
   * probes in view, of tiles still without levels or measured more than 15 s ago.
   */
  private probe(cull: { computeVisibility(b: BoundingSphere): number }): void {
    // Heights are kept in Google's own (unshifted) frame, which needs the tiles' offset: probed
    // before it was measured they came out 38 m low (the Olt drawn under Google's ground).
    if (!this.google3d.offsetKnown) return;
    const t0 = performance.now(), budget = this.loading ? 4 : 0.8;
    for (const t of this.tiles.values()) {
      if (!t) continue;
      if (t.probeNext >= t.probes.length) {
        // Every 4 s in a tile's first minute (finer tiles arriving), then every 15 s.
        if (t.base === undefined || t0 - t.probedAt > (t0 - t.born < 60_000 ? 4000 : 15_000)) t.probeNext = 0;
        else continue;
      }
      if (cull.computeVisibility(t.sphere) === Intersect.OUTSIDE) continue;
      while (t.probeNext < t.probes.length && performance.now() - t0 < budget) {
        const k = t.probeNext++, [lon, lat] = t.probes[k]!;
        const o = this.ground(lat, lon);
        if (o === undefined) continue;
        probeSphere.center = Cartesian3.fromDegrees(lon, lat, t.base !== undefined ? t.base - this.google3d.offsetM : o, undefined, probeSphere.center);
        if (cull.computeVisibility(probeSphere) === Intersect.OUTSIDE) continue;
        const h = this.google3d.tileset.getHeight(Cartographic.fromDegrees(lon, lat), this.viewer.scene);
        // Water is never far below the terrain data (it records the water's surface); coarse tiles,
        // before the fine ones load, answered 30–40 m low and set rivers under Google's ground.
        // Above: reservoirs sit tens of metres over the valley floor in it.
        if (h !== undefined && Number.isFinite(h) && h > o - 8 && h < o + 60) {
          const v = h + this.google3d.offsetM, old = t.heights[k]!;
          // Changed (first answer, or a finer tile answering differently: coarse ones are tens of
          // metres off): this tile and its neighbours level again at the end of the pass.
          if (!(Math.abs(v - old) < 0.5)) t.changed = true;
          t.heights[k] = v;
        }
      }
      // A first estimate as soon as a few answers are in (a full pass takes a few seconds).
      if (t.base === undefined && t.probeNext < t.probes.length) {
        let n = 0;
        for (const h of t.heights) if (Number.isFinite(h)) n++;
        if (n >= 6) this.levelGrid(t);
      }
      if (t.probeNext >= t.probes.length) {
        t.probedAt = t0;
        if (t.changed || t.base === undefined) {
          t.changed = false;
          this.levelGrid(t);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const n = dx || dy ? this.tiles.get(`${t.z}/${t.x + dx}/${t.y + dy}`) : undefined;
              if (n) this.levelGrid(n);
            }
        }
      }
      if (performance.now() - t0 >= budget) return;
    }
  }

  /**
   * The 16×16 level grid: per cell the median of the answers within ~500 m (z13; a third of the
   * tile for far ones), else the nearest answer; a little above Google's water.
   */
  private levelGrid(t: Tile): boolean {
    const valid: { x: number; y: number; h: number }[] = [];
    const kx = 111_320 * Math.cos(t.centre.latitude), ky = 111_132;
    // Its own answers and its neighbours' (a lake crossing a tile edge: the side with few
    // probes, or none in view, levels from the other).
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = dx || dy ? this.tiles.get(`${t.z}/${t.x + dx}/${t.y + dy}`) : t;
        if (!n) continue;
        n.probes.forEach(([lon, lat], i) => {
          const h = n.heights[i]!;
          if (Number.isFinite(h)) valid.push({ x: (lon - t.west) * kx, y: (lat - t.south) * ky, h });
        });
      }
    const R = t.z === 13 ? 500 : t.size.x / 3;
    // The nearest answer counts only this close (not another lake's).
    const far = t.z === 13 ? 1500 : t.size.x * 0.6;
    const inside = valid.filter((v) => v.x > -far && v.y > -far && v.x < t.size.x + far && v.y < t.size.y + far);
    if (!inside.length) return false;
    const cell = new Float64Array(LEV * LEV);
    let base = Infinity;
    for (let j = 0; j < LEV; j++)
      for (let i = 0; i < LEV; i++) {
        const cx = ((i + 0.5) / LEV) * t.size.x, cy = ((j + 0.5) / LEV) * t.size.y;
        const near = inside.filter((v) => Math.hypot(v.x - cx, v.y - cy) < R).map((v) => v.h).sort((p, q) => p - q);
        let h: number;
        if (near.length) h = near[near.length >> 1]!;
        else {
          let best = Infinity;
          h = inside[0]!.h;
          for (const v of inside) {
            const d = Math.hypot(v.x - cx, v.y - cy);
            if (d < best) (best = d), (h = v.h);
          }
        }
        // 0.9 m above: Google's water mesh is noisy (±1 m), and close up, where the pull towards the
        // camera is small, it poked through ours in teal blotches.
        cell[j * LEV + i] = h + 0.9;
        base = Math.min(base, h + 0.9);
      }
    const first = t.base === undefined;
    t.base = base;
    for (let k = 0; k < cell.length; k++) t.levels[k] = cell[k]! - base;
    const context = (this.viewer.scene as unknown as { context: unknown }).context;
    (t.levelTex as { destroy?(): void } | undefined)?.destroy?.();
    t.levelTex = new C.Texture({
      context,
      width: LEV,
      height: LEV,
      pixelFormat: C.PixelFormat.RED,
      pixelDatatype: C.PixelDatatype.FLOAT,
      source: { arrayBufferView: t.levels },
      flipY: false,
      sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }),
    });
    this.place(t);
    if (first) {
      this.horizonOf(t);
      // Its neighbours without a level may take one from it now.
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const n = this.tiles.get(`${t.z}/${t.x + dx}/${t.y + dy}`);
          if (n && n.base === undefined) this.levelGrid(n);
        }
    }
    return true;
  }

  /** The highest elevation angle of our terrain in 16 directions from the tile's centre, to 8 km. */
  private horizonOf(t: Tile): void {
    const lat0 = Cesium.Math.toDegrees(t.centre.latitude), lon0 = Cesium.Math.toDegrees(t.centre.longitude);
    const kx = 111_320 * Math.cos(t.centre.latitude), ky = 111_132, h0 = t.base! - this.google3d.offsetM;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      let best = 0;
      for (let d = 300; d < 8000; d *= 1.18) {
        const h = this.groundAt(lat0 + (Math.cos(a) * d) / ky, lon0 + (Math.sin(a) * d) / kx, 12);
        if (h !== undefined) best = Math.max(best, Math.atan2(h - h0, d));
      }
      t.horizon[k] = best;
    }
  }

  /** The grid at its base level, as Google's tiles are drawn now (lowered by their offset). */
  private place(t: Tile): void {
    const h = t.base! - this.google3d.offsetM, f = t.frame;
    Matrix4.setTranslation(f, new Cartesian3(f[12]! + f[8]! * h, f[13]! + f[9]! * h, f[14]! + f[10]! * h), t.model);
    t.sphere.center = Cartesian3.fromRadians(t.centre.longitude, t.centre.latitude, h, undefined, t.sphere.center);
  }
  private placedOffset = Number.NaN;

  /** One tile's uniforms (all of them, in one place). */
  private uniforms(t: Tile, wind: Cartesian4): Record<string, () => unknown> {
    return { ...this.sky, u_origin: () => t.origin, u_tile: () => new Cartesian4(t.size.x, t.size.y, 0, 0), u_level: () => t.levelTex, u_occ: () => t.occ, u_cut: () => t.cut, u_wind: () => wind, u_normals: () => this.normals ?? this.blank(), u_body: () => this.body, u_glint: () => this.glint, u_hor: () => t.horizon, ...this.shadeUniforms() };
  }

  /** The clouds' shade (google3d.ts shade: as on the ground round the water). */
  private shadeUniforms(): Record<string, () => unknown> {
    const sh = this.google3d.shade, tex = () => this.google3d.shadeTextures();
    return { wfcShadow: () => tex().shadow, wfcDeckMap: () => tex().deck ?? this.blank(), wfcShadowP: () => sh.shadowP, wfcDeck0: () => sh.deck0, wfcDeck1: () => sh.deck1, wfcDeckP0: () => sh.deckP0, wfcDeckP1: () => sh.deckP1, wfcDeckH: () => sh.deckH };
  }

  /** Cesium primitive interface. */
  update(frameState: { commandList: unknown[]; context: unknown; cullingVolume: { computeVisibility(b: BoundingSphere): number }; passes: { render: boolean } }): void {
    if (!this.show || !frameState.passes.render) return;
    this.probe(frameState.cullingVolume);
    if (this.google3d.offsetM !== this.placedOffset) {
      this.placedOffset = this.google3d.offsetM;
      for (const t of this.tiles.values()) if (t && t.base !== undefined) this.place(t);
    }
    const context = frameState.context;
    if (!this.grid) {
      const v: number[] = [], idx: number[] = [];
      for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) v.push(i / (GRID - 1), j / (GRID - 1));
      for (let j = 0; j < GRID - 1; j++)
        for (let i = 0; i < GRID - 1; i++) {
          const a = j * GRID + i;
          idx.push(a, a + 1, a + GRID, a + 1, a + GRID + 1, a + GRID);
        }
      const vb = C.Buffer.createVertexBuffer({ context, typedArray: new Float32Array(v), usage: C.BufferUsage.STATIC_DRAW });
      const ib = C.Buffer.createIndexBuffer({ context, typedArray: new Uint16Array(idx), usage: C.BufferUsage.STATIC_DRAW, indexDatatype: C.IndexDatatype.UNSIGNED_SHORT });
      this.grid = { va: new C.VertexArray({ context, indexBuffer: ib, attributes: [{ index: 0, vertexBuffer: vb, componentsPerAttribute: 2, componentDatatype: C.ComponentDatatype.FLOAT }] }), count: idx.length };
    }
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
      for (const t of this.tiles.values()) if (t) t.maskCmd = undefined;
    }
    frameState.commandList.push(this.mask.clear);
    const w = this.wind, time = (performance.now() - this.t0) / 1000;
    const wind = new Cartesian4(w.dir.x, w.dir.y, w.strength, time);
    for (const t of this.tiles.values()) {
      if (!t || t.base === undefined || !t.levelTex) continue;
      if (frameState.cullingVolume.computeVisibility(t.sphere) === Intersect.OUTSIDE) continue;
      const make = (program: unknown, framebuffer?: unknown) =>
        new C.DrawCommand({
          vertexArray: this.grid!.va,
          primitiveType: C.PrimitiveType.TRIANGLES,
          shaderProgram: program,
          renderState: C.RenderState.fromCache(framebuffer ? { depthTest: { enabled: false }, depthMask: false, cull: { enabled: false } } : { depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } }),
          pass: C.Pass.OPAQUE,
          owner: this,
          modelMatrix: t.model,
          boundingVolume: t.sphere,
          count: this.grid!.count,
          ...(framebuffer ? { framebuffer } : {}),
          uniformMap: {},
        });
      if (!t.cmd) t.cmd = make(this.program);
      if (!t.maskCmd) t.maskCmd = make(this.maskProgram, this.mask.fb);
      const u = this.uniforms(t, wind);
      (t.cmd as Record<string, unknown>)["uniformMap"] = u;
      (t.maskCmd as Record<string, unknown>)["uniformMap"] = u;
      frameState.commandList.push(t.cmd, t.maskCmd);
    }
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    for (const t of this.tiles.values()) this.free(t);
    this.tiles.clear();
    (this.mask?.fb as { destroy?(): void } | undefined)?.destroy?.();
    this.mask = undefined;
    this.viewer.creditDisplay.removeStaticCredit(this.credit);
  }
}

/**
 * Rivers and canals from an OpenMapTiles tile's waterway lines, drawn into a 256² mask at
 * their width (OSM gives none in these tiles: rivers 40 m, canals 15 m; streams left out),
 * soft-edged, 230 where water. JRC Global Surface Water misses most rivers narrower than about
 * 60 m (the Olt at Feldioara: nothing); OSM's river *areas* cover whole gravel beds. Rivers only
 * the major ones (Water.majorRivers): OSM calls a brook a few metres wide a river too (the
 * Ghimbășel), and drawn 40 m wide, levelled from Google's tiles draped over the roofs round
 * it, it flooded the town.
 */
async function riverMask(url: string, z: number, latDeg: number, major: Set<string>): Promise<Uint8Array | undefined> {
  const r = await fetch(url);
  if (!r.ok) return undefined;
  const layers = decodeMvt(new Uint8Array(await r.arrayBuffer()));
  const mPerPx = (40_075_016 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** z / 256;
  const g = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
  g.lineCap = g.lineJoin = "round";
  g.strokeStyle = "#fff";
  let drawn = false;
  for (const l of layers) {
    if (l.name !== "waterway") continue;
    const k = 256 / l.extent;
    for (const f of l.features) {
      const w = { river: 40, canal: 15 }[String(f.properties["class"])];
      if (!w || f.properties["intermittent"] === 1) continue;
      if (f.properties["class"] === "river" && !major.has(String(f.properties["name"]))) continue;
      g.lineWidth = Math.max(1, w / mPerPx);
      g.beginPath();
      for (const line of f.geometry) line.forEach(([px, py], i) => (i ? g.lineTo(px! * k, py! * k) : g.moveTo(px! * k, py! * k)));
      g.stroke();
      drawn = true;
    }
  }
  if (!drawn) return undefined;
  const d = g.getImageData(0, 0, 256, 256).data, out = new Uint8Array(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(d[4 * i + 3]! * 0.9);
  return out;
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

const probeSphere = new BoundingSphere(new Cartesian3(), 5);
