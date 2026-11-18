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
import { Cartesian2, PixelDatatype, PostProcessStage, PostProcessStageComposite, type Viewer } from "cesium";

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

const BRIGHT_FS = /* glsl */ `
uniform sampler2D colorTexture;
uniform float u_threshold;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
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
in vec2 v_textureCoordinates;
void main() {
  vec4 f = texture(colorTexture, v_textureCoordinates);
  vec3 b = 0.6 * texture(u_bloomNear, v_textureCoordinates).rgb + 0.4 * texture(u_bloomWide, v_textureCoordinates).rgb;
  vec3 c = (f.rgb + b * u_bloom) * u_exposure;
  c = wfNeutral(max(c, vec3(0.0)));
  out_FragColor = vec4(czm_inverseGamma(c), f.a);
}`;

export interface FinishOptions {
  exposure?: number;
  /** Bloom strength (0: off). */
  bloom?: number;
  /** Linear brightness above which things bloom. */
  threshold?: number;
}

/** The finishing stages, added after everything else (call after the clouds are created). */
export class HdrFinish {
  readonly stage: PostProcessStageComposite;
  readonly settings: Required<FinishOptions>;

  constructor(viewer: Viewer, opts: FinishOptions = {}) {
    const st = (this.settings = { exposure: opts.exposure ?? 1, bloom: opts.bloom ?? 0.35, threshold: opts.threshold ?? 1.2 });
    const half = PixelDatatype.HALF_FLOAT;
    const bright = new PostProcessStage({ fragmentShader: BRIGHT_FS, textureScale: 0.25, pixelDatatype: half, uniforms: { u_threshold: () => st.threshold } });
    const blur = (src: string, x: number, scale: number) => new PostProcessStage({ fragmentShader: BLUR_FS, textureScale: scale, pixelDatatype: half, uniforms: { u_src: src, u_dir: new Cartesian2(x, 1 - x) } });
    const nearH = blur(bright.name, 1, 0.25);
    const nearV = blur(nearH.name, 0, 0.25);
    const wideH = blur(nearV.name, 1, 0.125);
    const wideV = blur(wideH.name, 0, 0.125);
    const finish = new PostProcessStage({ fragmentShader: FINISH_FS, uniforms: { u_bloomNear: nearV.name, u_bloomWide: wideV.name, u_exposure: () => st.exposure, u_bloom: () => st.bloom } });
    this.stage = new PostProcessStageComposite({ stages: [bright, nearH, nearV, wideH, wideV, finish], inputPreviousStageTexture: false });
    viewer.scene.postProcessStages.add(this.stage);
  }
}
