/**
 * One atmosphere for the sky and the haze on everything, after Hillaire (2020), "A Scalable and
 * Production Ready Sky and Atmosphere Rendering Technique": Rayleigh and Mie scattering and
 * ozone absorption in a spherical shell (radii 6,360 and 6,460 km), with multiple scattering
 * approximated per Hillaire, in four lookup tables made on the GPU:
 *  - transmittance (256×64) and multiple scattering (32×32): once per flight,
 *  - the sky as seen from the camera (192×108) and the aerial perspective (light scattered
 *    in and transmittance along the view rays, 32×32 directions × 32 distances to 200 km,
 *    as a 256×128 atlas): every frame.
 * One post-process pass (before the clouds) paints the sky and the sun's disc where nothing
 * is drawn, and hazes everything else by its distance from the depth buffer: Google's tiles,
 * the glider, the grass. Cesium's sky, sun and drawn fog are off (its fog still decides tile
 * detail).
 *
 * The aerosol (Mie) is the day's boundary layer: as hazy as the day's visibility up to the
 * convective top (the ground plus the weather's boundary-layer depth, where the cumulus
 * sit), 3% of that above: from above the layer its top is a line on the horizon. In clear air
 * the forecast's figure is only a lower bound and relative humidity sets it (moist air hazes
 * more: the particles swell): ~107 km at 20%, ~87 km at 35%, ~57 km at 60%, ~30 km at 80%;
 * murkier air (cloud, rain, fog) from the forecast (see hazeVisibilityKm).
 *
 * HDR only (hdr.ts), with Google's tiles: the sky and haze are radiances, scaled into the
 * scene's units (SKY_SCALE, AP_SCALE), and more as the sun goes down (the eye adapts). Stars
 * (Cesium's sky box) show through once the sky is dark. ?atm=0: Cesium's sky and fog as
 * before. Tuning: ?vis=<km>, ?skyk=, ?apk=; ?atmdbg=1 shows sky (red) and distance (green, 1 km
 * bands).
 *
 * Compared with Cesium's sky in the same views (10 July 2024, Brașov): no cyan band, distant
 * ridges blue-grey by distance instead of a flat fog, a warm horizon at sunset with the sun's
 * disc and a glowing band at dusk (Cesium's twilight dome drew a green arc at −12°), a dark
 * starry night. Cost within the noise (±3 fps).
 */
import * as Cesium from "cesium";
import { Cartesian3, Matrix4, PostProcessStage, Transforms, type Viewer } from "cesium";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

const BOT = 6360, TOP = 6460;
/** Aerial perspective reaches this far [km]; slices at (i+1)²/32² of it. */
const MAX_D = 200;
/**
 * Radiance → scene units, for the sky and for the haze on things (tuned by eye; the photos'
 * brightness fixes the second). The sky gets more: at the photos' scale it came out a dull
 * slate blue, darker than the ground, where photos and the eye see a bright blue. Distant
 * ridges then sit a little darker than the sky behind them, as they do.
 */
const SKY_SCALE = 10, AP_SCALE = 3;
/** Aerosol above the boundary layer, relative to in it. */
const ABOVE = 0.03;

export interface AtmosphereOptions {
  /** The sun at the place, for the flight's time. */
  sun: { azimuthDeg: number; elevationDeg: number };
  /** Ground height [m] and the convective boundary layer's top [m, sea level]. */
  groundM: number;
  hazeTopM: number;
  /** Relative humidity at the ground, 0–1. */
  humidity: number;
  /** The weather's visibility at the ground [km], if it has one. */
  visibilityKm?: number;
  /** High cloud cover, 0–1 (the weather's): a cirrus layer. */
  highCloud?: number;
  /** The wind aloft (the highest level the weather has): the cirrus's fibres and drift. */
  aloft?: { fromDeg: number; kt: number };
}

/**
 * GLSL: distance [m] from the camera to what is drawn at uv (1e9: nothing, the sky), from
 * Cesium's logarithmic depth directly. czm_readDepth turns it into perspective depth, which
 * with a 0.1 m near plane and a far plane thousands of km away has no precision left: the
 * distances came out as noise (rings of ±km), which hazed the cockpit like the far ridges
 * and cut the clouds against the terrain in a ragged pattern.
 */
export const SCENE_DIST_GLSL = /* glsl */ `
// The view ray through uv in eye coordinates, scaled to z = -1 (from the frustum's planes at
// the near distance, as czm_windowToEyeCoordinates does: czm_inverseProjection is not the
// camera's in a post-process pass).
vec3 wfEyeRay(vec2 uv) {
  vec4 fp = czm_frustumPlanes;   // top, bottom, left, right at the near distance
  float n = czm_currentFrustum.x;
  return vec3(mix(fp.z, fp.w, uv.x), mix(fp.y, fp.x, uv.y), -n) / n;
}
float wfSceneDist(sampler2D depthTex, vec2 uv) {
  float logZ = texture(depthTex, uv).r;
  if (logZ >= 1.0) return 1e9;
  float w = pow(2.0, logZ * czm_log2FarDepthFromNearPlusOne) - 1.0 + czm_currentFrustum.x;
  return w * length(wfEyeRay(uv));
}
`;

/**
 * GLSL: the aerial-perspective volume (u_ap) at screen position uv and distance d [km]: light
 * scattered in along the way (per unit sun; × the haze scale) in rgb, transmittance in a.
 * Also used by the clouds (vclouds.ts).
 */
export const AERIAL_GLSL = /* glsl */ `
uniform sampler2D u_ap;
vec4 apSlice(int i, vec2 tuv) {
  vec2 cell = vec2(float(i - (i / 8) * 8), float(i / 8));
  return texture(u_ap, (cell + tuv) / vec2(8.0, 4.0));
}
vec4 aerial(vec2 uv, float d) {
  float s = 32.0 * sqrt(clamp(d / ${MAX_D.toFixed(1)}, 0.0, 1.0)) - 1.0;
  vec2 tuv = clamp(uv, vec2(0.5 / 32.0), vec2(1.0 - 0.5 / 32.0));
  if (s < 0.0) return mix(vec4(0.0, 0.0, 0.0, 1.0), apSlice(0, tuv), s + 1.0);
  int i0 = int(floor(s));
  int i1 = min(i0 + 1, 31);
  return mix(apSlice(i0, tuv), apSlice(i1, tuv), s - float(i0));
}
`;

/**
 * GLSL: the sky's radiance (scene units) in a world direction, from the sky table, for other
 * passes (the water's reflection). Uniforms from Atmosphere.skyUniforms().
 */
export const SKY_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D u_wsky;
uniform float u_wcamR;
uniform vec3 u_wsunL;
uniform vec3 u_weast;
uniform vec3 u_wnorth;
uniform vec3 u_wup;
uniform float u_wskyk;
vec3 wfSkyRadiance(vec3 dirWC) {
  const float B = ${BOT.toFixed(1)}, P = 3.14159265358979;
  vec3 d = vec3(dot(dirWC, u_weast), dot(dirWC, u_wnorth), dot(dirWC, u_wup));
  float r = u_wcamR;
  float beta = acos(sqrt(max(r * r - B * B, 0.0)) / r), zh = P - beta;
  // Below the horizon: the horizon's (water reflects the sky down to it).
  float vz = min(acos(clamp(d.z, -1.0, 1.0)), zh - 0.002);
  float v = 0.5 * (1.0 - sqrt(max(1.0 - vz / zh, 0.0)));
  float az = acos(clamp(dot(normalize(d.xy + vec2(1e-7, 0.0)), normalize(u_wsunL.xy + vec2(1e-7, 0.0))), -1.0, 1.0));
  return texture(u_wsky, vec2(az / P, v)).rgb * u_wskyk;
}
`;

const COMMON = /* glsl */ `
const float PI = 3.14159265358979;
const float BOT = ${BOT.toFixed(1)};
const float TOP = ${TOP.toFixed(1)};
const vec3 RAY_S = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const vec3 OZONE_A = vec3(0.650e-3, 1.881e-3, 0.085e-3);
uniform vec4 u_mie;     // scattering per km in the layer, extinction ÷ scattering, layer top and ground [km above BOT]
uniform float u_above;  // aerosol above the layer (fraction)

float mieDensity(float h) {
  float inLayer = 1.0 - smoothstep(u_mie.z - 0.12, u_mie.z + 0.12, h);
  float layer = exp(-max(h - u_mie.w, 0.0) / 2.0);
  float above = u_above * exp(-max(h - u_mie.z, 0.0) / 1.5);
  return mix(above, layer, inLayer);
}
void medium(float h, out vec3 scatR, out float scatM, out vec3 ext) {
  float dR = exp(-max(h, 0.0) / 8.0);
  float dM = mieDensity(h);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  scatR = RAY_S * dR;
  scatM = u_mie.x * dM;
  ext = scatR + vec3(scatM * u_mie.y) + OZONE_A * dO;
}
float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float miePhase(float c) {
  const float g = 0.8;
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
}
// Distance from ro along rd to the sphere of radius R: the nearest ahead, negative if none.
float raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd), c = dot(ro, ro) - R * R, d = b * b - c;
  if (d < 0.0) return -1.0;
  float s = sqrt(d), t0 = -b - s;
  return t0 > 0.0 ? t0 : -b + s;
}
// Bruneton's transmittance parametrisation (radius, cosine of the zenith angle).
vec2 transUv(float r, float mu) {
  r = clamp(r, BOT + 1e-3, TOP);
  float H = sqrt(TOP * TOP - BOT * BOT);
  float rho = sqrt(max(0.0, r * r - BOT * BOT));
  float d = max(0.0, -r * mu + sqrt(max(0.0, r * r * (mu * mu - 1.0) + TOP * TOP)));
  float dmin = TOP - r, dmax = rho + H;
  return vec2((d - dmin) / max(dmax - dmin, 1e-6), rho / H);
}
`;

const SCATTER = /* glsl */ `
uniform sampler2D u_trans;
uniform sampler2D u_ms;
// Light scattered into the ray (per unit sun illuminance) over [0, tMax] km, and its
// transmittance (luminance-weighted, in w).
vec4 scatter(vec3 ro, vec3 rd, vec3 sun, float tMaxIn, int N) {
  float tB = raySphere(ro, rd, BOT), tT = raySphere(ro, rd, TOP);
  float tMax = tT;
  if (tB > 0.0) tMax = min(tMax, tB);
  tMax = min(tMax, tMaxIn);
  if (tMax <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float c = dot(rd, sun), pR = rayleighPhase(c), pM = miePhase(c);
  vec3 L = vec3(0.0), T = vec3(1.0);
  float t = 0.0;
  for (int i = 0; i < 40; i++) {
    if (i >= N) break;
    float k = (float(i) + 1.0) / float(N);
    float tn = tMax * k * k;
    float dt = tn - t, tm = t + 0.5 * dt;
    t = tn;
    vec3 p = ro + rd * tm;
    float rp = length(p);
    float muS = dot(p / rp, sun);
    vec3 sR, ext; float sM;
    medium(rp - BOT, sR, sM, ext);
    vec3 st = exp(-ext * dt);
    vec3 sunT = texture(u_trans, transUv(rp, muS)).rgb;
    float lit = raySphere(p, sun, BOT) > 0.0 ? 0.0 : 1.0;
    vec3 ms = texture(u_ms, vec2(muS * 0.5 + 0.5, (rp - BOT) / (TOP - BOT))).rgb;
    vec3 S = (sR * pR + vec3(sM * pM)) * sunT * lit + (sR + vec3(sM)) * ms;
    L += T * (S - S * st) / max(ext, vec3(1e-7));
    T *= st;
  }
  return vec4(L, dot(T, vec3(0.2126, 0.7152, 0.0722)));
}
`;

const TRANSMITTANCE_FS = /* glsl */ `${COMMON}
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  float H = sqrt(TOP * TOP - BOT * BOT);
  float rho = H * uv.y, r = sqrt(rho * rho + BOT * BOT);
  float dmin = TOP - r, dmax = rho + H, d = dmin + uv.x * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 ro = vec3(0.0, 0.0, r), rd = vec3(sqrt(1.0 - mu * mu), 0.0, mu);
  float tMax = raySphere(ro, rd, TOP);
  vec3 od = vec3(0.0);
  const int N = 48;
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 sR, ext; float sM;
    medium(length(ro + rd * (float(i) + 0.5) * dt) - BOT, sR, sM, ext);
    od += ext * dt;
  }
  out_FragColor = vec4(exp(-od), 1.0);
}`;

const MULTISCATTER_FS = /* glsl */ `${COMMON}
uniform sampler2D u_trans;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  float muS = uv.x * 2.0 - 1.0;
  float r = clamp(BOT + uv.y * (TOP - BOT), BOT + 0.01, TOP - 0.01);
  vec3 ro = vec3(0.0, 0.0, r), sun = vec3(sqrt(max(0.0, 1.0 - muS * muS)), 0.0, muS);
  vec3 lum = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  for (int i = 0; i < SQ; i++)
    for (int j = 0; j < SQ; j++) {
      float th = 2.0 * PI * (float(i) + 0.5) / float(SQ);
      float cp = 1.0 - 2.0 * (float(j) + 0.5) / float(SQ), sp = sqrt(1.0 - cp * cp);
      vec3 rd = vec3(sp * cos(th), sp * sin(th), cp);
      float tB = raySphere(ro, rd, BOT), tT = raySphere(ro, rd, TOP);
      bool ground = tB > 0.0;
      float tMax = ground ? tB : tT;
      const int N = 20;
      float dt = tMax / float(N);
      vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
      for (int k = 0; k < N; k++) {
        vec3 p = ro + rd * (float(k) + 0.5) * dt;
        float rp = length(p);
        vec3 sR, ext; float sM;
        medium(rp - BOT, sR, sM, ext);
        vec3 s = sR + vec3(sM);
        vec3 st = exp(-ext * dt);
        float mu = dot(p / rp, sun);
        vec3 sunT = texture(u_trans, transUv(rp, mu)).rgb * (raySphere(p, sun, BOT) > 0.0 ? 0.0 : 1.0);
        vec3 S = s * sunT / (4.0 * PI);
        L += T * (S - S * st) / max(ext, vec3(1e-7));
        F += T * (s - s * st) / max(ext, vec3(1e-7));
        T *= st;
      }
      if (ground) {
        vec3 pg = ro + rd * tB;
        float mu = dot(normalize(pg), sun);
        L += T * texture(u_trans, transUv(BOT + 0.001, mu)).rgb * max(mu, 0.0) * 0.3 / PI;
      }
      lum += L;
      fms += F;
    }
  float n = float(SQ * SQ);
  lum /= n;
  fms /= n;
  out_FragColor = vec4(lum / (1.0 - fms), 1.0);
}`;

const SKYVIEW_FS = /* glsl */ `${COMMON}${SCATTER}
uniform float u_camR;
uniform float u_sunMu;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  float r = u_camR;
  float beta = acos(sqrt(max(r * r - BOT * BOT, 0.0)) / r), zh = PI - beta;
  float vz;
  if (uv.y < 0.5) { float c = 1.0 - 2.0 * uv.y; c = 1.0 - c * c; vz = zh * c; }
  else { float c = uv.y * 2.0 - 1.0; vz = zh + beta * c * c; }
  float az = uv.x * PI;
  vec3 rd = vec3(sin(vz) * cos(az), sin(vz) * sin(az), cos(vz));
  vec3 sun = vec3(sqrt(max(0.0, 1.0 - u_sunMu * u_sunMu)), 0.0, u_sunMu);
  out_FragColor = vec4(scatter(vec3(0.0, 0.0, r), rd, sun, 1e9, 32).rgb, 1.0);
}`;

const AERIAL_FS = /* glsl */ `${COMMON}${SCATTER}
uniform float u_camR;
uniform vec3 u_sunL;
uniform vec3 u_fwd;
uniform vec3 u_right;
uniform vec3 u_upv;
uniform vec2 u_tanHalf;
void main() {
  vec2 px = gl_FragCoord.xy;
  int slice = int(px.x / 32.0) + 8 * int(px.y / 32.0);
  vec2 suv = mod(px, 32.0) / 32.0;
  vec3 rd = normalize(u_fwd + (2.0 * suv.x - 1.0) * u_tanHalf.x * u_right + (2.0 * suv.y - 1.0) * u_tanHalf.y * u_upv);
  float k = (float(slice) + 1.0) / 32.0;
  out_FragColor = scatter(vec3(0.0, 0.0, u_camR), rd, u_sunL, ${MAX_D.toFixed(1)} * k * k, 20);
}`;

const COMPOSITE_FS = /* glsl */ `${COMMON}${SCENE_DIST_GLSL}${AERIAL_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_trans;
uniform sampler2D u_sky;
uniform vec3 u_east;
uniform vec3 u_north;
uniform vec3 u_up;
uniform vec3 u_sunL;
uniform float u_camR;
uniform vec2 u_scale;  // sky, haze
uniform vec2 u_disc;   // cos of the sun's angular radius, disc luminance
uniform float u_debug;
uniform vec2 u_tanHalf;
uniform vec4 u_cirrus;   // cover 0–1, height [km], fibre direction [rad from east], drift [km]
uniform vec3 u_camEN;    // camera east/north of the flight's start [km]; brightness
uniform float u_hazeLight; // the light left for the air under the cloud decks (vclouds.ts)
in vec2 v_textureCoordinates;

vec2 skyUv(vec3 d, float r) {
  float beta = acos(sqrt(max(r * r - BOT * BOT, 0.0)) / r), zh = PI - beta;
  float vz = acos(clamp(d.z, -1.0, 1.0));
  float v = vz < zh ? 0.5 * (1.0 - sqrt(max(1.0 - vz / zh, 0.0))) : 0.5 + 0.5 * sqrt(max((vz - zh) / beta, 0.0));
  float az = acos(clamp(dot(normalize(d.xy + vec2(1e-7, 0.0)), normalize(u_sunL.xy + vec2(1e-7, 0.0))), -1.0, 1.0));
  return vec2(az / PI, v);
}
// Cirrus: a thin ice layer at u_cirrus.y, in patches where the weather's high cloud is, drawn
// out in fibres along the wind aloft (fibratus), with finer hooks; lit by the sun as it is at
// that height (white by day, pink at sunset), scattering forwards (a glow towards the sun),
// and by the sky above. Thinned towards the horizon, where it is far and in haze.
float ciHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ciNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ciHash(i), ciHash(i + vec2(1.0, 0.0)), f.x), mix(ciHash(i + vec2(0.0, 1.0)), ciHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float ciFbm(vec2 p, float octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) {
    float w = clamp(octaves - float(i), 0.0, 1.0);
    s += a * w * ciNoise(p);
    n += a * w;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.1, 3.7);
    a *= 0.5;
  }
  return s / max(n, 1e-3);
}
vec4 cirrus(vec3 d) {
  if (u_cirrus.x < 0.02 || d.z <= 0.0) return vec4(0.0);
  float t = raySphere(vec3(0.0, 0.0, u_camR), d, BOT + u_cirrus.y);
  if (t <= 0.0) return vec4(0.0);
  vec2 xy = d.xy * t + u_camEN.xy;
  vec2 ax = vec2(cos(u_cirrus.z), sin(u_cirrus.z)), ay = vec2(-ax.y, ax.x);
  vec2 w = vec2(dot(xy, ax) - u_cirrus.w, dot(xy, ay));
  // Fewer fine octaves far away (they would only sparkle).
  float oct = mix(5.0, 2.0, smoothstep(15.0, 120.0, t));
  // Where the layer is: patches covering the weather's share of the sky.
  float patches = ciFbm(w / 25.0, 3.0);
  float cov = smoothstep(1.0 - u_cirrus.x, 1.0 - u_cirrus.x + 0.22, (patches - 0.25) * 2.0);
  // Fibres, bent and broken: the coordinates warped by broad noise, streaks 5:1, in clumps.
  vec2 wp = w + vec2(2.0 * ciFbm(w / 9.0 + 4.1, 2.0), 3.0 * ciFbm(w / 7.0 + 9.3, 2.0) - 1.5);
  float fib = ciFbm(vec2(wp.x / 4.5, wp.y / 0.85), oct);
  float clump = smoothstep(0.35, 0.7, ciFbm(w / 6.0 + 2.7, 3.0));
  float hook = ciFbm(vec2(wp.x / 1.6 + 0.4 * wp.y, wp.y / 0.3), oct - 1.0);
  // A faint milky veil where it is overcast (cirrostratus), fibres in it.
  float veil = 0.4 * smoothstep(0.6, 1.0, u_cirrus.x) * (0.75 + 0.5 * ciFbm(w / 12.0 + 7.7, 3.0));
  float dens = cov * (veil + clump * smoothstep(0.45, 0.82, fib) * (0.5 + 0.5 * hook));
  float a = (1.0 - exp(-dens * 1.1)) * smoothstep(0.0, 0.12, d.z);
  if (a <= 0.001) return vec4(0.0);
  float cs = dot(d, u_sunL);
  vec3 sunT = texture(u_trans, transUv(BOT + u_cirrus.y, u_sunL.z)).rgb * smoothstep(-0.08, 0.0, u_sunL.z);
  const float g = 0.65;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cs, 1.5);
  vec3 above = texture(u_sky, skyUv(vec3(0.0, 0.0, 1.0), u_camR)).rgb;
  vec3 L = sunT * (0.25 + 0.75 * hg) * 0.11 * u_camEN.z + above * 0.9;
  return vec4(L, a);
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  float dist = wfSceneDist(depthTexture, uv);
  vec3 dw = normalize(czm_inverseViewRotation * normalize(wfEyeRay(uv)));
  vec3 d = vec3(dot(dw, u_east), dot(dw, u_north), dot(dw, u_up));
  bool sky = dist >= 1e8;
  if (u_debug > 0.5) { out_FragColor = vec4(sky ? 1.0 : 0.0, fract(dist / 1000.0), clamp(dist / 50000.0, 0.0, 1.0), 1.0); return; }
  if (sky) {
    vec3 col = texture(u_sky, skyUv(d, u_camR)).rgb * u_scale.x;
    float cs = dot(d, u_sunL);
    if (cs > u_disc.x && raySphere(vec3(0.0, 0.0, u_camR), d, BOT) < 0.0) {
      float rr = sqrt(max(0.0, 1.0 - cs * cs)) / sqrt(1.0 - u_disc.x * u_disc.x);
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - rr * rr)));
      col += texture(u_trans, transUv(u_camR, d.z)).rgb * u_disc.y * limb;
    }
    // The cirrus in front of the sky (and the sun).
    vec4 ci = cirrus(d);
    col = col * (1.0 - ci.a) + ci.rgb * u_scale.x * ci.a;
    // Behind it only Cesium's stars (drawn by day too): seen once the sky is dark enough.
    float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    c.rgb = c.rgb * clamp(1.0 - skyLum * 40.0, 0.0, 1.0) + col;
  } else {
    vec4 ap = aerial(uv, dist / 1000.0);
    c.rgb = c.rgb * ap.a + ap.rgb * u_scale.y * u_hazeLight;
  }
  out_FragColor = c;
}`;

/**
 * The haze's visibility [km], from the forecast's where it has one (Open-Meteo; over Europe
 * ICON's, DWD's diagnosis).
 *
 * In clear air ICON's figure is one fixed curve of humidity: 40.4–40.9 km at 50–59% at Ghimbav,
 * Cluj, Bucharest, Munich and Berlin alike (Aug–Nov 2026), ~50 km at 25%, never above ~60 km. It
 * knows nothing of the day's aerosol there, so from 35 km up it is read as "that or clearer"
 * (owner, 2026-11-20) and the haze is the clearer of it and the humidity's figure below; 35 km
 * is where the two curves cross (~77%). Under that, moist air, cloud, rain or fog bring it down
 * and it is taken as it is (below ~1 km it is fog, which this haze layer can't draw). GFS
 * reports 24.14 km (15 statute miles) for anything clearer: also only a lower bound.
 *
 * Without one (the reanalysis has none), from the humidity: ~107 km at 20%, ~57 km at 60%, ~30
 * km at 80% (owner, 2026-11-18: "reduce the haze a bit" at 60 km on 10 July 2024).
 */
export function hazeVisibilityKm(humidity: number, forecastKm?: number): number {
  const fromHumidity = Math.min(160, Math.max(20, 130 * Math.pow(1 - humidity, 0.9)));
  if (forecastKm === undefined || !Number.isFinite(forecastKm)) return fromHumidity;
  if (forecastKm >= 35 || Math.abs(forecastKm - 24.14) < 0.005) return Math.min(160, Math.max(forecastKm, fromHumidity));
  return Math.max(1, forecastKm);
}

/** Relative humidity from temperature and dew point (Magnus). */
export function relativeHumidity(tempC: number, dewC: number): number {
  const es = (t: number) => Math.exp((17.62 * t) / (243.12 + t));
  return Math.min(1, Math.max(0, es(dewC) / es(tempC)));
}

export class Atmosphere {
  readonly stage: PostProcessStage;
  readonly tex: Record<"trans" | "ms" | "sky" | "ap", unknown>;
  private readonly cmds: { once: unknown[]; frame: unknown[] };
  private onceDone = false;
  private readonly u = {
    camR: BOT + 0.5,
    sunMu: 1,
    sunL: new Cartesian3(0, 0, 1),
    east: new Cartesian3(1, 0, 0),
    north: new Cartesian3(0, 1, 0),
    up: new Cartesian3(0, 0, 1),
    fwd: new Cartesian3(0, 1, 0),
    right: new Cartesian3(1, 0, 0),
    upv: new Cartesian3(0, 0, 1),
    tanHalf: new Cesium.Cartesian2(1, 1),
  };
  private readonly saved: { sky: boolean; sun: boolean; fog: boolean };
  private baseScale: { sky: number; ap: number } = { sky: SKY_SCALE, ap: AP_SCALE };
  /** Sky and haze scale into scene units (with the twilight adaptation). */
  readonly scale: Cesium.Cartesian2;
  /** The light left for the air under the cloud decks, 0–1 (vclouds.ts sets it each frame). */
  hazeLight = 1;
  private ambientCache: { top: number[]; horizon: number[] } | undefined;
  /** The cirrus layer (see COMPOSITE_FS) and where the camera is in it. */
  private readonly cirrus = new Cesium.Cartesian4();
  private readonly camEN = new Cartesian3();
  private origin: { lat: number; lon: number } | undefined;
  private cirrusSpeed = 0;
  private destroyed = false;

  constructor(
    private readonly viewer: Viewer,
    opts: AtmosphereOptions,
  ) {
    const scene = viewer.scene;
    const context = (scene as unknown as { context: unknown }).context;
    const params = new URLSearchParams(location.search);
    const mie = this.mie;
    // Sky and haze into scene units; the sun sets the eye's adaptation on top (setSun).
    this.baseScale = { sky: params.has("skyk") ? Number(params.get("skyk")) : SKY_SCALE, ap: params.has("apk") ? Number(params.get("apk")) : AP_SCALE };
    const scale = (this.scale = new Cesium.Cartesian2());
    this.setSun(opts.sun);
    this.setAir(opts);
    this.camEN.z = params.has("cik") ? Number(params.get("cik")) : 1;

    const make = (w: number, h: number) =>
      new C.Texture({
        context,
        width: w,
        height: h,
        pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: C.PixelDatatype.HALF_FLOAT,
        sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }),
      });
    this.tex = { trans: make(256, 64), ms: make(32, 32), sky: make(192, 108), ap: make(256, 128) };
    const t = this.tex, u = this.u;
    const base = { u_mie: () => mie, u_above: () => ABOVE, u_trans: () => t.trans, u_ms: () => t.ms };
    const cmd = (fs: string, out: unknown, uniformMap: Record<string, () => unknown>) => new C.ComputeCommand({ fragmentShaderSource: fs, outputTexture: out, uniformMap: { ...base, ...uniformMap }, persists: true, owner: this });
    this.cmds = {
      once: [cmd(TRANSMITTANCE_FS, t.trans, {}), cmd(MULTISCATTER_FS, t.ms, {})],
      frame: [
        cmd(SKYVIEW_FS, t.sky, { u_camR: () => u.camR, u_sunMu: () => u.sunMu }),
        cmd(AERIAL_FS, t.ap, { u_camR: () => u.camR, u_sunL: () => u.sunL, u_fwd: () => u.fwd, u_right: () => u.right, u_upv: () => u.upv, u_tanHalf: () => u.tanHalf }),
      ],
    };
    // The sun's disc: 0.267° radius; bright enough to bloom.
    const disc = new Cesium.Cartesian2(Math.cos((0.267 * Math.PI) / 180), 60);
    this.stage = new PostProcessStage({
      fragmentShader: COMPOSITE_FS,
      pixelDatatype: C.PixelDatatype.HALF_FLOAT,
      uniforms: {
        u_mie: () => mie,
        u_above: () => ABOVE,
        u_trans: () => t.trans,
        u_sky: () => t.sky,
        u_ap: () => t.ap,
        u_east: () => u.east,
        u_north: () => u.north,
        u_up: () => u.up,
        u_sunL: () => u.sunL,
        u_camR: () => u.camR,
        u_scale: () => scale,
        u_disc: () => disc,
        u_debug: () => (params.get("atmdbg") === "1" ? 1 : 0),
        u_tanHalf: () => u.tanHalf,
        u_cirrus: () => this.cirrus,
        u_camEN: () => this.camEN,
        u_hazeLight: () => this.hazeLight,
      },
    });
    this.saved = { sky: scene.skyAtmosphere?.show ?? false, sun: scene.sun?.show ?? false, fog: scene.fog.renderable };
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    scene.fog.renderable = false;
    scene.primitives.add(this);
    scene.postProcessStages.add(this.stage);
  }

  /** Cesium primitive interface: the lookup tables' compute commands, and this frame's camera. */
  update(frameState: { commandList: unknown[] }): void {
    const cam = this.viewer.camera, u = this.u;
    const h = cam.positionCartographic.height / 1000;
    // Where the camera is over the cirrus's ground (km from the flight's start), and its drift.
    const pc = cam.positionCartographic, lat = (pc.latitude * 180) / Math.PI, lon = (pc.longitude * 180) / Math.PI;
    this.origin ??= { lat, lon };
    this.camEN.x = ((lon - this.origin.lon) * 111.32 * Math.cos((this.origin.lat * Math.PI) / 180));
    this.camEN.y = (lat - this.origin.lat) * 111.132;
    const now = performance.now();
    this.cirrusDrift += ((now - this.cirrusT) / 1000) * this.cirrusSpeed;
    this.cirrusT = now;
    this.cirrus.w = this.cirrusDrift;
    u.camR = BOT + Math.max(0.005, h);
    const enu = Transforms.eastNorthUpToFixedFrame(cam.positionWC, undefined, new Matrix4());
    u.east = Cartesian3.fromElements(enu[0]!, enu[1]!, enu[2]!, u.east);
    u.north = Cartesian3.fromElements(enu[4]!, enu[5]!, enu[6]!, u.north);
    u.up = Cartesian3.fromElements(enu[8]!, enu[9]!, enu[10]!, u.up);
    const local = (w: Cartesian3, out: Cartesian3) => Cartesian3.fromElements(Cartesian3.dot(w, u.east), Cartesian3.dot(w, u.north), Cartesian3.dot(w, u.up), out);
    local(cam.directionWC, u.fwd);
    local(cam.rightWC, u.right);
    local(cam.upWC, u.upv);
    const f = cam.frustum as unknown as { fovy: number; aspectRatio: number };
    const ty = Math.tan(f.fovy / 2);
    u.tanHalf = new Cesium.Cartesian2(ty * f.aspectRatio, ty);
    if (!this.onceDone) {
      frameState.commandList.push(...this.cmds.once);
      this.onceDone = true;
    } else if (++this.framesSince > 2 && performance.now() - this.ambientAt > 10_000) this.readAmbient();
    // (Compute commands go in the frame's command list; Cesium runs them first, in order.)
    frameState.commandList.push(...this.cmds.frame);
  }

  /**
   * For SKY_LOOKUP_GLSL elsewhere (the water's reflection): the sky table and the camera's
   * frame, current for this frame.
   */
  skyUniforms(): Record<string, () => unknown> {
    const u = this.u;
    return { u_wsky: () => this.tex.sky, u_wcamR: () => u.camR, u_wsunL: () => u.sunL, u_weast: () => u.east, u_wnorth: () => u.north, u_wup: () => u.up, u_wskyk: () => this.scale.x };
  }

  /**
   * The sun where it is now (main.ts, as the flight's clock moves it): the sky and the haze are
   * computed with it from the next frame, and the eye's adaptation follows its height. The
   * cirrus, the sun's disc and the sky's light on the clouds (read back every 10 s) follow too.
   */
  setSun(sun: { azimuthDeg: number; elevationDeg: number }): void {
    // The eye's adaptation as the sun goes down (no auto-exposure here): the twilight sky's
    // radiance falls by orders of magnitude, and at −2° ours was a dim brown where the eye sees
    // a glowing orange band. ×1 above 6°, ×6 by −4°; night stays dark (there is no light left).
    const tw = Math.min(1, Math.max(0, (6 - sun.elevationDeg) / 10)), adapt = 1 + 5 * tw * tw * (3 - 2 * tw);
    this.scale.x = this.baseScale.sky * adapt;
    this.scale.y = this.baseScale.ap * adapt;
    const az = (sun.azimuthDeg * Math.PI) / 180, el = (sun.elevationDeg * Math.PI) / 180;
    this.u.sunL = new Cartesian3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    this.u.sunMu = Math.sin(el);
  }

  /**
   * The air now (main.ts, as the flight's clock moves the weather on): the haze's strength and
   * depth, the cirrus's cover and drift. The tables that depend on the haze (the sun's light
   * through the air, multiple scattering) are made again with the next frame.
   */
  setAir(o: Pick<AtmosphereOptions, "humidity" | "visibilityKm" | "hazeTopM" | "groundM" | "highCloud" | "aloft">): void {
    const params = new URLSearchParams(location.search);
    // The aerosol's extinction at the ground from the visibility (Koschmieder, 3.912 / V), less
    // the air's own (~0.0116 / km); 90% of it scattering. ?vis= tries a visibility.
    const visKm = params.has("vis") ? Number(params.get("vis")) : hazeVisibilityKm(o.humidity, o.visibilityKm);
    const mieExt = Math.max(0.002, 3.912 / visKm - 0.0116);
    this.mie.x = mieExt * 0.9;
    this.mie.y = 1 / 0.9;
    this.mie.z = o.hazeTopM / 1000;
    this.mie.w = o.groundM / 1000;
    // Cirrus from the weather's high cloud (?cirrus=0..1 to try a cover), at 9 km, fibres
    // along the wind aloft and drifting with it.
    const to = (((o.aloft?.fromDeg ?? 270) + 180) * Math.PI) / 180;
    this.cirrus.x = params.has("cirrus") ? Number(params.get("cirrus")) : o.highCloud ?? 0;
    this.cirrus.y = 9;
    this.cirrus.z = Math.atan2(Math.cos(to), Math.sin(to));
    // Upper winds are stronger than the highest level we have (700 hPa): ×1.8, at least 10 m/s.
    this.cirrusSpeed = Math.max(10, 1.8 * (o.aloft?.kt ?? 20) * 0.514) / 1000;
    this.onceDone = false;
  }
  /** The aerosol (COMMON's u_mie): scattering per km, extinction ÷ scattering, layer top, ground [km]. */
  private readonly mie = new Cesium.Cartesian4();
  /** The cirrus's drift so far [km along its wind] (it adds up: its speed changes with the day). */
  private cirrusDrift = 0;
  private cirrusT = performance.now();

  /** The aerial-perspective volume (for AERIAL_GLSL elsewhere). */
  get apTexture(): unknown {
    return this.tex.ap;
  }

  /**
   * The sky's light round the camera in scene units: at the zenith and along the horizon
   * (averaged round it); undefined until read. Read back in update() (before anything is drawn
   * that frame) a few frames in and every 10 s after (the camera moves: the first read came
   * before it was in place, from a dark sky), kept even when it is zero (night).
   * It used to be read from the clouds' uniform callback, inside their pass, every frame until
   * non-zero: at night that was every frame, and the readback's framebuffer binding left
   * Cesium's state wrong: the cloud pass drew black over the whole screen.
   */
  skyAmbient(): { top: number[]; horizon: number[] } | undefined {
    return this.ambientCache;
  }
  private framesSince = 0;
  private ambientAt = -1e9;
  /** Bumped each time the sky's light is read again. */
  ambientVersion = 0;
  private readAmbient(): void {
    this.ambientAt = performance.now();
    this.ambientVersion++;
    const k = this.scale.x;
    const top = this.readTexel("sky", 96, 0).slice(0, 3).map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
    const hor = [0, 0, 0];
    for (const x of [0, 48, 96, 144, 191]) this.readTexel("sky", x, 52).forEach((v, i) => i < 3 && (hor[i]! += (Number.isFinite(v) ? Math.max(0, v) : 0) / 5));
    this.ambientCache = { top: top.map((v) => v * k), horizon: hor.map((v) => v * k) };
  }

  /** Debugging: one texel of a lookup table (raw values). */
  readTexel(name: keyof Atmosphere["tex"], x: number, y: number): number[] {
    const context = (this.viewer.scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context;
    const fb = new C.Framebuffer({ context, colorTextures: [this.tex[name]], destroyAttachments: false });
    fb._bind();
    const gl = context._gl, p = new Float32Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, p);
    fb._unBind();
    fb.destroy();
    // Cesium caches which framebuffer it has bound and skips binding it again: after ours it
    // would draw into the wrong one.
    (context as unknown as { _currentFramebuffer?: unknown })._currentFramebuffer = undefined;
    return Array.from(p);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const scene = this.viewer.scene;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = this.saved.sky;
    if (scene.sun) scene.sun.show = this.saved.sun;
    scene.fog.renderable = this.saved.fog;
    for (const c of [...this.cmds.once, ...this.cmds.frame]) (c as { shaderProgram?: { destroy(): void } }).shaderProgram?.destroy();
    for (const t of Object.values(this.tex)) (t as { destroy(): void }).destroy();
  }
}
