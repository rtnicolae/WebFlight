/**
 * Volumetric cumulus, ray-marched in a full-screen pass (no hardware ray tracing: WebGL2).
 *
 * The same clouds as the sprite layer (clouds.ts: one cumulus per thermal, flat base at the
 * thermal's cloud base), drawn as volumes: for each pixel the view ray is tested against each
 * cloud's bounding sphere, and the few it hits are marched front to back, up to the scene's
 * depth (ground, glider, buildings in front stop it). Each cloud is a flat-based dome whose
 * radius shrinks with height, eroded by 3D value noise in the cloud's own frame (its shape
 * stays put as you fly by). Light, per step: a short march towards the sun (self-shadowing:
 * dark undersides, lit tops), a Henyey-Greenstein phase (the bright rim towards the sun),
 * the powder term (dark crevices), and the sky's light from above, darker below; integrated
 * energy-conserving (Hillaire 2015). Far clouds fade into the haze colour, then out.
 *
 * Shape: each cloud is 7 spheres (a big central tower, smaller ones round it) whose bottoms
 * reach below the cloud base, cut level there (the flat underside), eaten by billowy (folded)
 * value noise. Tried and dropped: one dome (smooth mushroom caps), a separate base slab (a
 * brim under each cloud), towers as columns (marshmallows), adaptive steps (−30 fps).
 * Measured in Brave on the M1 Pro, 1,500 m below a field of cumulus (10 July 2024, 15:00, near
 * Ghimbav), vsync off: 124 fps with these, 161 with the sprite puffs (~1.5 ms a frame); the
 * same from above the tops.
 */
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Intersect, PostProcessStage, type Viewer } from "cesium";
import type { CloudSpec } from "./clouds.ts";
import { LOOK } from "./lighting.ts";

/**
 * Tallest cloud [m above its base]: fair-weather cumulus seldom grow more than ~2 km; how much
 * higher they would go depends on the air above the cloud base, which the weather data here
 * doesn't give.
 */
export const MAX_TOWER_M = 2200;

/** Most clouds drawn (the nearest in view). */
const MAX = 96;

const FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
uniform vec4 u_c[${MAX}];   // base centre relative to the camera (world axes) [m], radius [m]
uniform vec4 u_d[${MAX}];   // height [m], opacity, noise seed, 0
uniform int u_n;
uniform vec3 u_up;          // the camera's up (world)
uniform vec3 u_E;           // and its east, north
uniform vec3 u_N;
uniform vec3 u_ambTop;
uniform vec3 u_ambBase;
uniform vec3 u_haze;
uniform vec2 u_fade;        // haze starts, cloud gone [m]
uniform float u_sigma;      // extinction per metre at density 1
uniform float u_steps;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 4; k++) {
    if (k >= oct) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

vec3 hash3(float n) {
  return fract(sin(vec3(n, n + 1.0, n + 2.0)) * vec3(43758.5453, 22578.1459, 19642.3490));
}

// A cumulus: BUBBLES towers, each a rounded top on straight sides down to the level base, eaten
// by billowy noise. Tower k: xy centre (local east/north), top-centre height, radius; worked
// out once per cloud per pixel (bubbles()).
#define BUBBLES 7
vec4 g_b[BUBBLES];
void bubbles(int i) {
  float R = u_c[i].w, H = u_d[i].x, seed = u_d[i].z;
  for (int k = 0; k < BUBBLES; k++) {
    vec3 rn = hash3(seed + float(k) * 7.13);
    vec2 c = k == 0 ? vec2(0.0) : (rn.xy * 2.0 - 1.0) * R * 0.6;
    // Sphere centres low enough that each reaches below the base: the level cut there is
    // the flat underside; the tops stay round.
    float br = R * (k == 0 ? 0.62 : 0.32 + 0.22 * rn.x);
    float cz = k == 0 ? H * 0.38 : min(br * 0.85, H * (0.15 + 0.35 * rn.z));
    g_b[k] = vec4(c, cz, br);
  }
}
// Density of cloud i at q (relative to its base centre, world axes), 0..1.
float density(int i, vec3 q, int oct) {
  float R = u_c[i].w, H = u_d[i].x;
  float h = dot(q, u_up);
  if (h < 0.0 || h > H) return 0.0;
  vec2 xy = vec2(dot(q, u_E), dot(q, u_N));
  float s = -1.0;
  for (int k = 0; k < BUBBLES; k++) {
    vec4 b = g_b[k];
    // Wide clouds under the height cap: towers squashed to fit (round tops, not cut ones).
    float vz = min(1.0, (H - b.z) / (b.w * 1.05));
    s = max(s, 1.0 - length(vec3(xy - b.xy, (h - b.z) * 1.05 / max(vz, 0.3))) / b.w);
  }
  if (s < -0.3) return 0.0;
  float hn = h / H;
  // Billowy noise (folded value noise): rounded lumps, the cauliflower of a cumulus.
  vec3 np = q / R * 3.2 + u_d[i].z;
  float n = 0.0, a = 0.5;
  for (int o = 0; o < 3; o++) {
    if (o >= oct) break;
    n += a * (1.0 - abs(2.0 * vnoise(np) - 1.0));
    np = np * 2.07 + vec3(3.1, 7.7, 1.3);
    a *= 0.5;
  }
  // A gentler rise than before (×2.6 made a hard, opaque surface: "solid" clouds).
  float d = s * 1.5 - (0.875 - n) * (0.9 + 0.6 * hn) + 0.1;
  if (d <= 0.0) return 0.0;
  // Fine erosion of the thin outer layer only: ragged, wispy edges round a dense core.
  if (oct >= 3 && d < 0.55) {
    float hf = 0.6 * vnoise(q / R * 16.0 + u_d[i].z * 1.7) + 0.4 * vnoise(q / R * 34.0 + 5.3);
    d -= (1.0 - smoothstep(0.0, 0.55, d)) * (1.0 - hf) * 0.5;
  }
  d = clamp(d, 0.0, 1.0);
  // Thin at the rim, dense inside.
  d *= d * (1.6 - 0.6 * d);
  // Level base: a short fade at the bottom only.
  d *= smoothstep(0.0, 0.025, hn);
  return d * u_d[i].y;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  if (u_n == 0) { out_FragColor = scene; return; }
  float depth = czm_readDepth(depthTexture, v_textureCoordinates);
  vec4 hitEC = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
  vec3 dirEC = normalize(hitEC.xyz / hitEC.w);
  float sceneT = depth >= 1.0 ? 1e9 : length(hitEC.xyz / hitEC.w);
  vec3 dir = normalize(czm_inverseViewRotation * dirEC);
  vec3 sun = czm_lightDirectionWC;
  float cosT = dot(dir, sun);
  float phase = mix(hg(cosT, 0.6), hg(cosT, -0.25), 0.3) * 4.0 * 3.14159265;

  // The clouds this ray passes through, nearest first (up to 4).
  float t0s[4] = float[4](1e9, 1e9, 1e9, 1e9);
  float t1s[4] = float[4](0.0, 0.0, 0.0, 0.0);
  int ids[4] = int[4](0, 0, 0, 0);
  int hits = 0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= u_n) break;
    float R = u_c[i].w, H = u_d[i].x;
    vec3 ctr = u_c[i].xyz + u_up * (H * 0.5);
    // Bubbles reach ~1.2 R out with their noise (a straight cut where this was 1.15).
    float rad = length(vec2(R * 1.3, H * 0.6));
    float b = dot(ctr, dir);
    float disc = b * b - dot(ctr, ctr) + rad * rad;
    if (disc <= 0.0) continue;
    float sq = sqrt(disc);
    float a0 = max(b - sq, 0.0), a1 = min(b + sq, sceneT);
    if (a1 <= a0) continue;
    // Insert by entry distance (the farthest of five drops out).
    if (hits == 4 && a0 >= t0s[3]) continue;
    int k = min(hits, 3);
    for (int j = 3; j > 0; j--) {
      if (j <= k && t0s[j - 1] > a0) { t0s[j] = t0s[j - 1]; t1s[j] = t1s[j - 1]; ids[j] = ids[j - 1]; k = j - 1; }
    }
    t0s[k] = a0; t1s[k] = a1; ids[k] = i;
    hits = min(hits + 1, 4);
  }
  if (hits == 0) { out_FragColor = scene; return; }

  vec3 lin = vec3(0.0);
  float T = 1.0;
  float firstT = -1.0;
  // Per-pixel start offset against banding, at half strength (full: a visible grain).
  float jit = 0.25 + 0.5 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 sunCol = czm_lightColor;
  for (int h = 0; h < 4; h++) {
    if (h >= hits || T < 0.02) break;
    int i = ids[h];
    float R = u_c[i].w, H = u_d[i].x;
    float a0 = t0s[h], a1 = t1s[h];
    bubbles(i);
    float dt = max((a1 - a0) / u_steps, R * 0.015);
    float t = a0 + dt * jit;
    for (int it = 0; it < 64; it++) {
      if (t >= a1) break;
      vec3 q = dir * t - u_c[i].xyz;
      float dens = density(i, q, 3);
      if (dens <= 0.0) { t += dt; continue; }
      float step = dt;
      if (firstT < 0.0) firstT = t;
      // Towards the sun: 4 steps, coarser noise.
      float od = 0.0, ls = R * 0.12;
      for (int s = 1; s <= 4; s++) od += density(i, q + sun * (ls * float(s) * float(s) * 0.5), 1) * ls * float(s);
      // Light scattered many times inside keeps the shadow side from going black
      // (Wrenninge's octaves, two of them).
      float tSun = max(exp(-u_sigma * od), 0.6 * exp(-0.25 * u_sigma * od));
      float hn = clamp(dot(q, u_up) / H, 0.0, 1.0);
      float powder = 1.0 - exp(-dens * 8.0);
      vec3 amb = mix(u_ambBase, u_ambTop, smoothstep(0.0, 0.8, hn));
      vec3 S = sunCol * tSun * phase * mix(0.6, 1.0, powder) + amb;
      float sE = u_sigma * dens;
      float tr = exp(-sE * step);
      lin += T * S * (1.0 - tr);
      T *= tr;
      if (T < 0.02) break;
      t += step;
    }
  }
  if (firstT < 0.0) { out_FragColor = scene; return; }
  // Into the haze, then gone.
  float hz = smoothstep(u_fade.x, u_fade.y, firstT);
  vec3 col = mix(lin, u_haze * (1.0 - T), clamp(hz * 1.2, 0.0, 1.0));
  float keep = 1.0 - smoothstep(u_fade.y * 0.85, u_fade.y, firstT);
  float a = (1.0 - T) * keep;
  col *= keep;
  out_FragColor = vec4(scene.rgb * (1.0 - a) + col, scene.a);
}
`;

interface Cloud {
  spec: CloudSpec;
  base: Cartesian3;
  radius: number;
  height: number;
  seed: number;
}

export class VolumetricClouds {
  private clouds: Cloud[] = [];
  private readonly c = Array.from({ length: MAX }, () => new Cartesian4());
  private readonly d = Array.from({ length: MAX }, () => new Cartesian4());
  private n = 0;
  private readonly up = new Cartesian3();
  private readonly east = new Cartesian3();
  private readonly north = new Cartesian3();
  readonly stage: PostProcessStage;

  constructor(private readonly viewer: Viewer) {
    const amb = LOOK.ambient;
    const self = this;
    this.stage = new PostProcessStage({
      fragmentShader: FS,
      uniforms: {
        u_c: () => (self.refresh(), self.c),
        u_d: () => self.d,
        u_n: () => self.n,
        u_up: () => self.up,
        u_E: () => self.east,
        u_N: () => self.north,
        // The sky's light on the tops, a grey-blue underside; dimmed with the day.
        // A little less sky light than the sun's: sunlit faces stand out from the shaded ones.
        u_ambTop: new Cartesian3(0.6 * amb[0]!, 0.67 * amb[1]!, 0.8 * amb[2]!),
        u_ambBase: new Cartesian3(0.3 * amb[0]!, 0.33 * amb[1]!, 0.4 * amb[2]!),
        u_haze: new Cartesian3(0.72 * LOOK.ground, 0.78 * LOOK.ground, 0.86 * LOOK.ground),
        u_fade: new Cartesian2(15_000, 70_000),
        u_sigma: 0.045,
        u_steps: 40,
      },
    });
    viewer.scene.postProcessStages.add(this.stage);
  }

  set(specs: CloudSpec[]): void {
    this.clouds = specs
      .filter((s) => s.size > 0 && s.opacity > 0)
      .map((spec) => {
        let h = 7919;
        for (const ch of spec.id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
        const r = (h % 1000) / 1000;
        // Wider than the thermal's figure (the sprite puffs spread past it too); towers as tall
        // as 0.8–1.4 times that.
        return { spec, base: Cartesian3.fromDegrees(spec.lonDeg, spec.latDeg, spec.baseM), radius: spec.radiusM * 1.4, height: Math.min(MAX_TOWER_M, spec.radiusM * 1.4 * (spec.tall ?? 0.8 + 0.6 * r)), seed: (h % 997) * 0.37 };
      });
  }

  /** Once per frame (from the uniform callback): the nearest clouds relative to the camera. */
  private stamp = -1;
  private refresh(): void {
    const fs = (this.viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState;
    if (fs.frameNumber === this.stamp) return;
    this.stamp = fs.frameNumber;
    const camera = this.viewer.camera, cam = camera.positionWC;
    Cartesian3.normalize(cam, this.up);
    // Only those in view (the ones behind cost a sphere test per pixel for nothing).
    const cull = camera.frustum.computeCullingVolume(cam, camera.directionWC, camera.upWC);
    const bs = new BoundingSphere();
    Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, this.up, this.east), this.east);
    Cartesian3.cross(this.up, this.east, this.north);
    const near = this.clouds
      .map((c) => ({ c, d: Cartesian3.distance(c.base, cam) }))
      .filter((x) => {
        if (x.d > 70_000) return false;
        const R = x.c.radius * x.c.spec.size, H = x.c.height * x.c.spec.size;
        Cartesian3.add(x.c.base, Cartesian3.multiplyByScalar(this.up, H * 0.5, bs.center), bs.center);
        bs.radius = Math.hypot(R * 1.3, H * 0.6) * 1.1;
        return cull.computeVisibility(bs) !== Intersect.OUTSIDE;
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX);
    this.n = near.length;
    near.forEach(({ c }, i) => {
      const s = c.spec.size;
      this.c[i]!.x = c.base.x - cam.x;
      this.c[i]!.y = c.base.y - cam.y;
      this.c[i]!.z = c.base.z - cam.z;
      this.c[i]!.w = c.radius * s;
      this.d[i]!.x = c.height * s;
      this.d[i]!.y = c.spec.opacity;
      this.d[i]!.z = c.seed;
    });
  }
}
