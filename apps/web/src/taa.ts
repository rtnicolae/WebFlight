/**
 * Temporal anti-aliasing. On a Retina screen we render a quarter of its pixels (dynres.ts:
 * 1.0–1.5× of the CSS size), and even mipmapped, a slanting view of Google's photos, grass
 * blades a pixel wide, cloud edges marched at half resolution and the water's reflections
 * shimmer and look sandy. 4× MSAA only smooths geometry edges, at 15–28% of the frame rate.
 *
 * As sims do (MSFS among them): each frame the projection is moved by a fraction of a pixel
 * (a Halton 2,3 sequence of 8), and the frame is blended with what came before (90% history).
 * A still view converges to 8 samples per pixel; a moving one keeps most of that.
 *
 * Where each pixel was last frame: from the depth, its point in the world, seen from where the
 * camera was then (the world stands still). Things that move with the camera (the glider in
 * the chase view, the cockpit) were at the same spot on screen instead; the history keeps
 * each pixel's distance, and whichever candidate is at the distance expected is taken
 * (neither: the history is dropped there, for disocclusions). What is taken is clamped to
 * the colours round the pixel now (variance clipping, in YCoCg), so nothing ghosts. History
 * is read with a Catmull-Rom filter (bilinear blurs a little more every frame).
 *
 * The last post-process stage (after HdrFinish: display values); Cesium's FXAA is off while
 * it runs. Its output is copied into our history texture after each frame. ?taa=0: off.
 */
import * as Cesium from "cesium";
import { Cartesian2, Cartesian3, Matrix3, Matrix4, PixelDatatype, PostProcessStage, type Viewer } from "cesium";
import { SCENE_DIST_GLSL } from "./atmosphere.ts";
import { SHARPEN_FS } from "./scene.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const C = Cesium as any;

function halton(i: number, b: number): number {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / b)) {
    f /= b;
    r += f * (i % b);
  }
  return r;
}
const JITTER = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5] as const);
/** Distances are kept in the history's alpha (half float), sky and beyond as this. */
const FAR = 60000;

const TAA_FS = /* glsl */ `${SCENE_DIST_GLSL}
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_history;
uniform mat3 u_prevRot;   // world to the previous frame's eye
uniform vec3 u_camDelta;  // camera now minus camera then [m, world axes]
uniform vec2 u_prevProj;  // the previous frame's 1 / tan(half field of view), x and y
uniform float u_valid;    // 0: no history (first frame, resize, a cut)
uniform float u_feedback; // share of the history
in vec2 v_textureCoordinates;

vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

// Catmull-Rom from 5 bilinear taps (the corners dropped).
vec3 historyAt(vec2 uv, vec2 size) {
  vec2 p = uv * size;
  vec2 tc = floor(p - 0.5) + 0.5;
  vec2 f = p - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (tc - 1.0) / size, t3 = (tc + 2.0) / size, t12 = (tc + w2 / w12) / size;
  vec3 r = texture(u_history, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture(u_history, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture(u_history, t12).rgb * (w12.x * w12.y)
         + texture(u_history, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(u_history, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  return r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
}

float nearestKept(vec2 uv, vec2 hs) {
  ivec2 c = ivec2(clamp(uv, 0.0, 0.9999) * hs), m = ivec2(hs) - 1;
  float d = texelFetch(u_history, c, 0).a;
  d = min(d, texelFetch(u_history, clamp(c + ivec2(1, 0), ivec2(0), m), 0).a);
  d = min(d, texelFetch(u_history, clamp(c - ivec2(1, 0), ivec2(0), m), 0).a);
  d = min(d, texelFetch(u_history, clamp(c + ivec2(0, 1), ivec2(0), m), 0).a);
  return min(d, texelFetch(u_history, clamp(c - ivec2(0, 1), ivec2(0), m), 0).a);
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec3 cur = texture(colorTexture, uv).rgb;
  vec2 px = 1.0 / vec2(textureSize(colorTexture, 0));
  vec2 hs = vec2(textureSize(u_history, 0));
  // The nearest surface round the pixel (itself and 4 neighbours) decides how it moved: at
  // an edge the jitter makes a pixel see one surface, then the other, and following each in
  // turn left the edge jagged; following the nearer one keeps it with the object in front
  // (as in most TAA: "closest-depth" motion).
  float dNow = 0.0, dNear = 1e30;
  vec2 uvNear = uv;
  for (int k = 0; k < 5; k++) {
    vec2 o = vec2(k == 1 ? -1.0 : k == 2 ? 1.0 : 0.0, k == 3 ? -1.0 : k == 4 ? 1.0 : 0.0) * px;
    float dn = wfSceneDist(depthTexture, uv + o);
    dn = dn > 1e8 ? ${FAR.toFixed(1)} : min(dn, ${FAR.toFixed(1)});
    if (k == 0) dNow = dn;
    if (dn < dNear) {
      dNear = dn;
      uvNear = uv + o;
    }
  }
  bool sky = dNear >= ${FAR.toFixed(1)};
  vec3 dirW = czm_inverseViewRotation * normalize(wfEyeRay(uvNear));
  // Where it was if it stands still in the world, and how far away then.
  vec3 relPrev = sky ? dirW * 1e7 : dirW * dNear + u_camDelta;
  vec3 e = u_prevRot * relPrev;
  vec2 motion = e.xy * u_prevProj / max(-e.z, 1e-4) * 0.5 + 0.5 - uvNear;
  float dW = sky ? ${FAR.toFixed(1)} : min(length(relPrev), ${FAR.toFixed(1)});
  vec2 uvW = uv + motion;
  bool inW = e.z < 0.0 && all(greaterThan(uvW, vec2(0.0))) && all(lessThan(uvW, vec2(1.0)));
  // Checked on that nearest surface: in the world (its distance as seen from where the
  // camera was) or moving with the camera (the glider, the cockpit: the same spot, the same
  // distance).
  // (The nearest distance kept round that spot: at an edge the pixel itself may have seen
  // the background behind it last frame.)
  float storedW = nearestKept(uvNear + motion, hs), storedS = nearestKept(uvNear, hs);
  float eW = inW ? abs(storedW - dW) / max(dW, 1.0) : 1e9, eS = abs(storedS - dNear) / max(dNear, 1.0);
  // The world's motion unless it clearly doesn't fit and the same spot fits far better: far
  // ground passes both tests (taking the same spot there by chance smeared the forest).
  bool useS = eS < 0.04 && eW > 0.005 && eS < 0.25 * eW;
  bool okW = eW < 0.06, okS = useS;
  vec2 huv = useS ? uv : uvW;
  // The neighbourhood now, to clamp the history to.
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec3 s = toYCoCg(texture(colorTexture, uv + vec2(float(i), float(j)) * px).rgb);
      m1 += s;
      m2 += s * s;
    }
  vec3 mu = m1 / 9.0, sig = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  vec3 h = clamp(toYCoCg(historyAt(huv, hs)), mu - sig, mu + sig);
  // Less history while things move fast across the screen (less smear).
  float moved = length((huv - uv) * hs);
  float k = u_feedback * mix(1.0, 0.75, clamp(moved / 24.0, 0.0, 1.0));
  if (u_valid < 0.5 || !(okW || okS)) k = 0.0;
  vec3 o = fromYCoCg(mix(toYCoCg(cur), h, k));
#ifdef TAA_DEBUG
  // Red: history from where the point was in the world; green: from the same spot; blue: valid.
  o = vec3(okW ? 1.0 : 0.0, okS ? 1.0 : 0.0, u_valid) * 0.6 + 0.4 * cur;
#endif
  out_FragColor = vec4(max(o, 0.0), dNow);
}
`;

export class TemporalAA {
  readonly stage: PostProcessStage;
  /** Contrast-adaptive sharpening after it (display only: the history is taken before it). */
  readonly sharpen: PostProcessStage;
  private history: any;
  private historyFb: any;
  private valid = false;
  private k = 0;
  private readonly prevRot = new Matrix3();
  private readonly prevCam = new Cartesian3();
  private readonly prevProj = new Cartesian2();
  private readonly camDelta = new Cartesian3();
  private havePrev = false;
  private readonly off: (() => void)[] = [];
  private on = true;

  constructor(
    private readonly viewer: Viewer,
    opts: { feedback?: number; sharpen?: number } = {},
  ) {
    const scene = viewer.scene;
    const feedback = opts.feedback ?? 0.9;
    this.stage = new PostProcessStage({
      fragmentShader: (new URLSearchParams(location.search).get("taadbg") === "1" ? "#define TAA_DEBUG\n" : "") + TAA_FS,
      pixelDatatype: PixelDatatype.HALF_FLOAT,
      uniforms: {
        u_history: () => this.history ?? (scene as any).context.defaultTexture,
        u_prevRot: () => this.prevRot,
        u_camDelta: () => Cartesian3.subtract(scene.camera.positionWC, this.prevCam, this.camDelta),
        u_prevProj: () => this.prevProj,
        // (A jump of the camera, e.g. a new view: no history.)
        u_valid: () => (this.valid && this.havePrev && Cartesian3.distance(scene.camera.positionWC, this.prevCam) < 500 ? 1 : 0),
        u_feedback: feedback,
      },
    });
    scene.postProcessStages.add(this.stage);
    // Blending frames softens fine detail a little, more in motion: sharpened back for display.
    this.sharpen = new PostProcessStage({ fragmentShader: SHARPEN_FS, uniforms: { sharpness: opts.sharpen ?? 0.35 } });
    this.sharpen.enabled = (opts.sharpen ?? 0.35) > 0;
    scene.postProcessStages.add(this.sharpen);
    scene.postProcessStages.fxaa.enabled = false;
    this.off.push(scene.preRender.addEventListener(() => this.jitter()));
    this.off.push(scene.postRender.addEventListener(() => this.keep()));
  }

  /** Off: no jitter, Cesium's FXAA instead (for comparisons). */
  get enabled(): boolean {
    return this.on;
  }
  set enabled(v: boolean) {
    this.on = v;
    this.stage.enabled = v;
    this.sharpen.enabled = v;
    this.viewer.scene.postProcessStages.fxaa.enabled = !v;
    this.valid = false;
    if (!v) this.setOffset(0, 0);
  }

  destroy(): void {
    for (const f of this.off) f();
    this.setOffset(0, 0);
    const pp = this.viewer.scene.postProcessStages;
    // (The flight's lifetime may already have taken the stage away: lifetime.ts.)
    try {
      if (pp.contains(this.stage)) pp.remove(this.stage);
      if (pp.contains(this.sharpen)) pp.remove(this.sharpen);
    } catch {
      /* already destroyed */
    }
    pp.fxaa.enabled = true;
    this.historyFb?.destroy();
    this.history?.destroy();
    this.historyFb = this.history = undefined;
  }

  /** This frame's offset of the projection, per metre of near distance (an angle). */
  private ax = 0;
  private ay = 0;

  private setOffset(x: number, y: number): void {
    this.ax = x;
    this.ay = y;
  }

  /**
   * A frustum's xOffset / yOffset are in units of its near plane, and Cesium renders with
   * clones of the camera's frustum whose near it moves per pass (to the nearest thing in
   * view: metres, not the camera's 0.1 m), so a fixed offset shrank to nothing. Here they are
   * read off our angle times each frustum's own near, on the camera's frustum and on every
   * clone made from it. Internal behaviour, so only when the frustum has these offsets.
   */
  private patch(f: any): void {
    if (!f || f.__wfTaa || f.xOffset === undefined) return;
    const self = this;
    const offsets = (o: any) => {
      Object.defineProperty(o, "xOffset", { get() { return self.ax * this.near; }, set() {}, configurable: true });
      Object.defineProperty(o, "yOffset", { get() { return self.ay * this.near; }, set() {}, configurable: true });
    };
    offsets(f);
    const clone = f.clone;
    f.clone = function (result?: any) {
      const r = clone.call(this, result);
      if (r && !r.__wfTaaOffsets) {
        offsets(r);
        r.__wfTaaOffsets = true;
      }
      return r;
    };
    f.__wfTaa = true;
  }

  /** Before each frame: this frame's sub-pixel offset of the projection. */
  private jitter(): void {
    if (!this.on) return;
    const scene = this.viewer.scene;
    const f = scene.camera.frustum as unknown as { fovy: number; aspectRatio: number };
    this.patch(f);
    const w = scene.drawingBufferWidth, h = scene.drawingBufferHeight;
    if (!w || !h || !f.fovy) return;
    const [jx, jy] = JITTER[this.k++ % JITTER.length]!;
    const ty = Math.tan(f.fovy / 2), tx = ty * f.aspectRatio;
    this.setOffset((jx * 2 * tx) / w, (jy * 2 * ty) / h);
  }

  /** After each frame: the result becomes the history; the camera as it was. */
  private keep(): void {
    if (!this.on) return;
    const scene = this.viewer.scene, cam = scene.camera;
    const ctx = (scene as any).context;
    const out = (this.stage as any).outputTexture;
    const src = (this.stage as any)._textureCache?.getFramebuffer?.((this.stage as any)._name);
    if (out && src && ctx) {
      const w = out.width, h = out.height;
      if (!this.history || this.history.width !== w || this.history.height !== h) {
        this.historyFb?.destroy();
        this.history?.destroy();
        this.history = new C.Texture({ context: ctx, width: w, height: h, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: PixelDatatype.HALF_FLOAT, sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR, wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE }) });
        this.historyFb = new C.Framebuffer({ context: ctx, colorTextures: [this.history], destroyAttachments: false });
        this.valid = false;
      } else this.valid = true;
      // Copy (blit) the stage's output into the history. Cesium caches its bound framebuffer
      // and scissor state: both restored or reset.
      const gl = ctx._gl as WebGL2RenderingContext;
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src._framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.historyFb._framebuffer);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      ctx._currentFramebuffer = undefined;
    }
    // The camera this frame, without the jitter, for the next frame's reprojection.
    Matrix4.getMatrix3(cam.viewMatrix, this.prevRot);
    Cartesian3.clone(cam.positionWC, this.prevCam);
    const f = cam.frustum as unknown as { fovy: number; aspectRatio: number };
    const ty = Math.tan(f.fovy / 2);
    Cartesian2.fromElements(1 / (ty * f.aspectRatio), 1 / ty, this.prevProj);
    this.havePrev = true;
  }
}
