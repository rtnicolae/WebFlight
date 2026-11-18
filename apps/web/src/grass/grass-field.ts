/**
 * Grass at ground level, made on the GPU, in tufts (6 blades fanning out from a root; ?grasstuft=1
 * for single blades: the same cost at the same blades per m², measured): every blade is a tapered, curved strip generated in
 * the vertex shader from a hash of its world position (nothing per blade on the CPU or in
 * memory), drawn with instancing, patch by patch (4 m squares) in rings round the camera.
 * Densest under the camera (DENSITY blades/m²), thinning with distance as 1/d² while the
 * blades widen as √ of that, so the lawn looks as full at 60 m as at 5 m; nearer rings use
 * more segments per blade. Only patches in view are drawn.
 *
 * Where grass grows, its colour, how lush it is and which of it is mown come from maps of the
 * ground round a centre (grass-worker.ts: OpenStreetMap, Sentinel-2's colour: washed-out green
 * is degraded grass, sparse, short and dry), re-made as the glider moves. Mown
 * airfield grass is short and even; elsewhere a meadow: knee-high grass in patches, seed
 * stalks, and flowers (white, yellow, purple) in drifts. The wind (the day's, from the
 * weather) bends it in gusts that travel across the field.
 *
 * Light: roots dark in the shade of the grass above them, blades rounded across their width,
 * light through the blades when the sun is behind them, a little sheen; the glider's shadow
 * (Cesium's shadow map) falls on them. With Google's 3D tiles the blades stand on Google's
 * ground: its height is sampled on a grid and the difference to our terrain added.
 *
 * Costly, so only near the ground: it fades out between 25 and 40 m above it.
 */
import * as Cesium from "cesium";
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Intersect, Matrix4, Transforms, type Viewer } from "cesium";
import { LOOK } from "../lighting.ts";
import type { Google3D } from "../google3d.ts";
import type { FieldRequest, FieldResult } from "./grass-worker.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

/** The maps' square [m], texels across, height samples across, re-centre distance [m]. */
const FIELD_M = 224, FIELD_RES = 320, HEIGHT_RES = 113, RECENTRE_M = 36;
/** Patch size [m]. */
const PATCH = 4;
/**
 * Google correction grid: points across (spacing FIELD_M / (CORR_N − 1) = 4 m). At 16 m most
 * short blades stood below Google's bumpier ground.
 */
const CORR_N = 57;
const CORR_ORDER = Array.from({ length: CORR_N * CORR_N }, (_, k) => k).sort((a, b) => {
  const c = (CORR_N - 1) / 2, d = (k: number) => Math.hypot((k % CORR_N) - c, Math.floor(k / CORR_N) - c);
  return d(a) - d(b);
});

interface Ring {
  r0: number;
  r1: number;
  segments: number;
}
const RINGS: Ring[] = [
  { r0: 0, r1: 8, segments: 4 },
  { r0: 8, r1: 16, segments: 3 },
  { r0: 16, r1: 30, segments: 2 },
  { r0: 30, r1: 50, segments: 1 },
  { r0: 50, r1: 75, segments: 1 },
];
const FULL_R = 6, FADE_R0 = 62, FADE_R1 = 75;

const VS = /* glsl */ `
in vec3 a_tpl;     // t along the blade (0 root … 1 tip), side (−1, 0, 1), blade in the tuft
in vec2 a_patch;   // patch's south-west corner, field metres (east, north)
uniform sampler2D u_mask, u_params, u_height, u_corr;
uniform vec2 u_gpatch;      // the field centre's global patch index
uniform vec3 u_cam;         // camera, field metres
uniform vec4 u_ring;        // r0, r1, blades per patch, density at full
uniform float u_seg;        // segments per blade in this ring
uniform vec4 u_wind;        // direction (x, y), strength 0–1, time [s]
uniform float u_fade;       // 0–1 with the camera's height
out vec3 v_positionEC;
out vec3 v_col;
out vec3 v_nEC;
out vec3 v_sideEC;
out vec2 v_tu;              // t, across (−1 … 1)
out float v_kind;           // 0 blade, 1 seed stalk, 2 flower
out float v_dry;            // 0 lush … 1 dry

const float HALF = ${(FIELD_M / 2).toFixed(1)};
float h11(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = h11(vec3(i, 7.0)), b = h11(vec3(i + vec2(1, 0), 7.0)), c = h11(vec3(i + vec2(0, 1), 7.0)), d = h11(vec3(i + vec2(1, 1), 7.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float heightAt(vec2 p) {
  // Manual bilinear (float textures need not filter).
  vec2 g = clamp((p + HALF) / (2.0 * HALF), 0.0, 1.0) * ${(HEIGHT_RES - 1).toFixed(1)};
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  ivec2 j = min(i + 1, ivec2(${HEIGHT_RES - 1}));
  float h = mix(mix(texelFetch(u_height, i, 0).r, texelFetch(u_height, ivec2(j.x, i.y), 0).r, f.x),
                mix(texelFetch(u_height, ivec2(i.x, j.y), 0).r, texelFetch(u_height, j, 0).r, f.x), f.y);
  vec2 cg = clamp((p + HALF) / (2.0 * HALF), 0.0, 1.0) * ${(CORR_N - 1).toFixed(1)};
  ivec2 ci = ivec2(floor(cg));
  vec2 cf = fract(cg);
  ivec2 cj = min(ci + 1, ivec2(${CORR_N - 1}));
  float c = mix(mix(texelFetch(u_corr, ci, 0).r, texelFetch(u_corr, ivec2(cj.x, ci.y), 0).r, cf.x),
                mix(texelFetch(u_corr, ivec2(ci.x, cj.y), 0).r, texelFetch(u_corr, cj, 0).r, cf.x), cf.y);
  return h + c;
}
void main() {
  float per = u_ring.z;
  float slot = mod(float(gl_InstanceID), per);
  // Global patch index, wrapped every 4096 patches (16 km): hashes of numbers near a million
  // lose their low bits in 32-bit floats (blades piled on one spot, blocky noise).
  vec2 gp = mod(u_gpatch + floor(a_patch / ${PATCH.toFixed(1)} + 0.5), 4096.0);
  float r1 = h11(vec3(gp, slot)), r2 = h11(vec3(gp, slot + 0.37)), r3 = h11(vec3(gp, slot + 0.71)),
        r4 = h11(vec3(gp, slot + 1.13)), r5 = h11(vec3(gp, slot + 1.59)), r6 = h11(vec3(gp, slot + 2.03));
  vec2 p = a_patch + vec2(r1, r2) * ${PATCH.toFixed(1)};
  vec2 world = (gp + vec2(r1, r2)) * ${PATCH.toFixed(1)};  // stable across re-centring
  float d = length(p - u_cam.xy);
  // Density: full near the camera, then 1/d², faded at the far edge; this ring's share.
  float dens = u_ring.w * min(1.0, ${(FULL_R * FULL_R).toFixed(1)} / max(d * d, 1e-3)) * (1.0 - smoothstep(${FADE_R0.toFixed(1)}, ${FADE_R1.toFixed(1)}, d));
  float ringMax = u_ring.w * min(1.0, ${(FULL_R * FULL_R).toFixed(1)} / max(u_ring.x * u_ring.x, 1e-3));
  vec2 uv = (p + HALF) / (2.0 * HALF);
  vec4 m = texture(u_mask, uv);
  vec4 pr = texture(u_params, uv);
  float mown = pr.r, lush = pr.g;
  // Clumps: grass grows in tufts and patches.
  float clump = 0.55 + 0.45 * vnoise(world * 0.9) + 0.25 * vnoise(world * 0.13);
  float keep = (dens / ringMax) * m.a * clamp(clump, 0.0, 1.0) * u_fade;
  if (d < u_ring.x || d >= u_ring.y || r3 > keep) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }

  // Tuft: TUFT_K blades round its root, fanning out (meadow grass grows in bunches; mown
  // grass spreads its blades wider, a more even lawn).
  float meadow = 1.0 - mown;
  float blade = a_tpl.z;
  float b1 = h11(vec3(gp, slot * 7.31 + blade * 1.73 + 0.29)), b2 = h11(vec3(gp, slot * 5.17 + blade * 2.11 + 0.61)), b3 = h11(vec3(gp, slot * 3.97 + blade * 1.37 + 0.83));
  vec2 off = vec2(0.0);
  if (TUFT_K > 1.0) {
    float spread = mix(0.11, 0.045, meadow) * (0.6 + 0.8 * r6) * sqrt(clamp(sqrt(u_ring.w / max(dens, 1e-3)), 1.0, 12.0));
    float ba = b2 * 6.2831853;
    off = sqrt(b1) * spread * vec2(cos(ba), sin(ba));
    p += off;
    world += off;
  }
  float tallPatch = smoothstep(0.25, 0.85, vnoise(world * 0.07 + 3.1));
  float kind = 0.0;
  float flowerField = smoothstep(0.55, 0.85, vnoise(world * 0.05 + 11.0));
  // Flowers and seed stalks: one blade of a tuft (with tufts: a tuft's share is K times a blade's).
  float kShare = min(1.0, TUFT_K * 0.6);
  // (Flowers only where blades have segments enough to show a head (else the colour runs down
  // the whole blade: purple grass), fewer in dry grass.)
  if (u_seg > 2.5 && blade < 0.5 && meadow > 0.5 && r4 < (0.012 + 0.05 * flowerField) * kShare * (0.3 + 0.7 * lush)) kind = 2.0;
  else if (blade < 0.5 && meadow > 0.5 && r4 < 0.11 * kShare) kind = 1.0;
  float H = mix(0.07 + 0.08 * r5, (0.2 + 0.32 * r5) * (0.55 + 0.75 * tallPatch), meadow);
  if (kind > 0.5) H *= 1.25;
  H *= 0.4 + 0.6 * m.a;  // shorter where it thins out (edges)
  H *= 0.6 + 0.4 * lush;  // degraded grass is short
  // Far blades are few (1/d²) and wide: tall ones stood out against the horizon as isolated
  // spikes from a low eye. Shorter with distance, they stay in the ground's layer.
  H *= mix(1.0, 0.35, smoothstep(18.0, 65.0, d));
  // Within a tuft: the middle blades tallest.
  if (TUFT_K > 1.0) H *= (0.7 + 0.45 * b3) * mix(1.1, 0.8, sqrt(b1));
  // Wider far away (fewer blades, same cover).
  float wk = clamp(sqrt(u_ring.w / max(dens, 1e-3)), 1.0, 12.0);
  float w = (kind > 0.5 ? 0.003 : mix(0.0065, 0.0055, meadow)) * wk * (0.75 + 0.5 * (TUFT_K > 1.0 ? b3 : r6));
  float ang = TUFT_K > 1.0 ? atan(off.y, off.x + 1e-6) + (b3 - 0.5) * 1.4 : r6 * 6.2831853 + r1 * 3.0;
  vec2 dir = vec2(cos(ang), sin(ang));
  // Wind: gusts travelling downwind, plus a quick flutter.
  vec2 wd = u_wind.xy;
  float gust = vnoise(world * 0.12 - wd * u_wind.w * (1.5 + 4.0 * u_wind.z)) ;
  float flutter = sin(u_wind.w * 3.1 + (r1 + b1) * 40.0) * 0.5 + sin(u_wind.w * 4.7 + (r2 + b2) * 30.0) * 0.3;
  float bendWind = u_wind.z * (0.25 + 0.75 * gust) * (0.6 + 0.4 * meadow) + 0.04 * flutter * (0.3 + u_wind.z);
  // Outer blades of a tuft lean out further.
  float lean = (TUFT_K > 1.0 ? 0.1 + 0.6 * sqrt(b1) * (0.6 + 0.6 * r5) : 0.15 + 0.45 * r5) * (kind > 0.5 ? 0.4 : 1.0);
  float t = a_tpl.x;
  // The blade's spine: up, bending over with t² (own lean and the wind).
  vec2 bend = dir * lean + wd * bendWind * 1.2;
  float bl = length(bend);
  vec3 spine = vec3(bend * t * t * H * 0.8, H * t * (1.0 - 0.25 * min(bl, 1.2) * t * t));
  vec3 tangent = normalize(vec3(bend * 2.0 * t * H * 0.8, H * (1.0 - 0.75 * min(bl, 1.2) * t * t)));
  vec3 side = normalize(vec3(-dir.y, dir.x, 0.0));
  float taper = kind > 1.5 ? (t > 0.86 ? 3.2 : 1.0) : kind > 0.5 ? (t > 0.8 ? 1.8 : 1.0) : pow(1.0 - t, 0.6);
  vec3 local = vec3(p, heightAt(p) + 0.03) + spine + side * a_tpl.y * w * taper;
  vec4 ec = czm_modelView * vec4(local, 1.0);
  v_positionEC = ec.xyz;
  gl_Position = czm_projection * ec;
  vec3 n = cross(side, tangent);
  v_nEC = normalize(czm_normal * n);
  v_sideEC = normalize(czm_normal * side);
  v_tu = vec2(t, a_tpl.y);
  v_kind = kind;
  // Colour: the ground's, varied per blade and in patches (drier, lusher).
  // Grass is lighter and yellower than Sentinel-2's 10 m average of it (soil, shade in it).
  float dry = max(smoothstep(0.45, 0.9, vnoise(world * 0.09 + 5.0)) * meadow * 0.6, 1.0 - lush);
  vec3 c = m.rgb * mix(vec3(1.18, 1.24, 0.95), vec3(1.04, 1.0, 0.92), dry) + vec3(0.02, 0.03, 0.0) * (1.0 - dry);
  c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.15);
  // Dry blades: straw, a third of them dead grey-brown; partly dry tufts keep green near the
  // root (the new growth), going straw towards the tips.
  vec3 straw = b3 > 0.68 ? vec3(0.5, 0.45, 0.34) : mix(vec3(0.76, 0.66, 0.42), vec3(0.68, 0.6, 0.38), b2);
  float partial = clamp(dry * (1.0 - dry) * 4.0, 0.0, 1.0);
  float dryHere = dry * (0.55 + 0.35 * r4) * mix(1.0, smoothstep(0.0, 0.7, a_tpl.x), partial);
  c = mix(c, straw, dryHere);
  c = mix(c, vec3(0.16, 0.28, 0.08), (1.0 - dry) * 0.25 * r5);
  v_dry = dry;
  // Per-blade brightness: lively close up, calmer further out (speckle at 20 m).
  c *= 1.0 + ((TUFT_K > 1.0 ? 0.5 * (r2 + b2) : r2) - 0.5) * 0.3 * (1.0 - 0.7 * smoothstep(4.0, 25.0, d));
  if (kind > 1.5) {
    float f = vnoise(world * 0.04 + 23.0);
    v_col = f < 0.4 ? vec3(0.95, 0.94, 0.88) : f < 0.7 ? vec3(0.98, 0.82, 0.12) : vec3(0.62, 0.42, 0.78);
    v_col = t > 0.86 ? v_col : c * 0.9;
  } else if (kind > 0.5) {
    v_col = t > 0.8 ? mix(c, vec3(0.62, 0.55, 0.38), 0.7) : c;
  } else v_col = c;
}`;

const FS = /* glsl */ `
in vec3 v_positionEC;
in vec3 v_col;
in vec3 v_nEC;
in vec3 v_sideEC;
in vec2 v_tu;
in float v_kind;
in float v_dry;
void main() {
  vec3 V = normalize(-v_positionEC);
  vec3 n = normalize(v_nEC);
  if (dot(n, V) < 0.0) n = -n;
  // Rounded across the width.
  n = normalize(n + v_sideEC * v_tu.y * 0.55);
  vec3 L = czm_lightDirectionEC;
  float t = v_tu.x;
  // Shade of the grass above: dark roots, lit tips.
  // (Dry tufts stand sparse on open ground: less shade from the grass round them.)
  float ao = mix(mix(0.55, 0.72, v_dry), 1.0, smoothstep(0.0, 0.7, t));
  float ndl = dot(n, L);
  float diff = max(ndl, 0.0) * 0.6 + 0.4;
  // Light through the blade, seen against the sun.
  // Dry blades are thin and papery: less light through them, and warm.
  float back = pow(max(dot(-V, L), 0.0), 3.0) * (0.35 + 0.65 * t) * (v_kind > 1.5 && t > 0.86 ? 0.2 : 1.0) * mix(1.0, 0.55, v_dry);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 40.0) * 0.12 * t * mix(1.0, 0.45, v_dry);
  vec3 sun = czm_lightColor;
  vec3 sky = LOOK_AMBIENT * 0.5 + LOOK_GROUND_SKY;
  // Tips catch more light and go yellow-green.
  // (Dry tips bleach paler.)
  vec3 col = mix(v_col, v_col * mix(vec3(1.12, 1.15, 0.8), vec3(1.14, 1.1, 0.98), v_dry), smoothstep(0.5, 1.0, t));
  vec3 c = col * (sun * diff * 0.9 + sky) * ao + col * mix(vec3(1.05, 1.15, 0.55), vec3(1.1, 0.95, 0.6), v_dry) * sun * back * 0.7 + sun * spec;
  out_FragColor = vec4(c, 1.0);
}`;

export interface GrassFieldOptions {
  /** Blades per m² under the camera. */
  density: number;
  /** Blades per tuft (1: single blades scattered). */
  tuft?: number;
  /** Re-made maps follow this (the glider). */
  google3d?: Google3D;
}

interface Field {
  centre: Cartographic;
  /** Global patch index of the centre. */
  gpatch: [number, number];
  model: Matrix4;
  heights: Float32Array;
  textures: { mask: unknown; params: unknown; height: unknown; corr: unknown };
  corr: Float32Array;
  /** Google minus ours as sampled (NaN: no answer yet). */
  raw: Float32Array;
  corrNext: number;
  /** When the last full pass ended (passes repeat: tiles sharpen after the first). */
  corrPassT: number;
}

export class GrassField {
  private readonly worker = new Worker(new URL("./grass-worker.ts", import.meta.url), { type: "module" });
  private field: Field | undefined;
  private pending: { id: number; gpatch: [number, number]; centre: Cartographic } | undefined;
  private nextId = 1;
  private program: unknown;
  private tplBuffers: unknown[] = [];
  private tplIndex: unknown[] = [];
  private ringBuffers: { buffer: unknown; size: number; va: unknown; cmd: unknown }[] = [];
  private readonly camLocal = new Cartesian3();
  private wind = { dir: new Cartesian2(1, 0), strength: 0.2 };
  private fade = 0;
  private readonly kx: number;
  private readonly t0 = performance.now();
  private corrApplied = 0;
  show = true;

  constructor(
    private readonly viewer: Viewer,
    private readonly osmUrl: string,
    private readonly s2Url: string,
    private readonly o: GrassFieldOptions,
    latDeg: number,
  ) {
    this.kx = 111_320 * Math.cos((latDeg * Math.PI) / 180);
    this.worker.onmessage = (e: MessageEvent<FieldResult & { error?: string }>) => this.received(e.data);
    viewer.scene.primitives.add(this);
  }

  /** The maps round the glider are in (grass can be drawn). */
  get ready(): boolean {
    return !!this.field;
  }

  /** Not wanted now (the camera too high above the ground). */
  get idle(): boolean {
    return this.fade <= 0;
  }

  /** The day's wind: from [deg], speed [kt]. */
  setWind(fromDeg: number, kt: number): void {
    const to = ((fromDeg + 180) * Math.PI) / 180;
    this.wind = { dir: new Cartesian2(Math.sin(to), Math.cos(to)), strength: Math.min(1, kt / 25) };
  }

  /**
   * Each frame: the glider's position (the maps follow it) and the camera's height above
   * the ground (grass only near it).
   */
  follow(latDeg: number, lonDeg: number, cameraAglM: number): void {
    this.fade = 1 - Math.min(1, Math.max(0, (cameraAglM - 25) / 15));
    if (this.fade <= 0 && this.field) return;
    const gx = Math.round((lonDeg * this.kx) / PATCH), gy = Math.round((latDeg * 111_132) / PATCH);
    const f = this.pending ?? this.field;
    if (f && Math.hypot(gx - f.gpatch[0], gy - f.gpatch[1]) * PATCH < RECENTRE_M) return;
    if (this.fade <= 0) return;
    const centre = Cartographic.fromDegrees((gx * PATCH) / this.kx, (gy * PATCH) / 111_132);
    const id = this.nextId++;
    this.pending = { id, gpatch: [gx, gy], centre };
    const req: FieldRequest = { id, lat: (centre.latitude * 180) / Math.PI, lon: (centre.longitude * 180) / Math.PI, sizeM: FIELD_M, res: FIELD_RES, heightRes: HEIGHT_RES, osmUrl: this.osmUrl, s2Url: this.s2Url };
    this.worker.postMessage(req);
  }

  private received(r: FieldResult & { error?: string }): void {
    const p = this.pending;
    if (!p || p.id !== r.id) return;
    this.pending = undefined;
    if (r.error) return console.warn("grass field:", r.error);
    const context = (this.viewer.scene as unknown as { context: unknown }).context;
    const tex = (w: number, h: number, data: ArrayBufferView, float: boolean) =>
      new C.Texture({
        context,
        width: w,
        height: h,
        pixelFormat: float ? C.PixelFormat.RED : C.PixelFormat.RGBA,
        pixelDatatype: float ? C.PixelDatatype.FLOAT : C.PixelDatatype.UNSIGNED_BYTE,
        source: { arrayBufferView: data },
        flipY: false,
        sampler: new C.Sampler({
          wrapS: C.TextureWrap.CLAMP_TO_EDGE,
          wrapT: C.TextureWrap.CLAMP_TO_EDGE,
          minificationFilter: float ? C.TextureMinificationFilter.NEAREST : C.TextureMinificationFilter.LINEAR,
          magnificationFilter: float ? C.TextureMagnificationFilter.NEAREST : C.TextureMagnificationFilter.LINEAR,
        }),
      });
    const centre = Cartographic.clone(p.centre);
    centre.height = r.originM;
    const corr = new Float32Array(CORR_N * CORR_N);
    const old = this.field;
    this.field = {
      centre,
      gpatch: p.gpatch,
      model: Transforms.eastNorthUpToFixedFrame(Cartographic.toCartesian(centre)),
      heights: r.heights,
      textures: { mask: tex(FIELD_RES, FIELD_RES, r.mask, false), params: tex(FIELD_RES, FIELD_RES, r.params, false), height: tex(HEIGHT_RES, HEIGHT_RES, r.heights, true), corr: tex(CORR_N, CORR_N, corr, true) },
      corr,
      raw: new Float32Array(CORR_N * CORR_N).fill(NaN),
      corrNext: 0,
      corrPassT: 0,
    };
    if (old) for (const t of Object.values(old.textures)) (t as { destroy(): void }).destroy();
  }

  /**
   * Google's ground minus ours, a few grid points per frame (tileset picks are not free),
   * pass after pass every few seconds (finer tiles arrive after the first). Google's surface
   * includes vehicles, sheds and trees, which lifted the blades round them into the air: the
   * correction used is the median of the samples within one grid step (a lone object drops
   * out; the lowest instead sank the short airfield grass below Google's bumpy ground), kept
   * within ±1.5 m of the field's median. Buildings are out of the grass mask anyway.
   */
  private correct(): void {
    const f = this.field, g = this.o.google3d;
    if (!f || !g) return;
    const N = CORR_N * CORR_N, now = performance.now();
    if (f.corrNext >= N) {
      if (now - f.corrPassT < 5000) return;
      f.corrNext = 0;
    }
    // The first pass quickly (1.5 ms a frame); later ones, for the tiles that sharpened since,
    // in the background (0.3 ms a frame).
    const budget = f.corrPassT > 0 ? 0.3 : 1.5;
    const half = FIELD_M / 2, step = FIELD_M / (CORR_N - 1);
    const p = new Cartesian3(), carto = new Cartographic();
    while (f.corrNext < N && performance.now() - now < budget) {
      // Nearest the centre (the glider) first: it matters most and comes right away.
      const k = CORR_ORDER[f.corrNext++]!, i = k % CORR_N, j = Math.floor(k / CORR_N);
      Matrix4.multiplyByPoint(f.model, Cartesian3.fromElements(i * step - half, j * step - half, 0, p), p);
      Cartographic.fromCartesian(p, undefined, carto);
      const gh = g.tileset.getHeight(carto, this.viewer.scene);
      if (gh === undefined || !Number.isFinite(gh)) continue;
      const hi = Math.round((i / (CORR_N - 1)) * (HEIGHT_RES - 1)), hj = Math.round((j / (CORR_N - 1)) * (HEIGHT_RES - 1));
      const c = gh - (f.centre.height + f.heights[hj * HEIGHT_RES + hi]!);
      if (Math.abs(c) < 8) f.raw[k] = c;
    }
    // The first pass is applied as it goes (near the glider first); later ones when done.
    // The first pass is applied as it goes (near the glider first), twice a second; later ones
    // when done (the filter below takes ~10 ms).
    if (f.corrNext < N && (f.corrPassT > 0 || now - this.corrApplied < 500)) return;
    this.corrApplied = now;
    if (f.corrNext >= N) f.corrPassT = now;
    const vals = [...f.raw].filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return;
    const med = vals[Math.floor(vals.length / 2)]!;
    for (let j = 0; j < CORR_N; j++)
      for (let i = 0; i < CORR_N; i++) {
        const around = (rad: number) => {
          const nb: number[] = [];
          for (let dj = -rad; dj <= rad; dj++)
            for (let di = -rad; di <= rad; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= CORR_N || jj >= CORR_N) continue;
              const v = f.raw[jj * CORR_N + ii]!;
              if (Number.isFinite(v)) nb.push(v);
            }
          nb.sort((a, b) => a - b);
          return nb.length ? nb[Math.floor(nb.length / 2)]! : med;
        };
        // Within ±4 m; but well above the ground within ±16 m it is a larger object (a row of
        // trees, a parked trailer): that wider figure then.
        const m3 = around(1);
        // (The wide median only where this one stands out: it is the costly part.)
        const m = m3 - med > 0.25 ? Math.min(m3, around(4) + 0.3) : m3;
        f.corr[j * CORR_N + i] = Math.min(med + 1.5, Math.max(med - 1.5, m));
      }
    (f.textures.corr as { copyFrom(o: unknown): void }).copyFrom({ source: { width: CORR_N, height: CORR_N, arrayBufferView: f.corr } });
  }

  /** Cesium primitive interface: the draw commands for this frame. */
  update(frameState: { commandList: unknown[]; context: unknown; cullingVolume: { computeVisibility(b: BoundingSphere): number }; passes: { render: boolean } }): void {
    const f = this.field;
    if (!this.show || !f || this.fade <= 0 || !frameState.passes.render) return;
    this.correct();
    const context = frameState.context;
    if (!this.program) this.init(context);
    // Camera in field metres.
    const inv = Matrix4.inverseTransformation(f.model, new Matrix4());
    Matrix4.multiplyByPoint(inv, this.viewer.camera.positionWC, this.camLocal);
    const cam = this.camLocal;
    const K = this.o.tuft ?? 1;
    // Tufts per m² (the same blades per m²).
    const D0 = this.o.density / K;
    const bs = new BoundingSphere();
    const wp = new Cartesian3();
    RINGS.forEach((ring, ri) => {
      const rb = this.ringBuffers[ri]!;
      const ringMax = D0 * Math.min(1, (FULL_R * FULL_R) / Math.max(ring.r0 * ring.r0, 1e-3));
      const per = Math.max(1, Math.ceil(ringMax * PATCH * PATCH));
      // Patches overlapping the ring and in view.
      const list: number[] = [];
      const lim = Math.ceil((ring.r1 + PATCH) / PATCH);
      const cx = Math.floor(cam.x / PATCH), cy = Math.floor(cam.y / PATCH);
      for (let j = cy - lim; j <= cy + lim; j++)
        for (let i = cx - lim; i <= cx + lim; i++) {
          const x0 = i * PATCH, y0 = j * PATCH;
          if (Math.abs(x0) > FIELD_M / 2 - PATCH || Math.abs(y0) > FIELD_M / 2 - PATCH) continue;
          const nx = Math.max(x0, Math.min(cam.x, x0 + PATCH)), ny = Math.max(y0, Math.min(cam.y, y0 + PATCH));
          const dNear = Math.hypot(nx - cam.x, ny - cam.y);
          const dFar = Math.max(Math.hypot(x0 - cam.x, y0 - cam.y), Math.hypot(x0 + PATCH - cam.x, y0 - cam.y), Math.hypot(x0 - cam.x, y0 + PATCH - cam.y), Math.hypot(x0 + PATCH - cam.x, y0 + PATCH - cam.y));
          if (dFar < ring.r0 || dNear >= ring.r1 || dNear >= FADE_R1) continue;
          const hi = Math.min(HEIGHT_RES - 1, Math.max(0, Math.round(((x0 + PATCH / 2 + FIELD_M / 2) / FIELD_M) * (HEIGHT_RES - 1))));
          const hj = Math.min(HEIGHT_RES - 1, Math.max(0, Math.round(((y0 + PATCH / 2 + FIELD_M / 2) / FIELD_M) * (HEIGHT_RES - 1))));
          Matrix4.multiplyByPoint(f.model, Cartesian3.fromElements(x0 + PATCH / 2, y0 + PATCH / 2, f.heights[hj * HEIGHT_RES + hi]! + 0.3, wp), bs.center);
          bs.radius = PATCH * 0.75 + 1.2;
          if (frameState.cullingVolume.computeVisibility(bs) === Intersect.OUTSIDE) continue;
          list.push(x0, y0);
        }
      const count = list.length / 2;
      if (!count) return;
      const data = new Float32Array(list);
      if (rb.size < data.length) {
        (rb.buffer as { destroy?(): void } | undefined)?.destroy?.();
        (rb.va as { destroy?(): void } | undefined)?.destroy?.();
        rb.size = Math.max(data.length, 2 * rb.size, 512);
        rb.buffer = C.Buffer.createVertexBuffer({ context, sizeInBytes: rb.size * 4, usage: C.BufferUsage.DYNAMIC_DRAW });
        (rb.buffer as { vertexArrayDestroyable: boolean }).vertexArrayDestroyable = false;
        rb.va = undefined;
      }
      (rb.buffer as { copyFromArrayView(a: Float32Array, o?: number): void }).copyFromArrayView(data, 0);
      if (!rb.va) {
        rb.va = new C.VertexArray({
          context,
          indexBuffer: this.tplIndex[ring.segments],
          attributes: [
            { index: 0, vertexBuffer: this.tplBuffers[ring.segments], componentsPerAttribute: 3, componentDatatype: C.ComponentDatatype.FLOAT },
            { index: 1, vertexBuffer: rb.buffer, componentsPerAttribute: 2, componentDatatype: C.ComponentDatatype.FLOAT, instanceDivisor: per },
          ],
        });
        rb.cmd = undefined;
      }
      const verts = 3 * (2 * (ring.segments - 1) + 1) * K;
      const self = this;
      if (!rb.cmd) {
        rb.cmd = new C.DrawCommand({
          vertexArray: rb.va,
          primitiveType: C.PrimitiveType.TRIANGLES,
          shaderProgram: this.program,
          renderState: C.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } }),
          pass: C.Pass.OPAQUE,
          owner: this,
          receiveShadows: !!this.viewer.shadows,
          castShadows: false,
          cull: false,
          uniformMap: {},
        });
      }
      const cmd = rb.cmd as Record<string, unknown>;
      cmd["count"] = verts;
      cmd["instanceCount"] = count * per;
      cmd["modelMatrix"] = f.model;
      cmd["boundingVolume"] = new BoundingSphere(Matrix4.multiplyByPoint(f.model, new Cartesian3(cam.x, cam.y, 0), new Cartesian3()), ring.r1 + 5);
      const tx = f.textures, w = this.wind, t = (performance.now() - self.t0) / 1000, fade = this.fade;
      cmd["uniformMap"] = {
        u_mask: () => tx.mask,
        u_params: () => tx.params,
        u_height: () => tx.height,
        u_corr: () => tx.corr,
        u_gpatch: () => new Cartesian2(((f.gpatch[0] % 4096) + 4096) % 4096, ((f.gpatch[1] % 4096) + 4096) % 4096),
        u_cam: () => cam,
        u_ring: () => new Cesium.Cartesian4(ring.r0, ring.r1, per, D0),
        u_wind: () => new Cesium.Cartesian4(w.dir.x, w.dir.y, w.strength, t),
        u_fade: () => fade,
        u_seg: () => ring.segments,
      };
      frameState.commandList.push(rb.cmd);
    });
  }

  private init(context: unknown): void {
    const K = this.o.tuft ?? 1;
    const lookFs = FS.replaceAll("LOOK_AMBIENT", `vec3(${LOOK.ambient.map((v) => v.toFixed(4)).join(", ")})`).replaceAll("LOOK_GROUND_SKY", `vec3(${LOOK.groundSky.map((v) => v.toFixed(4)).join(", ")})`);
    this.program = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS.replaceAll("TUFT_K", K.toFixed(1)), fragmentShaderSource: lookFs, attributeLocations: { a_tpl: 0, a_patch: 1 } });
    // Templates: K blades of n segments (two vertices per level, one at the tip), as triangles.
    for (const n of new Set(RINGS.map((r) => r.segments))) {
      const v: number[] = [];
      const idx: number[] = [];
      for (let b = 0; b < K; b++) {
        const base = b * (2 * n + 1);
        for (let i = 0; i < n; i++) v.push(i / n, -1, b, i / n, 1, b);
        v.push(1, 0, b);
        // Indexed: the vertex shader runs once per vertex, as with a strip.
        for (let i = 0; i < n - 1; i++) idx.push(base + 2 * i, base + 2 * i + 1, base + 2 * i + 2, base + 2 * i + 1, base + 2 * i + 3, base + 2 * i + 2);
        idx.push(base + 2 * n - 2, base + 2 * n - 1, base + 2 * n);
      }
      const ib = C.Buffer.createIndexBuffer({ context, typedArray: new Uint16Array(idx), usage: C.BufferUsage.STATIC_DRAW, indexDatatype: C.IndexDatatype.UNSIGNED_SHORT });
      ib.vertexArrayDestroyable = false;
      this.tplIndex[n] = ib;
      const b = C.Buffer.createVertexBuffer({ context, typedArray: new Float32Array(v), usage: C.BufferUsage.STATIC_DRAW });
      b.vertexArrayDestroyable = false; // shared by the rings' vertex arrays
      this.tplBuffers[n] = b;
    }
    this.ringBuffers = RINGS.map(() => ({ buffer: undefined, size: 0, va: undefined, cmd: undefined }));
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    this.worker.terminate();
    if (this.field) for (const t of Object.values(this.field.textures)) (t as { destroy(): void }).destroy();
    for (const rb of this.ringBuffers) {
      (rb.va as { destroy?(): void } | undefined)?.destroy?.();
      (rb.buffer as { destroy?(): void } | undefined)?.destroy?.();
    }
    for (const b of [...this.tplBuffers, ...this.tplIndex]) (b as { destroy?(): void } | undefined)?.destroy?.();
  }
}
