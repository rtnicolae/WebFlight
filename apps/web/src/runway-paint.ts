/**
 * Runways painted onto Google's 3D tiles. Up close their photos turn a runway into a smear:
 * melted white blobs for the markings, a grass strip indistinguishable from the field round it.
 * Every runway near the camera is drawn again from data, in the tiles' own fragment shader
 * (google3d.ts), so it lies exactly on Google's ground (a vertical projection: no heights to
 * match, no extra geometry) and takes the same light, haze and cloud shadows as the ground
 * round it.
 *
 * Nothing is hand-placed per airport. What a runway is comes from the data the sim already
 * flies on: OurAirports (designators, width, surface material) and OpenStreetMap's runway
 * lines (position and direction, as resolveRunway picks them, so the painted runway is the
 * one the glider stands on). What is painted on it follows ICAO Annex 14 from its length and
 * width: threshold stripes, designation, centreline, aiming point, touchdown zone on long
 * runways, side stripes. Grass strips get mower lanes, lighter or darker with the view along
 * them.
 *
 * Paved runways keep a little of the photo's own tone (stains, patches, tyre marks), clamped
 * so its melted paint doesn't show through. That is a per-pixel display adjustment like the
 * colour grade, nothing read back or derived from Google's content.
 *
 * ?rwpaint=0 turns it off.
 */
import { Cartesian3, Cartographic, Ellipsoid, Matrix4, TextureMagnificationFilter, TextureMinificationFilter, TextureUniform, UniformType, type CustomShader, type Viewer } from "cesium";
import { airfieldsAround, resolveRunway, type Runway, type RunwayMaterial } from "@webflight/environment";
import { fetchRunwayLines } from "@webflight/scenery";

/** How many runways are painted at once (the nearest to the camera). */
const SLOTS = 4;
/** Runways are looked up this far round the camera, again after moving RELOAD_M. */
const RADIUS_M = 25_000;
const RELOAD_M = 8_000;
/** Painted out to this distance from the camera. */
const PAINT_M = 20_000;

const MATERIAL_CODE: Record<RunwayMaterial, number> = { asphalt: 1, concrete: 2, grass: 3, gravel: 4, dirt: 5, water: 0, other: 0 };
/** Glyphs in the atlas: digits, then L, C, R; 15 = none. */
const GLYPHS = "0123456789LCR";
const NONE = 15;

/** The uniforms google3d.ts declares on its CustomShader for the painting. */
export function runwayUniforms(): Record<string, { type: UniformType; value: unknown }> {
  const tex = (v: number) => new TextureUniform({ typedArray: new Uint8Array([v, v, v, 255]), width: 1, height: 1 });
  const u: Record<string, { type: UniformType; value: unknown }> = {
    u_rwOn: { type: UniformType.FLOAT, value: 0 },
    u_rwGlyphs: { type: UniformType.SAMPLER_2D, value: tex(0) },
    u_rwTex: { type: UniformType.SAMPLER_2D, value: tex(128) },
  };
  for (let i = 0; i < SLOTS; i++) u[`u_rw${i}`] = { type: UniformType.MAT4, value: new Matrix4() };
  return u;
}

/**
 * GLSL for google3d.ts: wfRunwayPaint(c, relW, level, painted) paints photo colour c (linear) at
 * relW (the fragment minus the camera, world axes [m]). Each u_rwN holds one runway, by column:
 * 0 = (centre − camera, half length), 1 = (unit vector along the `le` direction, half width),
 * 2 = (unit vector across it, to the right; material code), 3 = (le glyphs, he glyphs, 0, 0),
 * glyphs packed as first digit + 16 × second + 256 × letter.
 */
export const RUNWAY_GLSL = /* glsl */ `
// Box-filtered coverage of [-h, h] by a pixel [d - a, d + a]: thin paint fades with distance
// instead of shimmering.
float wfCov(float d, float h, float a) {
  a = max(a, 1e-3);
  return clamp((min(d + a, h) - max(d - a, -h)) / (2.0 * a), 0.0, 1.0);
}
// Stripes of half-width h centred every period; past a period per pixel, their average.
float wfStripes(float u, float h, float period, float a) {
  float d = abs(mod(u + 0.5 * period, period) - 0.5 * period);
  return mix(wfCov(d, h, a), 2.0 * h / period, smoothstep(0.25 * period, period, a));
}
float wfRwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wfRwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wfRwHash(i), wfRwHash(i + vec2(1.0, 0.0)), f.x), mix(wfRwHash(i + vec2(0.0, 1.0)), wfRwHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// One character of a designation: uv in its box (0..1, up = away from the threshold).
float wfRwGlyph(vec2 uv, float g, vec2 gx, vec2 gy, float soft) {
  if (g > 12.5 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  float v = textureGrad(u_rwGlyphs, vec2((g + uv.x) / 16.0, 1.0 - uv.y), gx, gy).r;
  return smoothstep(0.5 - soft, 0.5 + soft, v);
}
// Paint on a paved runway at p (x across, to the right of the le direction; y along from the
// centre) [m], after ICAO Annex 14. a: half a pixel's footprint; dpx, dpy: p's screen derivatives.
float wfRwMarks(vec2 p, vec2 a, float hl, float hw, float gLe, float gHe, vec2 dpx, vec2 dpy) {
  float ax = abs(p.x);
  float s = hl - abs(p.y);           // from the nearer threshold, inwards
  float xs = p.y < 0.0 ? p.x : -p.x; // to the right, looking inwards from it
  float g = p.y < 0.0 ? gLe : gHe;
  float L = 2.0 * hl, W = 2.0 * hw;
  // Side stripes, the whole length.
  float ew = W >= 29.0 ? 0.9 : 0.45;
  float m = wfCov(ax - (hw - 0.5 * ew - 0.2), 0.5 * ew, a.x);
  // Threshold: stripes 30 m long from 6 m in, out to 3 m from the edges, 4 to 16 by width.
  float k = W >= 59.0 ? 8.0 : W >= 44.0 ? 6.0 : W >= 29.0 ? 4.0 : W >= 22.0 ? 3.0 : 2.0;
  float sw = max(hw - 3.0, 1.0) / (2.0 * k);
  m = max(m, wfCov(s - 21.0, 15.0, a.y) * wfStripes(ax - 1.5 * sw, 0.5 * sw, 2.0 * sw, a.x) * step(ax, sw * (2.0 * k + 0.25)));
  // Designation 12 m past them: two digits 9 m tall (6 m on narrow runways), a letter
  // (L, C, R) between them and the threshold.
  float f = W < 23.0 ? 0.67 : 1.0;
  float ch = 9.0 * f, cw = 3.0 * f, gap = 1.5 * f;
  float g0 = mod(g, 16.0), g1 = mod(floor(g / 16.0), 16.0), g2 = floor(g / 256.0);
  float s0 = 48.0;
  float sd = g2 < 12.5 ? s0 + ch + 3.0 * f : s0;
  vec2 gx = vec2(dpx.x / (16.0 * cw), dpx.y / ch), gy = vec2(dpy.x / (16.0 * cw), dpy.y / ch);
  float soft = clamp(2.0 * max(a.x, a.y) / cw, 0.06, 0.5);
  m = max(m, wfRwGlyph(vec2((xs + cw + 0.5 * gap) / cw, (s - sd) / ch), g0, gx, gy, soft));
  m = max(m, wfRwGlyph(vec2((xs - 0.5 * gap) / cw, (s - sd) / ch), g1, gx, gy, soft));
  m = max(m, wfRwGlyph(vec2((xs + 0.5 * cw) / cw, (s - s0) / ch), g2, gx, gy, soft));
  // Centreline: 30 m dashes, 20 m gaps, from 12 m past the designations.
  float cl = W >= 44.0 ? 0.9 : 0.45;
  m = max(m, wfCov(p.x, 0.5 * cl, a.x) * wfStripes(p.y, 15.0, 50.0, a.y) * step(sd + ch + 12.0, s));
  if (L >= 800.0) {
    // Aiming point.
    float a0 = L < 1200.0 ? 250.0 : L < 2400.0 ? 300.0 : 400.0;
    float al = L < 1200.0 ? 30.0 : L < 2400.0 ? 45.0 : 60.0;
    float aw = L < 1200.0 ? 4.0 : L < 2400.0 ? 6.0 : 10.0;
    float ag = min(L < 1200.0 ? 4.5 : 9.0, 0.3 * hw);
    m = max(m, wfCov(s - a0 - 0.5 * al, 0.5 * al, a.y) * wfCov(ax - ag - 0.5 * aw, 0.5 * aw, a.x));
    // Touchdown zone on long, wide runways (the ones with instrument approaches): pairs every
    // 150 m of 3, 3, 2, 2, 1, 1 stripes (22.5 × 1.8 m, 1.5 m apart), none by the aiming point.
    if (L >= 1800.0 && W >= 29.0) {
      float pairs = L >= 2400.0 ? 6.0 : 4.0;
      for (int i = 0; i < 6; i++) {
        float fi = float(i);
        if (fi >= pairs) break;
        float t0 = 150.0 * (fi + 1.0);
        if (t0 + 22.5 > a0 - 50.0 && t0 < a0 + al + 50.0) continue;
        float n = i < 2 ? 3.0 : i < 4 ? 2.0 : 1.0;
        float u = ax - ag;
        m = max(m, wfCov(s - t0 - 11.25, 11.25, a.y) * wfStripes(u - 0.9, 0.9, 3.3, a.x) * step(0.0, u) * step(u, n * 3.3 - 1.0));
      }
    }
  }
  return m;
}
vec3 wfRunwayPaint(vec3 c, vec3 relW, float level, out float painted) {
  painted = 0.0;
  if (u_rwOn < 0.5) return c;
  vec3 rx = dFdx(relW), ry = dFdy(relW);
  float dist = length(relW);
  vec3 view = relW / max(dist, 1e-3);
  for (int i = 0; i < 4; i++) {
    mat4 r = i == 0 ? u_rw0 : i == 1 ? u_rw1 : i == 2 ? u_rw2 : u_rw3;
    float hl = r[0].w, hw = r[1].w, mat = r[2].w;
    if (mat < 0.5) continue;
    vec3 q = relW - r[0].xyz;
    vec2 p = vec2(dot(q, r[2].xyz), dot(q, r[1].xyz));
    vec2 dpx = vec2(dot(rx, r[2].xyz), dot(rx, r[1].xyz)), dpy = vec2(dot(ry, r[2].xyz), dot(ry, r[1].xyz));
    vec2 a = 0.5 * (abs(dpx) + abs(dpy));
    if (abs(p.x) > hw + 6.0 + a.x || abs(p.y) > hl + 6.0 + a.y) continue;
    if (mat < 2.5) {
      // Asphalt or concrete (linear albedo; display ~0.36 and ~0.68).
      vec3 base = mat > 1.5 ? vec3(0.42, 0.41, 0.38) : vec3(0.105, 0.105, 0.11);
      // A little of the photo's tone (patches, repairs), not its melted paint or smeared tyre marks.
      vec3 Y = vec3(0.2126, 0.7152, 0.0722);
      float lp = dot(c, Y), lb = dot(base, Y);
      base *= mix(1.0, clamp(lp / lb, 0.85, 1.06), 0.5);
      base *= mix(vec3(1.0), clamp(c / max(lp, 1e-4), vec3(0.9), vec3(1.1)), 0.5);
      // Close up, the grain of an asphalt photo (CC0), two scales; the photo's tone farther out.
      float mean = textureLod(u_rwTex, vec2(0.5), 12.0).r + 1e-3;
      float t1 = textureGrad(u_rwTex, p / 3.7, dpx / 3.7, dpy / 3.7).r;
      float t2 = textureGrad(u_rwTex, p.yx / 13.0 + 0.31, dpx.yx / 13.0, dpy.yx / 13.0).r;
      float det = clamp(1.0 + (0.5 * (t1 + t2) / mean - 1.0) * (mat > 1.5 ? 1.0 : 1.6), 0.6, 1.4);
      base *= mix(det, 1.0, smoothstep(80.0, 300.0, dist));
      // Concrete: slab joints every 5 m.
      if (mat > 1.5) base *= 1.0 - 0.45 * max(wfStripes(p.x, 0.015, 5.0, a.x), wfStripes(p.y, 0.015, 5.0, a.y));
      // Rubber where wheels touch down, along the main-gear tracks.
      float L = 2.0 * hl, s = hl - abs(p.y);
      float tz = smoothstep(0.05 * L, 0.1 * L, s) * (1.0 - smoothstep(0.22 * L, 0.38 * L, s));
      float n = 0.7 * wfRwNoise(vec2(p.x * 1.7, p.y * 0.035)) + 0.3 * wfRwNoise(vec2(p.x * 6.0, p.y * 0.12));
      float rubber = tz * (1.0 - smoothstep(2.5, 7.5, abs(p.x))) * smoothstep(0.35, 0.8, n);
      base *= 1.0 - rubber * (mat > 1.5 ? 0.38 : 0.28);
      float m = wfRwMarks(p, a, hl, hw, r[3].x, r[3].y, dpx, dpy) * (0.86 + 0.14 * wfRwNoise(p * 1.3));
      vec3 col = mix(base, vec3(0.7, 0.7, 0.68) * (1.0 - 0.55 * rubber), m);
      // Not scaled by how level the surface looks: that estimate fails along the photo mesh's
      // triangle edges, which then showed as light seams across the runway.
      float inside = wfCov(p.x, hw, a.x) * wfCov(p.y, hl, a.y);
      painted = max(painted, inside);
      // Just outside the edges, where the photo's own (offset, melted) edge line and runway
      // lie: nothing brighter than the shoulders' asphalt.
      float verge = wfCov(abs(p.x) - hw - 3.0, 3.0, a.x) * wfCov(p.y, hl, a.y);
      c *= mix(1.0, min(1.0, 0.16 / max(lp, 1e-4)), verge);
      c = mix(c, col, inside);
    } else {
      // Grass (or gravel, dirt): soft edges; mower lanes 4 m wide, alternate ones cut the other
      // way, so lighter seen along the cut and darker against it, gone when seen from the side.
      float inside = wfCov(p.x, hw, max(a.x, 2.0)) * wfCov(p.y, hl, max(a.y, 4.0));
      // Mown short: lighter and a touch yellower than the field round it.
      vec3 mown = mat < 3.5 ? c * vec3(1.16, 1.2, 1.02) : mix(c, vec3(0.2, 0.16, 0.11), 0.3);
      if (mat < 3.5) {
        float lane = clamp(3.0 * sin(3.14159265 * p.x / 4.0), -1.0, 1.0) * (1.0 - smoothstep(1.5, 4.0, a.x));
        vec3 hv = view - dot(view, cross(r[2].xyz, r[1].xyz)) * cross(r[2].xyz, r[1].xyz);
        mown *= 1.0 + 0.16 * lane * dot(normalize(hv + 1e-6), r[1].xyz);
      }
      c = mix(c, mown, inside);
    }
  }
  return c;
}
`;

/** The designation's glyphs as one number (see RUNWAY_GLSL); "9" is painted as "09". */
export function packDesignator(id: string): number {
  const m = /^(\d{1,2})([LCR]?)/i.exec(id.trim());
  if (!m) return NONE + 16 * NONE + 256 * NONE;
  const d = m[1]!.padStart(2, "0");
  const letter = m[2] ? GLYPHS.indexOf(m[2].toUpperCase()) : NONE;
  return Number(d[0]) + 16 * Number(d[1]) + 256 * letter;
}

/** White designation characters on black, 16 cells of 64 × 256 px (a 3 × 9 m box each). */
function glyphAtlas(): Uint8Array {
  const CW = 64, H = 256, W = CW * 16;
  const cv = new OffscreenCanvas(W, H);
  const cx = cv.getContext("2d", { willReadFrequently: true })!;
  cx.fillStyle = "#000";
  cx.fillRect(0, 0, W, H);
  cx.fillStyle = "#fff";
  cx.font = `700 200px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  cx.textAlign = "center";
  cx.textBaseline = "alphabetic";
  const zero = cx.measureText("0");
  const ascent = zero.actualBoundingBoxAscent, capH = ascent + Math.max(0, zero.actualBoundingBoxDescent);
  const zw = zero.actualBoundingBoxLeft + zero.actualBoundingBoxRight;
  // Tall and narrow like runway numbers: the cap height fills the box, "0" its width; a "1"
  // stays a bar.
  const sy = (H * 0.9) / capH, sx = (CW * 0.82) / zw;
  for (let i = 0; i < GLYPHS.length; i++) {
    cx.save();
    cx.translate(CW * i + CW / 2, H * 0.05 + ascent * sy);
    cx.scale(sx, sy);
    cx.fillText(GLYPHS[i]!, 0, 0);
    // Bolder: runway numerals have heavy strokes.
    cx.strokeStyle = "#fff";
    cx.lineWidth = 9;
    cx.lineJoin = "round";
    cx.strokeText(GLYPHS[i]!, 0, 0);
    cx.restore();
  }
  return new Uint8Array(cx.getImageData(0, 0, W, H).data.buffer);
}

/** Textures set once per shader (it outlives flights). */
const textured = new WeakSet<CustomShader>();

export interface Painted {
  name: string;
  material: RunwayMaterial;
  source: Runway["source"];
  centre: Cartesian3;
  along: Cartesian3;
  across: Cartesian3;
  halfL: number;
  halfW: number;
  code: number;
  gLe: number;
  gHe: number;
}

export class RunwayPaint {
  private runways: Painted[] = [];
  private loadedAt: Cartographic | undefined;
  private loading = false;
  private closed = false;
  private readonly mats = Array.from({ length: SLOTS }, () => new Matrix4());
  private readonly removeListener: () => void;
  private readonly order: { r: Painted; d: number }[] = [];
  private readonly packed = new Array<number>(16).fill(0);
  /** Off: Google's runways as they are (for comparisons). */
  show = true;

  constructor(
    private readonly viewer: Viewer,
    private readonly shader: CustomShader,
    private readonly osmUrl: string | undefined,
    texBase: string | undefined,
  ) {
    if (!textured.has(shader)) {
      textured.add(shader);
      shader.setUniform("u_rwGlyphs", new TextureUniform({ typedArray: glyphAtlas(), width: 1024, height: 256, repeat: false, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8 }));
      if (texBase) shader.setUniform("u_rwTex", new TextureUniform({ url: `${texBase}aerial_asphalt_01.jpg`, repeat: true, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8 }));
    }
    this.removeListener = viewer.scene.preRender.addEventListener(() => this.update());
  }

  destroy(): void {
    this.closed = true;
    this.removeListener();
    this.shader.setUniform("u_rwOn", 0);
  }

  /** What is painted (for tests and tuning). */
  info(): { name: string; material: string; source: string; distM: number; lengthM: number; widthM: number }[] {
    const cam = this.viewer.camera.positionWC;
    return this.runways.map((r) => ({ name: r.name, material: r.material, source: r.source, distM: Math.round(Cartesian3.distance(cam, r.centre)), lengthM: Math.round(2 * r.halfL), widthM: Math.round(2 * r.halfW) }));
  }

  /** Every runway known round the camera (what is painted, and more), for the windsocks. */
  get all(): readonly Painted[] {
    return this.runways;
  }

  /** The grass runway nearest the camera within 1 km, for the 3D grass's mower lanes. */
  grassStrip(): { centre: Cartesian3; along: Cartesian3; halfL: number; halfW: number } | undefined {
    const cam = this.viewer.camera.positionWC;
    let best: Painted | undefined, bd = 1000;
    for (const r of this.runways) {
      if (r.material !== "grass") continue;
      const d = Math.max(0, Cartesian3.distance(cam, r.centre) - Math.hypot(r.halfL, r.halfW));
      if (d < bd) (best = r), (bd = d);
    }
    return best;
  }

  private async load(at: Cartographic): Promise<void> {
    this.loading = true;
    try {
      const lat = (at.latitude * 180) / Math.PI, lon = (at.longitude * 180) / Math.PI;
      const fields = await airfieldsAround(lat, lon, RADIUS_M);
      const out: Painted[] = [];
      for (const field of fields) {
        const rws = field.runways.filter((r) => MATERIAL_CODE[r.material] > 0);
        if (!rws.length) continue;
        // The same OSM lines the flight's runway is resolved from (world.ts), so the painted
        // runway is the one the glider stands on.
        const lines = this.osmUrl ? await fetchRunwayLines(this.osmUrl, field.latDeg, field.lonDeg).catch(() => []) : [];
        if (this.closed) return;
        for (const rd of rws) out.push(this.prepare(resolveRunway(field, rd, lines), rd.le, rd.he, field.elevM));
      }
      this.runways = out;
      this.loadedAt = at;
    } catch (e) {
      console.warn("runway paint: no airfield data", e);
      this.loadedAt = at;
    } finally {
      this.loading = false;
    }
  }

  private prepare(r: Runway, le: string, he: string, elevM: number): Painted {
    // At the field's elevation (only for choosing the nearest: the paint is a vertical
    // projection, the height drops out).
    const centre = Cartesian3.fromDegrees(r.lonDeg, r.latDeg, elevM);
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(centre, new Cartesian3());
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3());
    const north = Cartesian3.cross(up, east, new Cartesian3());
    const h = (r.headingDeg * Math.PI) / 180;
    const along = Cartesian3.add(Cartesian3.multiplyByScalar(east, Math.sin(h), new Cartesian3()), Cartesian3.multiplyByScalar(north, Math.cos(h), new Cartesian3()), new Cartesian3());
    const across = Cartesian3.subtract(Cartesian3.multiplyByScalar(east, Math.cos(h), new Cartesian3()), Cartesian3.multiplyByScalar(north, Math.sin(h), new Cartesian3()), new Cartesian3());
    return { name: r.name, material: r.material, source: r.source, centre, along, across, halfL: r.lengthM / 2, halfW: r.widthM / 2, code: MATERIAL_CODE[r.material], gLe: packDesignator(le), gHe: packDesignator(he) };
  }

  private update(): void {
    const cam = this.viewer.camera.positionWC;
    const here = Cartographic.fromCartesian(cam);
    if (!this.loading && (!this.loadedAt || Cartesian3.distance(Cartographic.toCartesian(this.loadedAt), Cartographic.toCartesian(here)) > RELOAD_M)) void this.load(here);
    // The nearest runways (to their outline, roughly).
    const o = this.order;
    o.length = 0;
    for (const r of this.runways) {
      const d = Math.max(0, Cartesian3.distance(cam, r.centre) - r.halfL);
      if (d < PAINT_M) o.push({ r, d });
    }
    o.sort((x, y) => x.d - y.d);
    const v = this.packed;
    for (let i = 0; i < SLOTS; i++) {
      const r = o[i]?.r;
      v.fill(0);
      if (r) {
        // Column-major, as the shader reads it (relative to the camera: exact in 32-bit floats).
        v[0] = r.centre.x - cam.x; v[1] = r.centre.y - cam.y; v[2] = r.centre.z - cam.z; v[3] = r.halfL;
        v[4] = r.along.x; v[5] = r.along.y; v[6] = r.along.z; v[7] = r.halfW;
        v[8] = r.across.x; v[9] = r.across.y; v[10] = r.across.z; v[11] = r.code;
        v[12] = r.gLe; v[13] = r.gHe;
      }
      this.shader.setUniform(`u_rw${i}`, Matrix4.unpack(v, 0, this.mats[i]!));
    }
    this.shader.setUniform("u_rwOn", o.length && this.show ? 1 : 0);
  }
}
