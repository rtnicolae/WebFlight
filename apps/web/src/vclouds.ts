/**
 * Volumetric cumulus, ray-marched in a full-screen pass (no hardware ray tracing: WebGL2).
 *
 * The same clouds as the sprite layer (clouds.ts: one cumulus per thermal, flat base at the
 * thermal's cloud base), drawn as volumes out to 45 km: for each pixel the view ray is tested
 * against each cloud's bounding sphere, and the few it hits are marched front to back, up to
 * the scene's depth (ground, glider, buildings in front stop it).
 *
 * Shape (after Schneider 2015 / Nubis): each cloud is 7 towers (a big central one, smaller
 * round it; laid out here, cloudTowers(), shared with the cloud shadows) that set where cloud
 * may be, cut level at the base. Inside, tileable Perlin–Worley noise (cloud-noise.ts, a 3D
 * texture in the cloud's own frame) makes the cauliflower: towards the towers' edges only its
 * highest values survive, so the edges are billows, not a sphere. World-scale Worley detail
 * erodes what is left: wisps at the base, rounded billows above.
 *
 * Light, per step: a short march towards the sun (self-shadowing), three octaves of multiple
 * scattering (Wrenninge 2013: each octave lets more light through, scatters less and less
 * forwards: bright, milky interiors instead of grey), a two-lobe phase (the silver lining
 * towards the sun), the powder term (dark crevices), and the sky's light (the atmosphere's,
 * atmosphere.ts) from above, darker below; integrated energy-conserving (Hillaire 2015). With
 * the atmosphere the clouds get its aerial perspective too: far clouds fade blue into the same
 * air as the ground under them.
 *
 * Drawn at half resolution, then blended over the scene at full resolution with a small
 * depth-aware filter. Farther clouds take fewer steps and no detail.
 */
import * as Cesium from "cesium";
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Intersect, PixelDatatype, PostProcessStage, PostProcessStageComposite, type Viewer } from "cesium";
import type { CloudSpec } from "./clouds.ts";
import { LOOK } from "./lighting.ts";
import { temporal } from "./temporal.ts";
import { AERIAL_GLSL, SCENE_DIST_GLSL, type Atmosphere } from "./atmosphere.ts";
import { cloudNoiseAsync } from "./cloud-noise.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

/**
 * Tallest cloud [m above its base]: fair-weather cumulus seldom grow more than ~2 km; how much
 * higher they would go depends on the air above the cloud base, which the weather data here
 * doesn't give.
 */
export const MAX_TOWER_M = 2200;

/** Most clouds drawn (the nearest in view). */
const MAX = 128;
/** Towers per cloud. */
const TOWERS = 7;
/** Clouds farther than this are not drawn as volumes [m]. */
export const VOLUME_RANGE_M = 45_000;

/** A cloud's size [m] and its towers: east, north, centre height, radius [m] (TOWERS × 4). */
export interface CloudGeometry {
  radius: number;
  /** Horizontal reach of the cloud from its centre [m]. */
  reach: number;
  height: number;
  seed: number;
  towers: Float32Array;
}

/** Deterministic: the same cloud (spec id) gets the same towers in the volume and its shadow. */
export function cloudGeometry(spec: CloudSpec): CloudGeometry {
  let h = 7919;
  for (const ch of spec.id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  const rnd = (() => {
    let s = h || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  })();
  const r = rnd();
  // Wider than the thermal's figure (the sprite puffs spread past it too); towers as tall as
  // 0.8–1.4 times that.
  const R = spec.radiusM * 1.4 * spec.size, H = Math.min(MAX_TOWER_M, spec.radiusM * 1.4 * (spec.tall ?? 0.8 + 0.6 * r)) * spec.size;
  const towers = new Float32Array(TOWERS * 4);
  for (let k = 0; k < TOWERS; k++) {
    const a = 6.2831853 * rnd(), rr = Math.sqrt(rnd()), z = rnd(), sz = rnd();
    // Tower centres within a disc of 0.65 R (beyond, they poked out of the ray-test sphere).
    const br = R * (k === 0 ? 0.62 : 0.32 + 0.22 * sz);
    // Centres low enough that each reaches below the base: the level cut there is the flat
    // underside; the tops stay round.
    const cz = k === 0 ? H * 0.38 : Math.min(br * 0.85, H * (0.15 + 0.35 * z));
    towers.set([k === 0 ? 0 : rr * R * 0.65 * Math.cos(a), k === 0 ? 0 : rr * R * 0.65 * Math.sin(a), cz, br], k * 4);
  }
  // How far out cloud can be: each tower's centre distance plus its radius, and the noise's
  // reach beyond (density is zero where the towers' field is below −0.3).
  let reach = 0;
  for (let k = 0; k < TOWERS; k++) reach = Math.max(reach, Math.hypot(towers[k * 4]!, towers[k * 4 + 1]!) + towers[k * 4 + 3]! * 1.3);
  return { radius: R, height: H, seed: (h % 997) * 0.0137, towers, reach };
}

const FS = /* glsl */ `${SCENE_DIST_GLSL}${AERIAL_GLSL}
precision highp sampler3D;
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
uniform sampler3D u_shape;
uniform sampler3D u_detail;
uniform sampler2D u_towers;   // TOWERS × MAX: east, north, centre height, radius [m]
uniform vec4 u_c[${MAX}];     // base centre relative to the camera (world axes) [m], radius [m]
uniform vec4 u_d[${MAX}];     // height [m], opacity, noise offset, reach (bounding radius) [m]
#define SLOTS 6
uniform int u_n;
uniform vec3 u_up;            // the camera's up (world)
uniform vec3 u_E;             // and its east, north
uniform vec3 u_N;
uniform vec3 u_ambTop;
uniform vec3 u_ambBase;
uniform vec4 u_light;
uniform float u_frame;       // frame number (mod 64) while TAA runs, else 0         // extinction per m at density 1, sun scale, sky scale, steps
uniform vec3 u_haze;          // without the atmosphere: the haze colour far clouds fade to
uniform vec2 u_fade;          // haze starts, cloud gone [m]
uniform vec2 u_ap0;           // with the atmosphere: haze scale, 1
uniform float u_ready;
uniform vec4 u_form;          // density scale, detail erosion, shape tile ÷ radius, detail tile [m]

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

vec4 g_b[${TOWERS}];
void towers(int i) {
  for (int k = 0; k < ${TOWERS}; k++) g_b[k] = texelFetch(u_towers, ivec2(k, i), 0);
}
// Density of cloud i at q (relative to its base centre, world axes).
float density(int i, vec3 q, bool detail) {
  float R = u_c[i].w, H = u_d[i].x;
  float h = dot(q, u_up);
  if (h < 0.0 || h > H) return 0.0;
  vec2 xy = vec2(dot(q, u_E), dot(q, u_N));
  float s = -1.0;
  for (int k = 0; k < ${TOWERS}; k++) {
    vec4 b = g_b[k];
    // Wide clouds under the height cap: towers squashed to fit (round tops, not cut ones).
    float vz = min(1.0, (H - b.z) / (b.w * 1.05));
    // (Clamped at 0.3 before: low wide clouds had their tower tops sliced flat by the height
    // cap, like pills.)
    s = max(s, 1.0 - length(vec3(xy - b.xy, (h - b.z) * 1.05 / max(vz, 0.1))) / b.w);
  }
  if (s < -0.3) return 0.0;
  float hn = h / H;
  // Where cloud may be: 1 deep in the towers, 0 a little outside them.
  float cov = clamp(s * 1.4 + 0.4, 0.0, 1.0);
  // Perlin–Worley in the cloud's own frame, about a tile per cloud.
  vec4 sn = texture(u_shape, vec3(xy, h) / (R * u_form.z) + u_d[i].z);
  float wf = sn.g * 0.625 + sn.b * 0.25 + sn.a * 0.125;
  float base = remap(sn.r, wf - 1.0, 1.0, 0.0, 1.0);
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (d <= 0.0) return 0.0;
  if (detail) {
    // World-scale wisps (~260 m tile): ragged at the base, billowy above.
    vec3 dn = texture(u_detail, q / u_form.w + u_d[i].z * 3.1).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float dm = mix(1.0 - df, df, clamp(hn * 4.0, 0.0, 1.0));
    d = remap(d, dm * u_form.y, 1.0, 0.0, 1.0);
  }
  // Dense right behind the surface: crisp edges (real cumulus are), soft only where eroded.
  // Level base: a short fade at the bottom only.
  d = clamp(d * u_form.x, 0.0, 1.0) * smoothstep(0.0, 0.03, hn);
  return d * u_d[i].y;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}
// Two lobes (the bright rim towards the sun, a little back-scatter), relative to isotropic.
float phase2(float c, float e) {
  return mix(hg(c, 0.8 * e), hg(c, -0.25 * e), 0.25) * 4.0 * 3.14159265;
}

void main() {
  if (u_n == 0 || u_ready < 0.5) { out_FragColor = vec4(0.0); return; }
  float sceneT = wfSceneDist(depthTexture, v_textureCoordinates);
  vec3 dirEC = normalize(wfEyeRay(v_textureCoordinates));
  vec3 dir = normalize(czm_inverseViewRotation * dirEC);
  vec3 sun = czm_lightDirectionWC;
  float cosT = dot(dir, sun);
  float ph0 = phase2(cosT, 1.0), ph1 = phase2(cosT, 0.5), ph2 = phase2(cosT, 0.25);

  // The clouds this ray passes through, nearest first (up to SLOTS), each by where the ray is
  // inside its upright cylinder (radius: its towers' reach) between base and top. Bounding
  // spheres were far looser: near the horizon four nearly empty ones filled the slots and the
  // cloud really in view was dropped, cut along their arcs (dark triangles).
  float t0s[SLOTS];
  float t1s[SLOTS];
  int ids[SLOTS];
  for (int j = 0; j < SLOTS; j++) { t0s[j] = 1e9; t1s[j] = 0.0; ids[j] = 0; }
  int hits = 0;
  vec2 dxy = vec2(dot(dir, u_E), dot(dir, u_N));
  float dz = dot(dir, u_up), A = max(dot(dxy, dxy), 1e-9);
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= u_n) break;
    float H = u_d[i].x, Rc = u_d[i].w;
    vec3 o = -u_c[i].xyz;
    vec2 oxy = vec2(dot(o, u_E), dot(o, u_N));
    float oz = dot(o, u_up);
    float B = dot(oxy, dxy), disc = B * B - A * (dot(oxy, oxy) - Rc * Rc);
    if (disc <= 0.0) continue;
    float sq = sqrt(disc);
    float a0 = (-B - sq) / A, a1 = (-B + sq) / A;
    if (abs(dz) > 1e-6) {
      float za = -oz / dz, zb = (H - oz) / dz;
      a0 = max(a0, min(za, zb));
      a1 = min(a1, max(za, zb));
    } else if (oz < 0.0 || oz > H) continue;
    a0 = max(a0, 0.0);
    a1 = min(a1, sceneT);
    if (a1 <= a0) continue;
    if (hits == SLOTS && a0 >= t0s[SLOTS - 1]) continue;
    int k = min(hits, SLOTS - 1);
    for (int j = SLOTS - 1; j > 0; j--) {
      if (j <= k && t0s[j - 1] > a0) { t0s[j] = t0s[j - 1]; t1s[j] = t1s[j - 1]; ids[j] = ids[j - 1]; k = j - 1; }
    }
    t0s[k] = a0; t1s[k] = a1; ids[k] = i;
    hits = min(hits + 1, SLOTS);
  }
  if (hits == 0) { out_FragColor = vec4(0.0); return; }

  float sigma = u_light.x;
  vec3 lin = vec3(0.0);
  float T = 1.0;
  float firstT = -1.0;
  // Per-pixel start offset against banding (the blend's filter smooths the pattern it leaves).
  // With temporal anti-aliasing (taa.ts) it changes every frame (u_frame), and the frames'
  // average leaves no pattern at all; without, it stays put (no shimmer).
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * u_frame, vec2(0.06711056, 0.00583715))));
  vec3 sunCol = czm_lightColor * u_light.y;
  for (int h = 0; h < SLOTS; h++) {
    if (h >= hits || T < 0.02) break;
    int i = ids[h];
    float R = u_c[i].w, H = u_d[i].x;
    float a0 = t0s[h], a1 = t1s[h];
    towers(i);
    // Fewer steps and no detail far away (a cloud 30 km off is a few dozen pixels).
    float far = smoothstep(5000.0, 30000.0, a0);
    bool detail = a0 < 20000.0;
    float dt = max((a1 - a0) / mix(u_light.w, 14.0, far), R * 0.015);
    float t = a0 + dt * jit;
    for (int it = 0; it < 64; it++) {
      if (t >= a1) break;
      vec3 q = dir * t - u_c[i].xyz;
      float dens = density(i, q, detail);
      if (dens <= 0.0) { t += dt; continue; }
      if (firstT < 0.0) firstT = t;
      // Towards the sun: 5 steps, growing, shape only.
      float od = 0.0, ls = R * 0.1;
      for (int s = 1; s <= 5; s++) od += density(i, q + sun * (ls * float(s * s) * 0.4), false) * ls * float(s) * 0.8;
      od *= sigma;
      // Multiple scattering, three octaves.
      float powder = mix(0.55, 1.0, 1.0 - exp(-dens * 6.0));
      // (Weights and attenuations tuned so the shaded side stays a light grey, as the many
      // scatterings inside a real cumulus keep it.)
      vec3 S = sunCol * (exp(-od) * ph0 * powder + 0.6 * exp(-0.3 * od) * ph1 + 0.4 * exp(-0.1 * od) * ph2);
      float hn = clamp(dot(q, u_up) / H, 0.0, 1.0);
      S += mix(u_ambBase, u_ambTop, smoothstep(0.0, 0.85, hn)) * u_light.z;
      float tr = exp(-sigma * dens * dt);
      lin += T * S * (1.0 - tr);
      T *= tr;
      if (T < 0.02) break;
      t += dt;
    }
  }
  if (firstT < 0.0) { out_FragColor = vec4(0.0); return; }
  float a = 1.0 - T;
  vec3 col = lin;
  if (u_ap0.y > 0.5) {
    // The atmosphere's air between the camera and the cloud.
    vec4 ap = aerial(v_textureCoordinates, firstT / 1000.0);
    col = col * ap.a + ap.rgb * u_ap0.x * a;
  } else {
    float hz = smoothstep(u_fade.x, u_fade.y, firstT);
    col = mix(col, u_haze * a, clamp(hz * 1.2, 0.0, 1.0));
  }
  // Gone by the far limit.
  float keep = 1.0 - smoothstep(u_fade.y * 0.85, u_fade.y, firstT);
  out_FragColor = vec4(col * keep, a * keep);
}
`;

/**
 * Full resolution: the half-resolution clouds over the scene, four bilinear taps (a soft 3×3
 * texel tent: it also smooths the march's step pattern), each weighted by how close the scene
 * depth at the tap is to the depth here, so clouds don't bleed onto the glider's edges.
 */
const BLEND_FS = /* glsl */ `${SCENE_DIST_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_clouds;
in vec2 v_textureCoordinates;
float distAt(vec2 uv) {
  return wfSceneDist(depthTexture, uv);
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 scene = texture(colorTexture, uv);
  vec2 px = 1.0 / vec2(textureSize(u_clouds, 0));
  float here = distAt(uv);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k == 0 || k == 2 ? -0.5 : 0.5, k < 2 ? -0.5 : 0.5) * px;
    float dt = distAt(uv + o);
    float w = exp(-abs(log(max(dt, 0.1) / max(here, 0.1))) * 6.0) + 1e-4;
    sum += texture(u_clouds, uv + o) * w;
    wsum += w;
  }
  vec4 c = sum / wsum;
  out_FragColor = vec4(scene.rgb * (1.0 - c.a) + c.rgb, scene.a);
}
`;

interface Cloud {
  spec: CloudSpec;
  base: Cartesian3;
  geo: CloudGeometry;
}

export class VolumetricClouds {
  private clouds: Cloud[] = [];
  private readonly c = Array.from({ length: MAX }, () => new Cartesian4());
  private readonly d = Array.from({ length: MAX }, () => new Cartesian4());
  private n = 0;
  private readonly up = new Cartesian3();
  private readonly east = new Cartesian3();
  private readonly north = new Cartesian3();
  private readonly towerData = new Float32Array(TOWERS * 4 * MAX);
  private readonly tex: { towers: unknown; shape?: unknown; detail?: unknown };
  private readonly ambTop: Cartesian3;
  private readonly ambBase: Cartesian3;
  private ambFromSky = false;
  private ambVersion = -1;
  private readonly light: Cartesian4;
  private readonly form: Cartesian4;
  readonly stage: PostProcessStageComposite;

  constructor(
    private readonly viewer: Viewer,
    private readonly atmosphere?: Atmosphere,
  ) {
    const amb = LOOK.ambient;
    const self = this;
    const scene = viewer.scene;
    const context = (scene as unknown as { context: unknown }).context;
    // In HDR (hdr.ts) the march's light is linear radiance going into a linear scene, kept
    // above white in half floats; the haze colour below is given in display values.
    const hdr = scene.highDynamicRange;
    const lin = (v: number) => (hdr ? Math.pow(v, 2.2) : v);
    const pixelDatatype = hdr ? PixelDatatype.HALF_FLOAT : PixelDatatype.UNSIGNED_BYTE;
    const params = new URLSearchParams(location.search);
    const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
    // ?csig= extinction, ?csun= sun, ?camb= sky light, ?csteps= steps (tuning).
    this.light = new Cartesian4(num("csig", 0.05), num("csun", 1.5), num("camb", 0.5), num("csteps", 40));
    // ?cdens= density boost, ?cdet= erosion, ?cscale= shape tile ÷ radius, ?cdtile= detail tile [m].
    this.form = new Cartesian4(num("cdens", 4), num("cdet", 0.55), num("cscale", 0.8), num("cdtile", 180));
    // The sky's light until the atmosphere's is read back (refresh): ours from lighting.ts.
    this.ambTop = new Cartesian3(0.6 * amb[0]!, 0.67 * amb[1]!, 0.8 * amb[2]!);
    this.ambBase = new Cartesian3(0.3 * amb[0]!, 0.33 * amb[1]!, 0.4 * amb[2]!);
    this.tex = {
      towers: new C.Texture({
        context,
        width: TOWERS,
        height: MAX,
        pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: C.PixelDatatype.FLOAT,
        source: { arrayBufferView: this.towerData },
        flipY: false,
        sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.NEAREST, magnificationFilter: C.TextureMagnificationFilter.NEAREST }),
      }),
    };
    // The noise is made in a worker; no clouds until it is in (it is, behind the loading screen).
    void cloudNoiseAsync().then((noise) => {
      if (this.destroyed) return;
      const make = (data: Uint8Array, n: number) =>
        new C.Texture3D({
          context,
          width: n,
          height: n,
          depth: n,
          pixelFormat: C.PixelFormat.RGBA,
          pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
          source: { width: n, height: n, depth: n, arrayBufferView: data },
          flipY: false,
          sampler: new C.Sampler({ wrapS: C.TextureWrap.REPEAT, wrapT: C.TextureWrap.REPEAT, wrapR: C.TextureWrap.REPEAT, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }),
        });
      this.tex.shape = make(noise.shape, noise.shapeSize);
      this.tex.detail = make(noise.detail, noise.detailSize);
    });
    const hasAp = !!atmosphere;
    const march = new PostProcessStage({
      // Half resolution in each direction: a quarter of the pixels to march.
      textureScale: 0.5,
      pixelDatatype,
      fragmentShader: FS,
      uniforms: {
        u_c: () => (self.refresh(), self.c),
        u_d: () => self.d,
        u_n: () => self.n,
        u_up: () => self.up,
        u_E: () => self.east,
        u_N: () => self.north,
        u_ambTop: () => self.ambTop,
        u_ambBase: () => self.ambBase,
        u_light: () => self.light,
        u_form: () => self.form,
        u_haze: new Cartesian3(lin(0.72 * LOOK.ground), lin(0.78 * LOOK.ground), lin(0.86 * LOOK.ground)),
        u_fade: new Cartesian2(15_000, VOLUME_RANGE_M * 1.4),
        u_ap0: () => new Cartesian2(atmosphere ? atmosphere.scale.y : 0, hasAp ? 1 : 0),
        u_ap: () => atmosphere?.apTexture ?? self.tex.towers,
        u_towers: () => self.tex.towers,
        u_shape: () => self.tex.shape ?? self.tex.towers,
        u_detail: () => self.tex.detail ?? self.tex.towers,
        u_ready: () => (self.tex.shape ? 1 : 0),
        u_frame: () => (temporal.on ? temporal.frame % 64 : 0),
      },
    });
    const blend = new PostProcessStage({ fragmentShader: BLEND_FS, pixelDatatype, uniforms: { u_clouds: march.name } });
    this.stage = new PostProcessStageComposite({ stages: [march, blend], inputPreviousStageTexture: false });
    scene.postProcessStages.add(this.stage);
  }

  private destroyed = false;
  destroy(): void {
    this.destroyed = true;
    for (const t of Object.values(this.tex)) (t as { destroy?(): void } | undefined)?.destroy?.();
  }

  set(specs: CloudSpec[]): void {
    this.clouds = specs.filter((s) => s.size > 0 && s.opacity > 0).map((spec) => ({ spec, base: Cartesian3.fromDegrees(spec.lonDeg, spec.latDeg, spec.baseM), geo: cloudGeometry(spec) }));
  }

  /** Once per frame (from the uniform callback): the nearest clouds relative to the camera. */
  private stamp = -1;
  private refresh(): void {
    const fs = (this.viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState;
    if (fs.frameNumber === this.stamp) return;
    this.stamp = fs.frameNumber;
    // The sky's light from the atmosphere (once its tables are made): the clouds lit by the
    // same sky that is drawn round them.
    if (this.atmosphere && this.ambVersion !== this.atmosphere.ambientVersion) {
      const a = this.atmosphere.skyAmbient();
      if (a) {
        this.ambVersion = this.atmosphere.ambientVersion;
        this.ambFromSky = true;
        // Less blue than the sky itself: the cloud's own scattered light is white.
        const sky = a.top.map((v, i) => 0.55 * v + 0.45 * a.horizon[i]!);
        const lum = 0.2126 * sky[0]! + 0.7152 * sky[1]! + 0.0722 * sky[2]!;
        const top = sky.map((v) => 0.6 * v + 0.4 * lum);
        Cartesian3.fromElements(top[0]!, top[1]!, top[2]!, this.ambTop);
        // Below: the sky's light half hidden by the cloud, plus the ground's, warmer.
        Cartesian3.fromElements(top[0]! * 0.42 + a.horizon[0]! * 0.08, top[1]! * 0.42 + a.horizon[1]! * 0.07, top[2]! * 0.42 + a.horizon[2]! * 0.05, this.ambBase);
      }
    }
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
        if (x.d > VOLUME_RANGE_M * 1.4) return false;
        const H = x.c.geo.height;
        Cartesian3.add(x.c.base, Cartesian3.multiplyByScalar(this.up, H * 0.5, bs.center), bs.center);
        bs.radius = Math.hypot(x.c.geo.reach, H * 0.5) * 1.05;
        return cull.computeVisibility(bs) !== Intersect.OUTSIDE;
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX);
    this.n = near.length;
    near.forEach(({ c }, i) => {
      this.c[i]!.x = c.base.x - cam.x;
      this.c[i]!.y = c.base.y - cam.y;
      this.c[i]!.z = c.base.z - cam.z;
      this.c[i]!.w = c.geo.radius;
      this.d[i]!.x = c.geo.height;
      this.d[i]!.y = c.spec.opacity;
      this.d[i]!.z = c.geo.seed;
      this.d[i]!.w = c.geo.reach;
      this.towerData.set(c.geo.towers, i * TOWERS * 4);
    });
    (this.tex.towers as { copyFrom(o: unknown): void }).copyFrom({ source: { width: TOWERS, height: MAX, arrayBufferView: this.towerData } });
  }
}
