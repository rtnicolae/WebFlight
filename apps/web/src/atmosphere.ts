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
 * The aerosol (Mie) is the day's boundary layer: as hazy as the humidity makes it up to the
 * convective top (the ground plus the weather's boundary-layer depth, where the cumulus
 * sit), 3% of that above: from above the layer its top is a line on the horizon. The
 * haze's strength from relative humidity (moist air hazes more: the particles swell):
 * visibility 180 km at 0%, ~140 km at 35%, ~104 km at 60%, ~45 km at 90% (at ~80 km the ground
 * went grey-blue under the haze and the ridges 30 km away vanished: the photos carry some haze
 * of their own).
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
const SKY_SCALE = 10, AP_SCALE = 4.5;
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

const COMPOSITE_FS = /* glsl */ `${COMMON}${SCENE_DIST_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_trans;
uniform sampler2D u_sky;
uniform sampler2D u_ap;
uniform vec3 u_east;
uniform vec3 u_north;
uniform vec3 u_up;
uniform vec3 u_sunL;
uniform float u_camR;
uniform vec2 u_scale;  // sky, haze
uniform vec2 u_disc;   // cos of the sun's angular radius, disc luminance
uniform float u_debug;
uniform vec2 u_tanHalf;
in vec2 v_textureCoordinates;

vec2 skyUv(vec3 d, float r) {
  float beta = acos(sqrt(max(r * r - BOT * BOT, 0.0)) / r), zh = PI - beta;
  float vz = acos(clamp(d.z, -1.0, 1.0));
  float v = vz < zh ? 0.5 * (1.0 - sqrt(max(1.0 - vz / zh, 0.0))) : 0.5 + 0.5 * sqrt(max((vz - zh) / beta, 0.0));
  float az = acos(clamp(dot(normalize(d.xy + vec2(1e-7, 0.0)), normalize(u_sunL.xy + vec2(1e-7, 0.0))), -1.0, 1.0));
  return vec2(az / PI, v);
}
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
    // Behind it only Cesium's stars (drawn by day too): seen once the sky is dark enough.
    float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    c.rgb = c.rgb * clamp(1.0 - skyLum * 40.0, 0.0, 1.0) + col;
  } else {
    vec4 ap = aerial(uv, dist / 1000.0);
    c.rgb = c.rgb * ap.a + ap.rgb * u_scale.y;
  }
  out_FragColor = c;
}`;

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
  private destroyed = false;

  constructor(
    private readonly viewer: Viewer,
    opts: AtmosphereOptions,
  ) {
    const scene = viewer.scene;
    const context = (scene as unknown as { context: unknown }).context;
    const params = new URLSearchParams(location.search);
    // Haze from the humidity (or ?vis=): the aerosol's extinction at the ground from the
    // visibility (Koschmieder, 3.912 / V), less the air's own (~0.0116 / km); 90% of it scattering.
    const visKm = params.has("vis") ? Number(params.get("vis")) : Math.min(200, Math.max(20, 180 * Math.pow(1 - opts.humidity, 0.6)));
    const mieExt = Math.max(0.002, 3.912 / visKm - 0.0116);
    const mie = new Cesium.Cartesian4(mieExt * 0.9, 1 / 0.9, opts.hazeTopM / 1000, opts.groundM / 1000);
    // The eye's adaptation as the sun goes down (no auto-exposure here): the twilight sky's
    // radiance falls by orders of magnitude, and at −2° ours was a dim brown where the eye sees
    // a glowing orange band. ×1 above 6°, ×6 by −4°; night stays dark (there is no light left).
    const tw = Math.min(1, Math.max(0, (6 - opts.sun.elevationDeg) / 10)), adapt = 1 + 5 * tw * tw * (3 - 2 * tw);
    const scale = new Cesium.Cartesian2((params.has("skyk") ? Number(params.get("skyk")) : SKY_SCALE) * adapt, (params.has("apk") ? Number(params.get("apk")) : AP_SCALE) * adapt);
    const sun = opts.sun, az = (sun.azimuthDeg * Math.PI) / 180, el = (sun.elevationDeg * Math.PI) / 180;
    this.u.sunL = new Cartesian3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    this.u.sunMu = Math.sin(el);

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
    }
    // (Compute commands go in the frame's command list; Cesium runs them first, in order.)
    frameState.commandList.push(...this.cmds.frame);
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
