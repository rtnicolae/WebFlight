/**
 * The per-pixel part of a detail tile on the GPU: the edge-aware upsampling of the satellite
 * mosaic and the synthesis (synth.ts: HD textures at two scales with relief, near-ground
 * colours, town lawns and paving, forest canopy) as one fragment shader, in a WebGL 2 context
 * of the worker. It is the same arithmetic as the CPU code, which stays as the reference and
 * the fallback (no WebGL 2 in workers, or a lost context): same integer hashes, same lattice
 * noise, same mip level choices, so both give the same picture to within rounding.
 *
 * World coordinates are millions of metres: too large for 32-bit floats at centimetre
 * detail. Everything periodic (noise lattices, texture repeats) therefore gets its origin
 * from the CPU in double precision (integer cell + fraction at the tile's corner), and the
 * shader only adds the small offset within the tile.
 */
import type { GroundTextures, SynthOptions } from "./synth.ts";
import { canopyMean, DRY, LUSH, NEAR_COLOUR, SOIL, zoomed } from "./synth.ts";
import { CHROMA, MACRO, MACRO_GAIN, MICRO_GAIN, RELIEF_MACRO, RELIEF_MICRO, ROTATIONS, type DetailTexture } from "./textures.ts";

/** Lattice scales [m] used by the noises (index = position here). */
const SCALES = [240, 1.2, 7, 6, 0.7, 4, 35, 3.5, 0.9, 60, 23, 2, 8, 11, 75, 4.2] as const;
const S = (m: (typeof SCALES)[number]) => SCALES.indexOf(m);
const TEX = ["grass", "dryGrass", "soil", "drySoil", "paved"] as const;
/** Offsets of the four samples (micro 1, micro 2, macro 1, macro 2) before rotation [m]. */
const OFFSETS = [[0, 0], [2.3, -3.9], [13.7, -29.3], [13.7 + 17.1, -29.3 - 23.9]] as const;
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const v3 = (a: readonly number[]) => `vec3(${a.map(f).join(", ")})`;

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const sampleFn = (i: number) => `
// Texture ${TEX[i]}: two scales, each two rotated samples mixed by noise, with relief.
vec3 sample${i}() {
  vec3 mic = vec3(1.0), mac = vec3(1.0);
  float rm = 0.0, rM = 0.0;
  int lm = u_level[${2 * i}], lM = u_level[${2 * i + 1}];
  float m = u_meters[${i}];
  if (lm >= 0) {
    vec2 a = u_uv0[${4 * i}] + rot(0) / m, b = u_uv0[${4 * i + 1}] + rot(1) / m;
    mic = 1.0 + ((textureLod(u_ratio${i}, a, float(lm)).rgb - 1.0) * (1.0 - g_wm) + (textureLod(u_ratio${i}, b, float(lm)).rgb - 1.0) * g_wm) * g_km;
    if (u_hasSlope[${i}]) rm = -(slope(u_slope${i}, a, lm, 0) * (1.0 - g_wm) + slope(u_slope${i}, b, lm, 1) * g_wm);
  }
  if (lM >= 0) {
    vec2 a = u_uv0[${4 * i + 2}] + rot(2) / (m * ${f(MACRO)}), b = u_uv0[${4 * i + 3}] + rot(3) / (m * ${f(MACRO)});
    mac = 1.0 + ((textureLod(u_ratio${i}, a, float(lM)).rgb - 1.0) * (1.0 - g_wM) + (textureLod(u_ratio${i}, b, float(lM)).rgb - 1.0) * g_wM) * g_kM;
    if (u_hasSlope[${i}]) rM = -(slope(u_slope${i}, a, lM, 2) * (1.0 - g_wM) + slope(u_slope${i}, b, lM, 3) * g_wM);
  }
  float relief = clamp(rm * ${f(RELIEF_MICRO)}, -0.45, 0.6) + clamp(rM * ${f(RELIEF_MACRO)}, -0.3, 0.35);
  float a1 = (mic.r + mic.g + mic.b) / 3.0, a2 = (mac.r + mac.g + mac.b) / 3.0;
  float L = (1.0 + (a1 - 1.0) * ${f(MICRO_GAIN)}) * (1.0 + (a2 - 1.0) * ${f(MACRO_GAIN)}) * (1.0 + relief);
  return max(vec3(0.3), L * (1.0 + (mic - a1) * ${f(CHROMA)}));
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
out vec4 o_color;

uniform sampler2D u_sat;      // satellite mosaic, RGBA8
uniform int u_satN;
uniform vec3 u_src;           // source window: x0, y0, span [source px]
uniform float u_snap;
uniform bool u_urbanCover;
uniform usampler2D u_cover;   // land cover per pixel (0 unknown, else index + 1)
uniform int u_size;
uniform float u_mPerPx;
uniform float u_zoomed;
uniform vec3 u_sun;           // x, y towards the sun; cot(elevation)
uniform float u_canopyMean;
uniform ivec2 u_nCell[${SCALES.length}];
uniform vec2 u_nFrac[${SCALES.length}];
uniform float u_nInv[${SCALES.length}];
uniform vec2 u_uv0[${TEX.length * 4}];
uniform float u_meters[${TEX.length}];
uniform int u_level[${TEX.length * 2}];
uniform bool u_hasSlope[${TEX.length}];
uniform vec2 u_sunT[4];
${TEX.map((_, i) => `uniform sampler2D u_ratio${i};\nuniform sampler2D u_slope${i};`).join("\n")}

const vec2 ROT[4] = vec2[4](${ROTATIONS.map(([c, s]) => `vec2(${c}, ${s})`).join(", ")});
vec2 g_l;                     // this pixel's offset from the tile's corner [m] (x east, y north)
float g_wm, g_km, g_wM, g_kM;

float u01(uint h) { return float(h) * (1.0 / 4294967296.0); }
uint hash2(uint x, uint y, int salt) {
  uint h = (x * 0x27d4eb2du) ^ (y * 0x165667b1u) ^ (uint(salt) * 0x9e3779b9u);
  h = (h ^ (h >> 15)) * 0x85ebca6bu;
  h = (h ^ (h >> 13)) * 0xc2b2ae35u;
  return h ^ (h >> 16);
}
uint hash2(ivec2 c, int salt) { return hash2(uint(c.x), uint(c.y), salt); }
float hashB(ivec2 c, int salt) {
  uint v = (uint(c.x) * 0x27d4eb2du) ^ (uint(c.y) * 0x165667b1u) ^ (uint(salt) * 0x9e3779b9u);
  v = (v ^ (v >> 15)) * 0x85ebca6bu;
  return u01(v ^ (v >> 13));
}
// Lattice k at this pixel: integer cell and position within it.
void lattice(int k, out ivec2 cell, out vec2 t) {
  vec2 q = u_nFrac[k] + g_l * u_nInv[k];
  vec2 c = floor(q);
  cell = u_nCell[k] + ivec2(c);
  t = q - c;
}
float valueNoise(int k, int salt) {
  ivec2 c; vec2 t;
  lattice(k, c, t);
  vec2 s = t * t * (3.0 - 2.0 * t);
  float a = u01(hash2(c, salt)), b = u01(hash2(c + ivec2(1, 0), salt));
  float d = u01(hash2(c + ivec2(0, 1), salt)), e = u01(hash2(c + ivec2(1, 1), salt));
  return (a + (b - a) * s.x) * (1.0 - s.y) + (d + (e - d) * s.x) * s.y;
}
float noiseB(int k, int salt) {
  ivec2 c; vec2 t;
  lattice(k, c, t);
  vec2 s = t * t * (3.0 - 2.0 * t);
  return (hashB(c, salt) * (1.0 - s.x) + hashB(c + ivec2(1, 0), salt) * s.x) * (1.0 - s.y) + (hashB(c + ivec2(0, 1), salt) * (1.0 - s.x) + hashB(c + ivec2(1, 1), salt) * s.x) * s.y;
}
// The pixel's offset in sample r's texture space [m]: (u, v) grows (east', south').
vec2 rot(int r) {
  vec2 cs = ROT[r];
  return vec2(g_l.x * cs.x - g_l.y * cs.y, -(g_l.x * cs.y + g_l.y * cs.x));
}
float slope(sampler2D tex, vec2 uv, int level, int r) {
  ivec2 n = textureSize(tex, level);
  vec2 g = texelFetch(tex, ivec2(floor(fract(uv) * vec2(n))) % n, level).rg;
  return dot(g, u_sunT[r]);
}
${TEX.map((_, i) => sampleFn(i)).join("\n")}
vec3 lushDry(vec3 lush, vec3 dryT, float dry) { return lush + (dryT - lush) * dry; }
vec3 grassMix(float dry) {
  if (dry < 0.08) return sample0();
  if (dry > 0.92) return sample1();
  return lushDry(sample0(), sample1(), dry);
}
vec3 soilMix(float dry) {
  if (dry < 0.08) return sample2();
  if (dry > 0.92) return sample3();
  return lushDry(sample2(), sample3(), dry);
}

vec3 satAt(ivec2 q) { return texelFetch(u_sat, clamp(q, ivec2(0), ivec2(u_satN - 1)), 0).rgb * 255.0; }
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

// Canopy brightness: crowns on a jittered 4.2 m grid, lit toward the sun, shadows away.
float crownShade() {
  const float cs = 4.2;
  ivec2 g; vec2 t;
  lattice(${S(4.2)}, g, t);
  float shade = 0.72;
  for (int dj = -1; dj <= 1; dj++)
    for (int di = -1; di <= 1; di++) {
      uint h = hash2(g + ivec2(di, dj), 21);
      vec2 c = vec2(float(di) + 0.2 + 0.6 * u01(h), float(dj) + 0.2 + 0.6 * u01(hash2(h, 1u, 0)));
      float rad = cs * (0.45 + 0.3 * u01(hash2(h, 2u, 0)));
      vec2 dd = (t - c) * cs;
      float d = length(dd) / rad;
      if (d < 1.0) shade = max(shade, 0.88 + 0.32 * (dot(dd, u_sun.xy) / rad) * (1.0 - d) + 0.1 * (1.0 - d));
      float sd = length(dd + u_sun.xy * rad * u_sun.z) / rad;
      if (sd < 1.0 && d >= 1.0) shade = min(shade, 0.62);
    }
  return shade;
}

const int CROP = 1, FOREST = 2, GRASS = 3, WATER = 4, URBAN = 5;
int classify(vec3 c) {
  float l = lum(c), green = c.g - (c.r + c.b) / 2.0;
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  if (c.b > c.g + 4.0 && c.b > c.r && l < 90.0) return WATER;
  if (l < 72.0 && green > 1.0) return FOREST;
  if (sat < 22.0 && l > 105.0) return URBAN;
  if (green > 14.0 && l > 80.0) return GRASS;
  return CROP;
}

void main() {
  float size = float(u_size);
  // Pixel (i, j), j from the top (north); the canvas's bottom row is gl_FragCoord.y = 0.5.
  vec2 ij = vec2(gl_FragCoord.x - 0.5, size - gl_FragCoord.y - 0.5);
  g_l = vec2((ij.x + 0.5) * u_mPerPx, -(ij.y + 0.5) * u_mPerPx);

  // Edge-aware upsampling of the satellite colours (synth.ts edgeAwareUpsample).
  vec2 sp = u_src.xy + ((ij + 0.5) * u_src.z) / size - 0.5;
  ivec2 p0 = ivec2(floor(sp));
  vec2 fr = sp - floor(sp);
  vec3 plain = mix(mix(satAt(p0), satAt(p0 + ivec2(1, 0)), fr.x), mix(satAt(p0 + ivec2(0, 1)), satAt(p0 + ivec2(1, 1)), fr.x), fr.y);
  float mean = 0.0;
  for (int b = -1; b <= 2; b++) for (int a = -1; a <= 2; a++) mean += lum(satAt(p0 + ivec2(a, b)));
  mean /= 16.0;
  vec3 lo = vec3(0.0), hi = vec3(0.0);
  float nl = 0.0, nh = 0.0, ll = 0.0, lh = 0.0;
  for (int b = -1; b <= 2; b++)
    for (int a = -1; a <= 2; a++) {
      vec3 c = satAt(p0 + ivec2(a, b));
      float L = lum(c);
      if (L < mean) { lo += c; nl += 1.0; ll += L; } else { hi += c; nh += 1.0; lh += L; }
    }
  vec3 snapped = plain;
  if (nl > 0.0 && nh > 0.0 && lh / nh - ll / nl > 6.0) {
    float vl = lum(plain);
    vec3 t = abs(vl - ll / nl) < abs(vl - lh / nh) ? lo / nl : hi / nh;
    snapped = plain + (t - plain) * u_snap;
  }
  // The CPU path stores both as 8-bit pixels before the synthesis reads them.
  plain = floor(plain + 0.5);
  snapped = floor(snapped + 0.5);

  int cov = int(texelFetch(u_cover, ivec2(ij), 0).r);
  int c = cov > 0 ? cov : classify(snapped);
  vec3 rgb = c == URBAN && u_urbanCover ? plain : snapped;
  float fac = 1.0;
  vec3 tex = vec3(1.0);
  const vec3 LUSH = ${v3(LUSH)}, DRY = ${v3(DRY)}, SOIL = ${v3(SOIL)};
  if (c == CROP || c == GRASS) {
    float green = rgb.g - (rgb.r + rgb.b) / 2.0;
    float t = clamp((green - 1.0) / 12.0, 0.0, 1.0);
    float dry = valueNoise(${S(240)}, 71);
    g_wm = noiseB(${S(11)}, 11); g_km = inversesqrt(g_wm * g_wm + (1.0 - g_wm) * (1.0 - g_wm));
    g_wM = noiseB(${S(75)}, 18); g_kM = inversesqrt(g_wM * g_wM + (1.0 - g_wM) * (1.0 - g_wM));
    vec3 gr = t > 0.02 ? grassMix(dry) : vec3(1.0);
    vec3 so = t < 0.98 ? soilMix(dry) : vec3(1.0);
    tex = so + (gr - so) * t;
    float near = ${f(NEAR_COLOUR)} * u_zoomed;
    if (near > 0.0) {
      float k = clamp(lum(rgb) / 70.0, 0.75, 1.25);
      vec3 target = (SOIL + ((LUSH + (DRY - LUSH) * dry) - SOIL) * t) * k;
      rgb += (target - rgb) * near;
    }
  } else if (c == FOREST) {
    fac = u_mPerPx < 1.0 ? crownShade() / u_canopyMean : 1.0 + (valueNoise(${S(6)}, 22) - 0.5) * 0.1;
  } else if (c == URBAN) {
    float green = rgb.g - (rgb.r + rgb.b) / 2.0;
    float edge = (valueNoise(${S(3.5)}, 91) - 0.5) * 10.0 + (valueNoise(${S(0.9)}, 92) - 0.5) * 3.0;
    float soft = clamp((green - 2.0) / 10.0, 0.0, 1.0);
    float hard = green + edge > 1.0 ? 1.0 : 0.0;
    float t = soft + (hard - soft) * u_zoomed;
    float dry = valueNoise(${S(60)}, 93);
    g_wm = noiseB(${S(11)}, 11); g_km = inversesqrt(g_wm * g_wm + (1.0 - g_wm) * (1.0 - g_wm));
    g_wM = noiseB(${S(75)}, 18); g_kM = inversesqrt(g_wM * g_wM + (1.0 - g_wM) * (1.0 - g_wM));
    vec3 gr = t > 0.02 ? grassMix(dry * 0.7) : vec3(1.0);
    vec3 so = t < 0.98 ? 1.0 + (sample4() - 1.0) * 0.45 : vec3(1.0);
    float l = lum(rgb);
    float k = clamp(l / 105.0, 0.8, 1.2);
    float pave = clamp(l, 70.0, 150.0) * (0.9 + 0.2 * valueNoise(${S(23)}, 94)) / k;
    float worn = max(0.0, valueNoise(${S(6)}, 95) - 0.55) * 1.6;
    float pull = 0.7 * u_zoomed;
    vec3 grassC = (LUSH + (DRY - LUSH) * dry * 0.7) * (1.0 - worn) + SOIL * worn;
    vec3 pv = vec3(pave, pave, pave * 0.97);
    vec3 target = (pv + (grassC - pv) * t) * k;
    rgb += (target - rgb) * pull;
    tex = so + (gr - so) * t;
  } else {
    fac = 1.0 + (valueNoise(${S(8)}, 51) - 0.5) * 0.04;
  }
  o_color = vec4(clamp(rgb * fac * tex, 0.0, 255.0) / 255.0, 1.0);
}`;

export interface GpuSynthInput {
  /** The satellite mosaic (n×n RGBA) and a key that identifies it (its texture is kept). */
  sat: Uint8ClampedArray;
  satN: number;
  satKey: string;
  /** Source window in the mosaic: origin and span [source pixels]. */
  sx0: number;
  sy0: number;
  span: number;
  /** Edge snapping strength (0.8, or 0 for plain bilinear). */
  snap: number;
  /** Land cover per output pixel (0 unknown, else index in COVERS + 1). */
  cover: Uint8Array;
  /** Whether the cover has any built-up land (only then is built-up ground left unsnapped). */
  urbanCover: boolean;
  o: SynthOptions;
  tex: GroundTextures;
}

export class GpuSynth {
  private readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly loc = new Map<string, WebGLUniformLocation | null>();
  private readonly sats = new Map<string, WebGLTexture>();
  private readonly coverTex: WebGLTexture;
  private texturesFor: GroundTextures | undefined;
  /** Set when the context is lost or a draw failed: the caller falls back to the CPU. */
  broken = false;

  static create(size: number): GpuSynth | undefined {
    try {
      if (typeof OffscreenCanvas === "undefined") return undefined;
      const canvas = new OffscreenCanvas(size, size);
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) return undefined;
      return new GpuSynth(canvas, gl);
    } catch (e) {
      console.warn("detail: GPU synthesis unavailable, using the CPU:", e);
      return undefined;
    }
  }

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.broken = true));
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.coverTex = gl.createTexture()!;
    // Texture units: 0 satellite, 1 cover, 2… ratio textures, then slope textures.
    gl.uniform1i(this.u("u_sat"), 0);
    gl.uniform1i(this.u("u_cover"), 1);
    TEX.forEach((_, i) => {
      gl.uniform1i(this.u(`u_ratio${i}`), 2 + i);
      gl.uniform1i(this.u(`u_slope${i}`), 2 + TEX.length + i);
    });
  }

  private u(name: string): WebGLUniformLocation | null {
    let l = this.loc.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.loc.set(name, l);
    }
    return l;
  }

  private nearest(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** The ground textures' mip pyramids (ratios, slopes), uploaded once. */
  private uploadTextures(tex: GroundTextures): void {
    const gl = this.gl;
    TEX.forEach((name, i) => {
      const t: DetailTexture = tex[name];
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      t.levels.forEach((lv, level) => gl.texImage2D(gl.TEXTURE_2D, level, gl.RGB16F, t.size >> level, t.size >> level, 0, gl.RGB, gl.FLOAT, lv));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.activeTexture(gl.TEXTURE2 + TEX.length + i);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      if (t.slopes) t.slopes.forEach((sl, level) => gl.texImage2D(gl.TEXTURE_2D, level, gl.RG16F, t.size >> level, t.size >> level, 0, gl.RG, gl.FLOAT, sl));
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array(2));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, t.slopes ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.uniform1i(this.u(`u_hasSlope[${i}]`), t.slopes ? 1 : 0);
      gl.uniform1f(this.u(`u_meters[${i}]`), t.meters);
    });
    this.texturesFor = tex;
  }

  /** Renders one tile; the returned canvas holds it until the next call (draw it at once). */
  run(q: GpuSynthInput): OffscreenCanvas | undefined {
    const gl = this.gl;
    if (this.broken || gl.isContextLost()) {
      this.broken = true;
      return undefined;
    }
    const { o, tex } = q;
    if (this.texturesFor !== tex) this.uploadTextures(tex);
    // Satellite mosaic (a few are kept: neighbouring tiles share one).
    gl.activeTexture(gl.TEXTURE0);
    let sat = this.sats.get(q.satKey);
    if (!sat) {
      sat = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, sat);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, q.satN, q.satN, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(q.sat.buffer, q.sat.byteOffset, q.sat.byteLength));
      this.nearest();
      this.sats.set(q.satKey, sat);
      if (this.sats.size > 12) {
        const k = this.sats.keys().next().value!;
        gl.deleteTexture(this.sats.get(k)!);
        this.sats.delete(k);
      }
    } else gl.bindTexture(gl.TEXTURE_2D, sat);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.coverTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, o.size, o.size, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, q.cover);
    this.nearest();

    gl.uniform1i(this.u("u_satN"), q.satN);
    gl.uniform3f(this.u("u_src"), q.sx0, q.sy0, q.span);
    gl.uniform1f(this.u("u_snap"), q.snap);
    gl.uniform1i(this.u("u_urbanCover"), q.urbanCover ? 1 : 0);
    gl.uniform1i(this.u("u_size"), o.size);
    gl.uniform1f(this.u("u_mPerPx"), o.mPerPx);
    gl.uniform1f(this.u("u_zoomed"), zoomed(o.mPerPx));
    gl.uniform3f(this.u("u_sun"), o.sunX, o.sunY, o.sunLow);
    gl.uniform1f(this.u("u_canopyMean"), canopyMean(o));
    // Lattice origins at the tile's corner, in double precision.
    const cells = new Int32Array(SCALES.length * 2), fracs = new Float32Array(SCALES.length * 2), invs = new Float32Array(SCALES.length);
    SCALES.forEach((s, k) => {
      const fx = o.x0 / s, fy = o.y0 / s, cx = Math.floor(fx), cy = Math.floor(fy);
      cells.set([cx | 0, cy | 0], k * 2);
      fracs.set([fx - cx, fy - cy], k * 2);
      invs[k] = 1 / s;
    });
    gl.uniform2iv(this.u("u_nCell"), cells);
    gl.uniform2fv(this.u("u_nFrac"), fracs);
    gl.uniform1fv(this.u("u_nInv"), invs);
    // Texture coordinates of the corner for each texture and sample; mip levels for this pixel size.
    const uv0 = new Float32Array(TEX.length * 8), levels = new Int32Array(TEX.length * 2);
    const frac = (v: number) => v - Math.floor(v);
    TEX.forEach((name, i) => {
      const t = tex[name];
      for (let r = 0; r < 4; r++) {
        const [c, s] = ROTATIONS[r]!, m = r < 2 ? t.meters : t.meters * MACRO;
        const X = o.x0 + OFFSETS[r]![0], Y = o.y0 + OFFSETS[r]![1];
        uv0.set([frac((X * c - Y * s) / m), frac(-(X * s + Y * c) / m)], (i * 4 + r) * 2);
      }
      const pick = (meters: number) => {
        const level = Math.max(0, Math.ceil(Math.log2(o.mPerPx / (meters / t.size))));
        return level < t.levels.length ? level : -1;
      };
      levels.set([pick(t.meters), pick(t.meters * MACRO)], i * 2);
    });
    gl.uniform2fv(this.u("u_uv0"), uv0);
    gl.uniform1iv(this.u("u_level"), levels);
    const sunT = new Float32Array(8);
    ROTATIONS.forEach(([c, s], r) => sunT.set([(o.sunX * c - o.sunY * s) * o.sunLow, -(o.sunX * s + o.sunY * c) * o.sunLow], r * 2));
    gl.uniform2fv(this.u("u_sunT"), sunT);

    gl.viewport(0, 0, o.size, o.size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR) {
      this.broken = true;
      return undefined;
    }
    return this.canvas;
  }
}
