/**
 * Close-range ground detail on top of aerial photos, in Cesium's own ground shader.
 *
 * An aerial photo (30–50 cm pixels) is a smear from a glider on the ground or low over a
 * field. As flight sims do, the brightness of photo textures of grass and soil (Poly Haven,
 * CC0, the same ones the synthesized-detail layer uses) is multiplied onto the photo near the
 * camera: each divided by its own mean, so it adds grain and clumps but keeps the photo's
 * colour. Which texture is chosen per pixel from the photo's hue (green → grass, yellow → dry
 * grass, brown → soil; grey roads and roofs, water and deep shadow are left alone). Three
 * scales: true scale under the wheels (to 80 m), ×4 clumps and patches (to 400 m), ×16 field
 * mottling (to 1.5 km). Nothing to download per tile, no workers: six texture reads per
 * ground pixel. Measured at the Ghimbav ground start: the near ground's contrast goes from
 * 15.8 to 25.7 (pixel std) at the same mean brightness (74 → 71).
 *
 * How it plugs in: a globe `Material` brings the uniforms and the GLSL function (it is
 * compiled into the ground shader, before GlobeFS), and one line patched into GlobeFS calls
 * it with the photo colour (a Material on its own can only be alpha-blended over the ground,
 * not multiplied, and cannot see the photo). Both use Cesium internals; if a Cesium update
 * changes them, the patch is not applied and the ground is drawn as before.
 *
 * Texture coordinates are anchored to the ground, in metres east/north: the camera's
 * position is integrated frame by frame in its local east/north frame and kept modulo
 * PERIOD (a common multiple of every texture repeat, so the wrap is invisible); each pixel
 * adds its offset from the camera in that frame. 32-bit floats stay exact enough that way.
 */
import * as Cesium from "cesium";
import { Cartesian3, Material, type Viewer } from "cesium";

/** Texture repeats [m]: 2.4 and 3.2, ×4 and ×16 of those; 768 is a common multiple of all. */
const PERIOD = 768;
const MARKER = "czm_material material = czm_getMaterial(materialInput);";

// Must not contain the words "slope" or "normalEC", not even in a comment: Cesium then
// applies the material only on terrain with vertex normals (Globe.js), and ours has none.
/**
 * The grain itself, shared with Google's 3D tiles (google3d.ts): wfFactor(c, w, d) is the
 * brightness factor for photo colour c (display values) at ground position w [m east/north,
 * modulo PERIOD] and distance d [m] from the camera. Uniforms: wfTex, wfFine, wfMid, wfMacro,
 * wfStrength, wfGain.
 */
export const DETAIL_GLSL = /* glsl */ `
// One texture holds the brightness of four ground photos: grass (red), dry grass (green),
// soil (blue), gravel/concrete (alpha: grey ground, roads, yards, the photo's roofs and cars). Each channel divided by its mean (the smallest mip), contrast × gain: these
// tileable photos are nearly uniform once mipmapped (15% spread at full size, 5% at 64 px,
// 2.5% at 16 px), so the coarser layers need their contrast restored.
vec4 wfRatio(vec2 w, float s1, float s2, float gain) {
  vec4 mean = textureLod(wfTex, vec2(0.5), 12.0) + 1e-3;
  vec4 a = texture(wfTex, w / s1);
  vec4 b = texture(wfTex, w.yx / s2 + vec2(0.37, 0.71));
  // Narrow range: brightening a saturated green much past 1.25 turns it neon.
  return clamp(1.0 + (0.5 * (a + b) / mean - 1.0) * gain, 0.7, 1.25);
}
float wfFactor(vec3 c, vec2 w, float d) {
  float macroF = 1.0 - smoothstep(wfMacro.x, wfMacro.y, d);
  if (macroF <= 0.0) return 1.0;
  float fineF = 1.0 - smoothstep(wfFine.x, wfFine.y, d);
  float midF = 1.0 - smoothstep(wfMid.x, wfMid.y, d);
  vec3 hsb = czm_RGBToHSB(c);
  float h = hsb.x * 360.0;
  float coloured = smoothstep(0.06, 0.16, hsb.y);
  float lit = smoothstep(0.06, 0.16, hsb.z);
  vec4 wt = vec4(
    vec3(smoothstep(58.0, 72.0, h) * (1.0 - smoothstep(165.0, 185.0, h)),   // grass
         smoothstep(36.0, 46.0, h) * (1.0 - smoothstep(58.0, 72.0, h)),     // dry grass
         h < 180.0 ? 1.0 - smoothstep(36.0, 46.0, h) : smoothstep(330.0, 345.0, h)) * coloured, // soil
    (1.0 - coloured) * smoothstep(0.12, 0.25, hsb.z)) * lit;             // grey: gravel/concrete
  float wsum = wt.x + wt.y + wt.z + wt.w;
  vec4 wn = wt / max(wsum, 1e-3);
  float fine = dot(wfRatio(w, 2.4, 3.2, wfGain.x), wn);
  float mid = dot(wfRatio(w, 9.6, 12.8, wfGain.y), wn);
  float coarse = dot(wfRatio(w, 38.4, 51.2, wfGain.z), wn);
  float k = min(1.0, wsum);
  return mix(1.0, fine, k * fineF * wfStrength.x)
       * mix(1.0, mid, k * midF * wfStrength.y)
       * mix(1.0, coarse, k * macroF * wfStrength.z);
}
`;

const SOURCE = /* glsl */ `${DETAIL_GLSL}
vec3 wfDetail(vec3 c, czm_materialInput mi, vec3 posMC) {
  vec3 rel = -mi.positionToEyeEC;
  float d = length(rel);
  // This pixel's offset from the camera in metres east/north (earth-centred frame, not the
  // terrain normal: that tilts per triangle and would leave seams on hillsides).
  vec3 relWC = transpose(czm_normal3D) * rel;
  vec3 up = normalize(posMC);
  vec3 east = normalize(vec3(-posMC.y, posMC.x, 0.0));
  vec3 north = cross(up, east);
  vec2 w = wfCam + vec2(dot(relWC, east), dot(relWC, north));
  return c * wfFactor(c, w, d);
}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  m.alpha = 0.0;
  return m;
}
`;

interface Internals {
  _surfaceShaderSet?: { baseFragmentShaderSource?: { sources: string[] } };
}
/** Brightness of these photos goes into the red, green, blue and alpha channels of one texture. */
const TEXTURES = ["leafy_grass.jpg", "grass_ground.jpg", "farm_soil.jpg", "gravel_road.jpg"] as const;
const TEX_SIZE = 1024;

/** Patch GlobeFS (once per rebuild of Cesium's ground shader source) to call wfDetail. */
function patch(globe: Internals): boolean {
  const src = globe._surfaceShaderSet?.baseFragmentShaderSource;
  if (!src) return false;
  let ok = false;
  src.sources = src.sources.map((s) => {
    if (s.includes("wfDetail(color.rgb")) return ((ok = true), s);
    if (!s.includes(MARKER)) return s;
    ok = true;
    return s.replace(MARKER, `${MARKER}\n    color.rgb = wfDetail(color.rgb, materialInput, v_positionMC);`);
  });
  return ok;
}

/** The grain's settings (the uniforms of DETAIL_GLSL besides wfTex and the camera). */
export function detailSettings(): { fine: [number, number]; mid: [number, number]; macro: [number, number]; strength: [number, number, number]; gain: [number, number, number] } {
  const o = {
    // Fade distances [m] (full until the first, gone by the second) of the three scales: true
    // scale (2.4 m repeats: the grain under the wheels), ×4 (clumps and patches), ×16 (field
    // mottling).
    fine: [15, 80] as [number, number],
    mid: [60, 400] as [number, number],
    macro: [300, 1500] as [number, number],
    // Strength of the fine, mid and coarse layers (chosen from full-resolution comparisons at
    // the Ghimbav ground start: stronger read as noisy camouflage with neon highlights).
    strength: [0.6, 0.35, 0.25] as [number, number, number],
    // Contrast gain of each layer (restores some of what mipmapping averages away).
    gain: [1, 2, 2.5] as [number, number, number],
  };
  // ?gd=fine,mid,coarse strengths[,fine,mid,coarse gains]: for tuning.
  const gd = new URLSearchParams(location.search).get("gd")?.split(",").map(Number);
  if (gd?.length && gd.every(Number.isFinite)) {
    o.strength = [gd[0] ?? 0, gd[1] ?? 0, gd[2] ?? 0];
    if (gd.length >= 6) o.gain = [gd[3]!, gd[4]!, gd[5]!];
  }
  return o;
}

/** The four photos' brightness packed into one RGBA texture's bytes (TEX_SIZE square). */
export async function detailTexturePixels(texBase: string): Promise<{ data: Uint8Array; size: number }> {
  const out = new ImageData(TEX_SIZE, TEX_SIZE);
  const cv = new OffscreenCanvas(TEX_SIZE, TEX_SIZE);
  const cx = cv.getContext("2d", { willReadFrequently: true })!;
  for (let ch = 0; ch < TEXTURES.length; ch++) {
    const r = await fetch(texBase + TEXTURES[ch]);
    const bmp = await createImageBitmap(await r.blob());
    cx.drawImage(bmp, 0, 0, TEX_SIZE, TEX_SIZE);
    const px = cx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data;
    for (let i = 0; i < px.length; i += 4) {
      out.data[i + ch] = Math.round(0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!);
    }
  }
  return { data: new Uint8Array(out.data.buffer), size: TEX_SIZE };
}

/**
 * Calls back before every frame with the camera's ground position [m east, north] modulo
 * PERIOD, integrated in its local east/north frame (DETAIL_GLSL's wfCam).
 */
export function followCameraOnGround(scene: Viewer["scene"], cb: (east: number, north: number) => void): void {
  const prev = new Cartesian3();
  let have = false;
  let ex = 0, ny = 0;
  const d = new Cartesian3(), up = new Cartesian3(), east = new Cartesian3(), north = new Cartesian3();
  scene.preRender.addEventListener(() => {
    const p = scene.camera.positionWC;
    if (have) {
      Cartesian3.subtract(p, prev, d);
      Cartesian3.normalize(p, up);
      Cartesian3.normalize(Cartesian3.fromElements(-p.y, p.x, 0, east), east);
      Cartesian3.cross(up, east, north);
      ex = (((ex + Cartesian3.dot(d, east)) % PERIOD) + PERIOD) % PERIOD;
      ny = (((ny + Cartesian3.dot(d, north)) % PERIOD) + PERIOD) % PERIOD;
      cb(ex, ny);
    }
    Cartesian3.clone(p, prev);
    have = true;
  });
}

export function addGroundDetail(viewer: Viewer, texBase: string): void {
  const scene = viewer.scene;
  const globe = scene.globe as unknown as Internals & Cesium.Globe;
  const st = detailSettings();
  const uniforms: Record<string, unknown> = {
    wfTex: Material.DefaultImageId,
    wfCam: { x: 0, y: 0 },
    wfFine: { x: st.fine[0], y: st.fine[1] },
    wfMid: { x: st.mid[0], y: st.mid[1] },
    wfMacro: { x: st.macro[0], y: st.macro[1] },
    wfStrength: { x: st.strength[0], y: st.strength[1], z: st.strength[2] },
    wfGain: { x: st.gain[0], y: st.gain[1], z: st.gain[2] },
  };
  const material = new Material({ fabric: { type: "WebFlightGroundDetail", uniforms, source: SOURCE }, translucent: false });
  globe.material = material;
  if (!patch(globe)) {
    console.warn("ground detail: Cesium's ground shader changed; detail off");
    globe.material = undefined;
    return;
  }
  // Cesium rebuilds the base source when the globe's setup changes: patch again before drawing.
  let last = globe._surfaceShaderSet?.baseFragmentShaderSource;
  scene.preRender.addEventListener(() => {
    const now = globe._surfaceShaderSet?.baseFragmentShaderSource;
    if (now !== last) {
      last = now;
      if (globe.material === material && !patch(globe)) globe.material = undefined;
    }
  });

  // One mipmapped, repeating, anisotropic texture (Material's own image loading has neither;
  // and one texture unit, not three: Cesium's ground shader already uses up to 16).
  const C = Cesium as unknown as Record<string, any>;
  const context = (scene as unknown as { context: unknown }).context;
  void (async () => {
    try {
      const { data } = await detailTexturePixels(texBase);
      const sampler = new C.Sampler({
        wrapS: C.TextureWrap.REPEAT,
        wrapT: C.TextureWrap.REPEAT,
        minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
        magnificationFilter: C.TextureMagnificationFilter.LINEAR,
        maximumAnisotropy: 8,
      });
      // Raw bytes, not an image: an image's alpha would be premultiplied into the other channels.
      const tex = new C.Texture({ context, width: TEX_SIZE, height: TEX_SIZE, source: { arrayBufferView: data }, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: C.PixelDatatype.UNSIGNED_BYTE, sampler, flipY: false });
      tex.generateMipmap(C.MipmapHint.NICEST);
      (material.uniforms as Record<string, unknown>).wfTex = tex;
    } catch (e) {
      console.warn("ground detail: textures not loaded", e);
    }
  })();

  followCameraOnGround(scene, (ex, ny) => {
    const cam = (material.uniforms as { wfCam: { x: number; y: number } }).wfCam;
    cam.x = ex;
    cam.y = ny;
  });
}
