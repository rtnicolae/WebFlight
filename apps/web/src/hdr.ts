/**
 * HDR: the scene in linear light with values above white, finished by our own stages after
 * the volumetric clouds: bloom (bright pass, two blur levels), exposure, tonemapping, gamma.
 *
 * Why our own: Cesium tonemaps before any stage we add, so the clouds (a post-process ray
 * march) were composited on an already tonemapped, 8-bit picture. Their march computes light
 * (sun × transmittance × phase + sky), i.e. linear radiance, which was shown as if it were
 * display values: every mid-tone too dark (grey clouds), tops clipped at white. Here the
 * clouds go into the linear HDR scene before the tonemap, and what is brighter than white
 * (sunlit tops, the sun's glare, glints) blooms. Cesium's tonemapping stage is kept off
 * (internal: it re-enables it on every update, so its update is wrapped).
 *
 * In LDR mode Cesium tonemaps (PBR Neutral) per pixel in model lighting, sky and fog and
 * stores display values; in HDR it stores linear values and tonemaps once at the end. Our
 * own draw commands output display values: they go through czm_gammaCorrect (identity in
 * LDR, display → linear in HDR). The fog on Google's tiles is the one real difference: in
 * LDR its colour is tonemapped before it is blended in, in HDR the raw (much brighter) one
 * is, which washed the distance out; google3d.ts scales it down in HDR.
 *
 * On for flights (the menu stays LDR); ?hdr=0 or quality=low: off. Measured (M1 Pro, Brave, clouds
 * on): 2–6% of the frame rate. Compared with LDR in the same views: clouds white instead of grey,
 * the ground the same (the tonemap is PBR Neutral without its dark offset), a warm glow along the
 * horizon at sunset.
 */
import { Cartesian2, Cartesian4, PixelDatatype, PostProcessStage, PostProcessStageComposite, type Viewer } from "cesium";

interface StagesInternal {
  update(...a: unknown[]): void;
  _tonemapping?: { enabled: boolean };
  __wfOwnTonemap?: boolean;
}

/** HDR on and Cesium's own tonemapping off; false if the GPU can't. */
export function enableHdr(viewer: Viewer): boolean {
  const scene = viewer.scene;
  if (!scene.highDynamicRangeSupported) return false;
  const pp = scene.postProcessStages as unknown as StagesInternal;
  if (pp.__wfOwnTonemap === undefined) {
    const update = pp.update.bind(pp);
    pp.update = (...a: unknown[]) => {
      update(...a);
      if (pp.__wfOwnTonemap && pp._tonemapping) pp._tonemapping.enabled = false;
    };
  }
  pp.__wfOwnTonemap = true;
  scene.highDynamicRange = true;
  return true;
}

export function disableHdr(viewer: Viewer): void {
  (viewer.scene.postProcessStages as unknown as StagesInternal).__wfOwnTonemap = false;
  viewer.scene.highDynamicRange = false;
}

// At a quarter of the resolution: 4 reads spread over the 4×4 full-resolution pixels it stands
// for (one read made a lone glint a blocky square), each clamped (a few pixels of the sun's
// glint on the wing are hundreds of times white).
const BRIGHT_FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform float u_threshold;
in vec2 v_textureCoordinates;
void main() {
  vec2 px = 1.0 / vec2(textureSize(colorTexture, 0));
  vec3 c = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k == 0 || k == 2 ? -1.0 : 1.0, k < 2 ? -1.0 : 1.0) * px;
    vec3 s = texture(colorTexture, v_textureCoordinates + o).rgb;
    c += s * min(1.0, 16.0 / max(max(s.r, max(s.g, s.b)), 1e-4));
  }
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  // What is above the threshold, soft-kneed.
  float k = max(l - u_threshold, 0.0);
  out_FragColor = vec4(c * (k * k / (k + 0.25)) / max(l, 1e-4), 1.0);
}`;

// 9-tap Gaussian through 5 bilinear reads.
const BLUR_FS = /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_dir;
in vec2 v_textureCoordinates;
void main() {
  vec2 px = u_dir / vec2(textureSize(u_src, 0));
  vec2 uv = v_textureCoordinates;
  vec3 s = texture(u_src, uv).rgb * 0.227027;
  s += (texture(u_src, uv + px * 1.384615).rgb + texture(u_src, uv - px * 1.384615).rgb) * 0.316216;
  s += (texture(u_src, uv + px * 3.230769).rgb + texture(u_src, uv - px * 3.230769).rgb) * 0.070270;
  out_FragColor = vec4(s, 1.0);
}`;

// Khronos PBR Neutral without its dark offset: identity below 0.76, highlights rolled off to
// white with a little desaturation. The offset (up to 0.04 subtracted in the darks) darkened
// Google's tiles, which are unlit and in LDR never tonemapped.
const FINISH_FS = /* glsl */ `
vec3 wfNeutral(vec3 c) {
  const float start = 0.76, d = 0.24;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
uniform sampler2D colorTexture;
uniform sampler2D u_bloomNear;
uniform sampler2D u_bloomWide;
uniform float u_exposure;
uniform float u_bloom;
uniform vec4 u_grade;   // saturation, contrast, split toning, vignette
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 f = texture(colorTexture, uv);
  vec3 b = 0.6 * texture(u_bloomNear, uv).rgb + 0.4 * texture(u_bloomWide, uv).rgb;
  vec3 c = max((f.rgb + b * u_bloom) * u_exposure, vec3(0.0));
  // The grade, in linear light before the tonemap:
  // saturation round the pixel's luminance,
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(lum), c, u_grade.x), vec3(0.0));
  // contrast as a power round mid-grey (0.18): darks deeper, lights brighter, mid-grey kept,
  c = 0.18 * pow(c / 0.18 + 1e-6, vec3(u_grade.y));
  // split toning: shadows a touch teal, highlights a touch warm (by luminance after contrast).
  float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float hi = smoothstep(0.05, 0.6, l2);
  c *= mix(vec3(0.96, 1.0, 1.05), vec3(1.04, 1.0, 0.95), hi) * (1.0 - u_grade.z) + vec3(u_grade.z);
  c = wfNeutral(c);
  // A light vignette (display values).
  vec2 v = uv - 0.5;
  c *= 1.0 - u_grade.w * smoothstep(0.25, 0.85, dot(v, v) * 2.2);
  out_FragColor = vec4(czm_inverseGamma(c), f.a);
}`;

export interface FinishOptions {
  exposure?: number;
  /** Bloom strength (0: off). */
  bloom?: number;
  /** Linear brightness above which things bloom. */
  threshold?: number;
  /** Saturation (1: as rendered). */
  saturation?: number;
  /** Contrast round mid-grey (1: as rendered). */
  contrast?: number;
  /** Teal shadows / warm highlights: 1 full, 0 none. */
  tone?: number;
  /** Corner darkening, 0–1. */
  vignette?: number;
}

/** The finishing stages, added after everything else (call after the clouds are created). */
export class HdrFinish {
  readonly stage: PostProcessStageComposite;
  readonly settings: Required<FinishOptions>;

  constructor(viewer: Viewer, opts: FinishOptions = {}) {
    // The look (owner: "bump saturation and contrast to where it looks cinematic and awesome").
    const st = (this.settings = { exposure: opts.exposure ?? 1, bloom: opts.bloom ?? 0.35, threshold: opts.threshold ?? 1.2, saturation: opts.saturation ?? 1.35, contrast: opts.contrast ?? 1.22, tone: opts.tone ?? 1, vignette: opts.vignette ?? 0.18 });
    const half = PixelDatatype.HALF_FLOAT;
    const bright = new PostProcessStage({ fragmentShader: BRIGHT_FS, textureScale: 0.25, pixelDatatype: half, uniforms: { u_threshold: () => st.threshold } });
    const blur = (src: string, x: number, scale: number) => new PostProcessStage({ fragmentShader: BLUR_FS, textureScale: scale, pixelDatatype: half, uniforms: { u_src: src, u_dir: new Cartesian2(x, 1 - x) } });
    const nearH = blur(bright.name, 1, 0.25);
    const nearV = blur(nearH.name, 0, 0.25);
    const wideH = blur(nearV.name, 1, 0.125);
    const wideV = blur(wideH.name, 0, 0.125);
    const finish = new PostProcessStage({ fragmentShader: FINISH_FS, uniforms: { u_bloomNear: nearV.name, u_bloomWide: wideV.name, u_exposure: () => st.exposure, u_bloom: () => st.bloom, u_grade: () => new Cartesian4(st.saturation, st.contrast, 1 - st.tone, st.vignette) } });
    this.stage = new PostProcessStageComposite({ stages: [bright, nearH, nearV, wideH, wideV, finish], inputPreviousStageTexture: false });
    viewer.scene.postProcessStages.add(this.stage);
  }
}
