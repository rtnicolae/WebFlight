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
/**
 * Beyond the volumes, clouds out to this far are drawn from a top-down map (setFar) [m]: a
 * cumulus field runs to the horizon (from the ground at its base 1.6 km up, clouds 150 km off
 * stand half a degree above it). A square of FAR_N² texels, FAR_SIZE_M across.
 */
export const FAR_RANGE_M = 160_000;
const FAR_N = 1024, FAR_SIZE_M = 340_000;

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
uniform vec4 u_ap0;           // with the atmosphere: haze scale, 1, the sky's scale
// The air in front of a cloud: as the haze on the ground near by, as the sky round it far off
// (through a long path a distant cloud fades into the sky's colour; with the ground haze's
// darker scale it stood out as a grey silhouette).
float apScale(float t) { return mix(u_ap0.x, u_ap0.z, smoothstep(30000.0, 90000.0, t)); }
uniform float u_ready;
uniform vec4 u_form;          // density scale, detail erosion, shape tile ÷ radius, detail tile [m]
// The far field (beyond the volumes): a top-down map of the clouds, tangent to the ground at its
// centre: r = top above the base ÷ MAX_TOWER_M, g = opacity.
uniform sampler2D u_farMap;
uniform vec4 u_farC;          // map centre relative to the camera (world) [m], half its size [m]
uniform vec3 u_farE;          // the map's east, north, up (world)
uniform vec3 u_farN;
uniform vec3 u_farUp;
uniform vec4 u_farP;          // earth radius at the centre [m], cloud base [m above sea level], highest top [m], on

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

vec4 g_b[${TOWERS}];
void towers(int i) {
  for (int k = 0; k < ${TOWERS}; k++) g_b[k] = texelFetch(u_towers, ivec2(k, i), 0);
}
// Density of cloud i at q (relative to its base centre, world axes); detail: how much of the
// detail erosion (0–1).
float density(int i, vec3 q, float detail) {
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
  if (detail > 0.0) {
    // World-scale wisps (~260 m tile): ragged at the base, billowy above.
    vec3 dn = texture(u_detail, q / u_form.w + u_d[i].z * 3.1).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float dm = mix(1.0 - df, df, clamp(hn * 4.0, 0.0, 1.0));
    d = remap(d, dm * u_form.y * detail, 1.0, 0.0, 1.0);
  }
  // Dense right behind the surface: crisp edges (real cumulus are), soft only where eroded.
  // Level base: a short fade at the bottom only.
  d = clamp(d * u_form.x, 0.0, 1.0) * smoothstep(0.0, 0.03, hn);
  return d * u_d[i].y;
}

// Far-cloud density at v (relative to the far map's centre) and hgt above the base: the map's
// heap (its top and how much of the texel it covers) as the volumes' towers are their coverage,
// carved by the same Perlin–Worley noise in the world (a tile ~1.6 km), eroded at the rim and the
// top, a short fade at the base. Returns density (the volumes' scale) and the height fraction.
vec2 farDensity(vec3 v, float hgt) {
  if (hgt < 0.0) return vec2(0.0);
  vec2 uv = vec2(dot(v, u_farE), dot(v, u_farN)) / (2.0 * u_farC.w) + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0);
  vec4 m = texture(u_farMap, uv);
  float cTop = m.r * ${MAX_TOWER_M.toFixed(1)};
  if (m.g <= 0.0 || hgt > cTop * 1.3) return vec2(0.0);
  float hn = hgt / max(cTop, 1.0);
  // Coverage: the heap's share of the texel, falling off towards its top.
  float cov = clamp(m.g * 1.3, 0.0, 1.0) * smoothstep(1.3, 0.55, hn);
  vec3 w = vec3(dot(v, u_farE), dot(v, u_farN), hgt) / 1600.0;
  vec4 sn = texture(u_shape, w);
  float wf = sn.g * 0.625 + sn.b * 0.25 + sn.a * 0.125;
  float base = remap(sn.r, wf - 1.0, 1.0, 0.0, 1.0);
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (d <= 0.0) return vec2(0.0, hn);
  // Detail: wisps at the base, rounded billows above (as the volumes' erosion).
  vec4 dn = texture(u_detail, w * 3.0);
  float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  d = remap(d, mix(1.0 - df, df, clamp(hn * 4.0, 0.0, 1.0)) * u_form.y, 1.0, 0.0, 1.0);
  return vec2(clamp(d * u_form.x, 0.0, 1.0) * smoothstep(0.0, 0.03, hn), hn);
}

// The far clouds along the ray between tMin and tMax: premultiplied colour (the air in front
// already over it) and alpha. Height above sea level along the ray, with the earth's curvature
// to second order: h(t) = a·t² + b·t + c. Lit as the volumes are: a march towards the sun for
// their self-shadow (the sunlit side bright, the far side and the base in shade), three
// scattering octaves, the powder term and the sky's light from above, darker below.
vec4 farClouds(vec3 dir, float tMin, float tMax, vec3 sun, vec3 sunCol, float ph0, float ph1, float ph2, float jit) {
  if (u_farP.w < 0.5 || tMax <= tMin) return vec4(0.0);
  vec3 F = u_farC.xyz;
  float R0 = u_farP.x, B = u_farP.y, top = B + u_farP.z * 1.3;
  float s = dot(dir, u_farUp), f = dot(-F, u_farUp), dF = dot(dir, -F), F2 = dot(F, F);
  float qa = (1.0 - s * s) / (2.0 * R0), qb = s + (dF - s * f) / R0, qc = f + (F2 - f * f) / (2.0 * R0);
  // Below the top: between the roots of h = top.
  float dTop = qb * qb - 4.0 * qa * (qc - top);
  if (dTop <= 0.0) return vec4(0.0);
  float sq = sqrt(dTop);
  float lo = max(tMin, (-qb - sq) / (2.0 * qa)), hi = min(tMax, (-qb + sq) / (2.0 * qa));
  if (hi <= lo) return vec4(0.0);
  // Above the base: outside the roots of h = base.
  float g0 = hi, g1 = hi;
  float dB = qb * qb - 4.0 * qa * (qc - B);
  if (dB > 0.0) { float sb = sqrt(dB); g0 = (-qb - sb) / (2.0 * qa); g1 = (-qb + sb) / (2.0 * qa); }
  float sigma = u_light.x * 0.25, sunUp = dot(sun, u_farUp);
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int part = 0; part < 2; part++) {
    float a0 = part == 0 ? lo : max(lo, g1);
    float a1 = part == 0 ? (dB > 0.0 ? min(hi, g0) : hi) : hi;
    if (part == 1 && dB <= 0.0) break;
    if (a1 <= a0) continue;
    float n = clamp((a1 - a0) / 250.0, 4.0, 56.0), dt = (a1 - a0) / n;
    float t = a0 + dt * jit;
    for (int k = 0; k < 56; k++) {
      if (float(k) >= n || T < 0.02) break;
      vec3 v = dir * t - F;
      float hgt = qa * t * t + qb * t + qc - B;
      vec2 dh = farDensity(v, hgt);
      if (dh.x > 0.0) {
        float dens = dh.x, hn = dh.y;
        // Towards the sun, from where the ray met this cloud: the march's steps here are hundreds
        // of metres, and a sample that deep inside would have the whole cloud between it and the
        // sun (the volumes are lit at their surface). 4 steps, growing.
        vec3 vs = v - dir * dt;
        float hs = hgt - dot(dir, u_farUp) * dt;
        float od = 0.0;
        for (int l = 1; l <= 4; l++) {
          float L = 60.0 * float(l * l);
          od += farDensity(vs + sun * L, hs + sunUp * L).x * 60.0 * float(2 * l - 1);
        }
        od *= sigma * 0.35;
        float powder = mix(0.55, 1.0, 1.0 - exp(-dens * 6.0));
        vec3 S = sunCol * (exp(-od) * ph0 * powder + 0.6 * exp(-0.3 * od) * ph1 + 0.4 * exp(-0.1 * od) * ph2);
        S += mix(u_ambBase, u_ambTop, smoothstep(0.0, 0.85, hn)) * u_light.z;
        float tr = exp(-u_light.x * dens * dt); // as dense as the volumes
        vec3 c = S;
        if (u_ap0.y > 0.5) {
          vec4 ap = aerial(v_textureCoordinates, t / 1000.0);
          c = S * ap.a + ap.rgb * apScale(t);
        } else c = mix(S, u_haze, clamp(smoothstep(u_fade.x, u_fade.y, t) * 1.2, 0.0, 1.0));
        col += T * c * (1.0 - tr);
        T *= tr;
      }
      t += dt;
    }
  }
  return vec4(col, 1.0 - T);
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
  if ((u_n == 0 && u_farP.w < 0.5) || u_ready < 0.5) { out_FragColor = vec4(0.0); return; }
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
  vec3 sunColFar = czm_lightColor * u_light.y;
  float jitF = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 5.588238 * u_frame, vec2(0.06711056, 0.00583715))));
  if (hits == 0) { out_FragColor = farClouds(dir, ${(VOLUME_RANGE_M - 5000).toFixed(1)}, min(sceneT, ${FAR_RANGE_M.toFixed(1)}), sun, sunColFar, ph0, ph1, ph2, jitF); return; }

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
    // Fewer steps and no detail far away (a cloud 30 km off is a few dozen pixels). The detail
    // fades out with each sample's distance: switched off where the ray entered the cloud's
    // cylinder beyond 20 km, a cloud about that far was cut into upright bands (the middle
    // eroded and grey, the sides smooth and white).
    float far = smoothstep(5000.0, 30000.0, a0);
    float dt = max((a1 - a0) / mix(u_light.w, 14.0, far), R * 0.015);
    float t = a0 + dt * jit;
    for (int it = 0; it < 64; it++) {
      if (t >= a1) break;
      vec3 q = dir * t - u_c[i].xyz;
      float dens = density(i, q, 1.0 - smoothstep(14000.0, 24000.0, t));
      if (dens <= 0.0) { t += dt; continue; }
      if (firstT < 0.0) firstT = t;
      // Towards the sun: 5 steps, growing, shape only.
      float od = 0.0, ls = R * 0.1;
      for (int s = 1; s <= 5; s++) od += density(i, q + sun * (ls * float(s * s) * 0.4), 0.0) * ls * float(s) * 0.8;
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
  // Nothing of them here (the ray only crossed their bounds): the far field alone. (It returned
  // nothing: far clouds behind a near cloud's bounds were cut out along upright edges.)
  if (firstT < 0.0) { out_FragColor = farClouds(dir, ${(VOLUME_RANGE_M - 5000).toFixed(1)}, min(sceneT, ${FAR_RANGE_M.toFixed(1)}), sun, sunColFar, ph0, ph1, ph2, jitF); return; }
  float a = 1.0 - T;
  vec3 col = lin;
  if (u_ap0.y > 0.5) {
    // The atmosphere's air between the camera and the cloud.
    vec4 ap = aerial(v_textureCoordinates, firstT / 1000.0);
    col = col * ap.a + ap.rgb * apScale(firstT) * a;
  } else {
    float hz = smoothstep(u_fade.x, u_fade.y, firstT);
    col = mix(col, u_haze * a, clamp(hz * 1.2, 0.0, 1.0));
  }
  // Gone by the far limit.
  float keep = 1.0 - smoothstep(u_fade.y * 0.85, u_fade.y, firstT);
  col *= keep;
  a *= keep;
  // The far field behind what the volumes left.
  if (a < 0.98) {
    vec4 far = farClouds(dir, ${(VOLUME_RANGE_M - 5000).toFixed(1)}, min(sceneT, ${FAR_RANGE_M.toFixed(1)}), sun, sunColFar, ph0, ph1, ph2, jitF);
    col += (1.0 - a) * far.rgb;
    a += (1.0 - a) * far.a;
  }
  out_FragColor = vec4(col, a);
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
  private readonly tex: { towers: unknown; far: unknown; shape?: unknown; detail?: unknown };
  private readonly ambTop: Cartesian3;
  private readonly ambBase: Cartesian3;
  private ambFromSky = false;
  private ambVersion = -1;
  private readonly light: Cartesian4;
  private readonly form: Cartesian4;
  readonly stage: PostProcessStageComposite;
  private readonly farData = new Uint8Array(FAR_N * FAR_N * 4);
  private readonly farCentre = new Cartesian3();
  private readonly farC = new Cartesian4();
  private readonly farE = new Cartesian3();
  private readonly farN = new Cartesian3();
  private readonly farUp = new Cartesian3();
  private readonly farP = new Cartesian4();
  /** Far clouds drawn from the map (for checks). */
  farCount = 0;

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
      far: new C.Texture({
        context,
        width: FAR_N,
        height: FAR_N,
        pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE,
        source: { arrayBufferView: this.farData },
        flipY: false,
        sampler: new C.Sampler({ wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE, minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR }),
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
        u_ap0: () => new Cartesian4(atmosphere ? atmosphere.scale.y : 0, hasAp ? 1 : 0, atmosphere ? atmosphere.scale.x : 0, 0),
        u_ap: () => atmosphere?.apTexture ?? self.tex.towers,
        u_towers: () => self.tex.towers,
        u_shape: () => self.tex.shape ?? self.tex.towers,
        u_detail: () => self.tex.detail ?? self.tex.towers,
        u_ready: () => (self.tex.shape ? 1 : 0),
        u_frame: () => (temporal.on ? temporal.frame % 64 : 0),
        u_farMap: () => self.tex.far,
        u_farC: () => self.farC,
        u_farE: () => self.farE,
        u_farN: () => self.farN,
        u_farUp: () => self.farUp,
        u_farP: () => self.farP,
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

  /**
   * The clouds beyond the volumes, drawn into the far map round the camera's ground position:
   * each cloud its footprint (as wide as its volume would be) with a dome on top (its height),
   * the tallest and densest where clouds meet. The base is one height for the air mass.
   */
  setFar(specs: CloudSpec[]): void {
    const live = specs.filter((s) => s.size > 0 && s.opacity > 0);
    this.farCount = live.length;
    if (!live.length) {
      this.farP.w = 0;
      return;
    }
    const carto = this.viewer.camera.positionCartographic;
    const ell = this.viewer.scene.globe.ellipsoid;
    Cartesian3.fromRadians(carto.longitude, carto.latitude, 0, ell, this.farCentre);
    ell.geodeticSurfaceNormal(this.farCentre, this.farUp);
    Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, this.farUp, this.farE), this.farE);
    Cartesian3.cross(this.farUp, this.farE, this.farN);
    const d = this.farData;
    d.fill(0);
    const texel = FAR_SIZE_M / FAR_N, half = FAR_SIZE_M / 2, p = new Cartesian3();
    const bases: number[] = [];
    let maxTop = 0;
    for (const spec of live) {
      // The visible body: the volumes' towers (centres within 0.65 of the radius, each 0.3–0.6 of
      // it across) reach to about 0.9 of the radius they reserve.
      const g = cloudGeometry(spec), R = Math.max(g.radius * 0.9, 1);
      // A cloud narrower than a texel would stand as a texel-wide column at its full height.
      const H = g.height * Math.min(1, R / (FAR_SIZE_M / FAR_N));
      Cartesian3.subtract(Cartesian3.fromDegrees(spec.lonDeg, spec.latDeg, 0, ell, p), this.farCentre, p);
      const ex = Cartesian3.dot(p, this.farE), ny = Cartesian3.dot(p, this.farN);
      const fx = (ex + half) / texel - 0.5, fy = (ny + half) / texel - 0.5, rt = R / texel + 1;
      if (fx < -rt || fy < -rt || fx > FAR_N + rt || fy > FAR_N + rt) continue;
      bases.push(spec.baseM);
      maxTop = Math.max(maxTop, H);
      // A cloud narrower than a texel still marks its texel, as thin as its share of it.
      const share = Math.min(1, (Math.PI * R * R) / (texel * texel));
      for (let y = Math.max(0, Math.floor(fy - rt)); y <= Math.min(FAR_N - 1, Math.ceil(fy + rt)); y++)
        for (let x = Math.max(0, Math.floor(fx - rt)); x <= Math.min(FAR_N - 1, Math.ceil(fx + rt)); x++) {
          const r = Math.max(0, Math.hypot(x - fx, y - fy) * texel - texel / 2), u = r / R;
          if (u >= 1) continue;
          // A rounded heap, thinning towards its rim (no cliff where the texels end).
          const top = H * Math.sqrt(1 - u * u), soft = 1 - u * u * u, i = (y * FAR_N + x) * 4;
          d[i] = Math.max(d[i]!, Math.round((255 * top) / MAX_TOWER_M));
          d[i + 1] = Math.max(d[i + 1]!, Math.round(255 * spec.opacity * share * soft));
        }
    }
    bases.sort((a, b) => a - b);
    (this.tex.far as { copyFrom(o: unknown): void }).copyFrom({ source: { width: FAR_N, height: FAR_N, arrayBufferView: d } });
    this.farP.x = Cartesian3.magnitude(this.farCentre);
    this.farP.y = bases.length ? bases[Math.floor(bases.length / 2)]! : 0;
    this.farP.z = maxTop;
    this.farP.w = bases.length ? 1 : 0;
    this.farC.w = half;
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
    // The far map's centre relative to the camera.
    this.farC.x = this.farCentre.x - cam.x;
    this.farC.y = this.farCentre.y - cam.y;
    this.farC.z = this.farCentre.z - cam.z;
  }
}
