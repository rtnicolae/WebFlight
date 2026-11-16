/**
 * OpenStreetMap buildings and forest trees around the aircraft, everywhere (outside
 * Switzerland, where swisstopo's surveyed 3D tiles are used instead). Meshes are built in
 * osm-worker.ts; each tile becomes one Primitive with per-vertex colours and a small
 * sun-lit shader, so a town is a handful of draw calls.
 *  - buildings: zoom-14 tiles (~1.7 km) within ±1 tile
 *  - trees: zoom-16 cells (~430 m) within ±`treeRings` cells, nearest first
 */
import {
  Material,
  MaterialAppearance,
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  Primitive,
  Color,
  NearFarScalar,
  PointPrimitiveCollection,
  PrimitiveType,
  Resource,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  ShadowMode,
  Transforms,
  type Viewer,
} from "cesium";
import * as Cesium from "cesium";
import { lonLatToTile, tileToLonLat } from "@webflight/environment";
import type { Mesh } from "@webflight/scenery";
import type { OsmRequest, OsmResult } from "./osm-worker.ts";
import { LOOK, lookGlsl } from "./lighting.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import { loadTreeAtlas, treeImpostors, type TreeAtlas } from "./tree-impostors.ts";

export interface OsmLayerOptions {
  buildings: boolean;
  trees: boolean;
  shadows: boolean;
  /** Tree spacing [m] and how many zoom-16 cells around the aircraft get trees. */
  treeSpacingM: number;
  treeRings: number;
  /** Where another source already provides buildings/trees (swisstopo). */
  covered: (latDeg: number, lonDeg: number) => boolean;
}

/** A request without id/url (distributed over the union's members). */
type Req = OsmRequest extends infer R ? (R extends OsmRequest ? Omit<R, "id" | "url"> : never) : never;

const VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec4 color;
in vec4 uvm;
in float batchId;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
out vec4 v_uvm;
void main() {
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  v_uvm = uvm;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

/**
 * Buildings. Facades are generated from each wall's coordinates (u along the wall, v up from
 * the ground [m]), its building's wall height and a style seed (mesh materials: MAT in
 * @webflight/scenery):
 *  - houses (≤ 13 m): plinth, floor bands, windows with frames/sills/recess, shutters on some,
 *    doors on the ground floor, eave shadow under the roof;
 *  - blocks (> 13 m): precast panels (joints) or banded plaster, shop fronts on the ground
 *    floor; balconies are real boxes (open, or glazed in by their owners);
 *  - window pitch, size, frame colour per building; per window: roller shutters part way
 *    down, curtains, the sky reflected in the glass;
 *  - brick walls from a brick photo, with soldier-course lintels; glass curtain walls;
 *  - everywhere: contact shadow at the foot, grime under the sills, rain streaks.
 * Roofs: clay tiles, bitumen membrane or gravel, sampled twice at different rotations and
 * mixed by noise (no repeat), with large-scale stains; parapet copings; metal rooftop units.
 */
const FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
in vec4 v_uvm;

float hash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash1(i), hash1(i + vec2(1.0, 0.0)), f.x), mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Glass: dark interior, the sky reflected (brighter towards grazing angles), sun glint.
vec3 glassColour(vec3 n, vec3 up, float tint, out float spec) {
  vec3 view = normalize(v_positionEC);
  vec3 r = reflect(view, n);
  float sky = clamp(dot(r, up) * 1.4 + 0.25, 0.0, 1.0);
  float fres = pow(1.0 - abs(dot(view, n)), 3.0);
  vec3 refl = mix(vec3(0.30, 0.31, 0.30), vec3(0.62, 0.72, 0.84), sky);
  spec = pow(max(dot(r, czm_lightDirectionEC), 0.0), 80.0);
  return mix(vec3(0.10, 0.12, 0.15) + 0.06 * tint, refl, 0.22 + 0.5 * fres);
}

void main() {
  vec3 n = normalize(v_normalEC);
  if (!gl_FrontFacing) n = -n;
  vec3 up = normalize(czm_normal * vec3(0.0, 0.0, 1.0));
  float d = length(v_positionEC);
  float mat = floor(v_uvm.z + 0.001), seed = floor((v_uvm.z - mat) * 512.0 + 0.5) / 512.0;
  float u = v_uvm.x, v = v_uvm.y, wallH = v_uvm.w;
  czm_materialInput mi;
  mi.str = v_uvm.xyz;
  mi.positionToEyeEC = -v_positionEC;
  czm_material tex = czm_getMaterial(mi);
  vec3 base = v_color.rgb * tex.diffuse * (1.0 + clamp(tex.shininess, -0.35, 0.45));
  float detail = 1.0 - smoothstep(350.0, 1400.0, d); // facade detail fades with distance
  float spec = 0.0;
  vec3 emis = vec3(0.0), glow = vec3(0.0); // lit windows at night; their average far away
  bool brick = mat > 7.5 && mat < 9.5;
  float wm = brick ? mat - 8.0 : mat;

  if (wm < 1.5) {
    bool block = wallH > 13.0;
    // Per building: storey height, window pitch and size, frame colour.
    float floorH = block ? 2.8 : 2.65 + 0.35 * fract(seed * 3.0);
    float pitch = block ? 2.7 + 0.9 * fract(seed * 7.0) : 2.3 + 1.3 * fract(seed * 7.0);
    float fs = fract(seed * 13.0), ws = fract(seed * 29.0);
    float fl = floor(v / floorH), fy = fract(v / floorH);
    // Dirt and weathering: darker towards the foot, soft vertical rain streaks.
    float streak = vnoise(vec2(u * 0.9, v * 0.08 + seed * 31.0));
    base *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 2.5, v), detail);
    base *= 1.0 - (brick ? 0.05 : 0.10) * detail * smoothstep(0.55, 0.95, streak);
    // Plinth: a stone/render base course.
    if (v < 0.55) base = mix(base, vec3(0.42, 0.41, 0.39) * (0.9 + 0.2 * vnoise(vec2(u * 3.0, v * 3.0))), detail * 0.85);
    // Contact shadow at the foot, eave shadow under the roof (houses).
    base *= mix(1.0, 0.72 + 0.28 * smoothstep(0.0, 0.9, v), detail);
    if (!block) base *= mix(1.0, 0.68 + 0.32 * smoothstep(0.0, 0.7, wallH - v), detail);
    // Facade style by seed: houses get floor bands; blocks are panels (seed < 0.6) or banded.
    bool panels = block && !brick && seed < 0.6;
    if (panels) {
      vec2 pj = vec2(abs(fract(u / 3.6 + 0.5) - 0.5) * 3.6, abs(fract(v / 2.8 + 0.5) - 0.5) * 2.8);
      if (min(pj.x, pj.y) < 0.025 && v > 0.55) base *= mix(1.0, 0.72, detail);
    } else if (!brick && fl >= 1.0 && v < wallH - 0.3) {
      float band = fy * floorH;
      if (band < 0.12) base *= mix(1.0, 1.14, detail);            // cornice catching light
      else if (band < 0.26) base *= mix(1.0, 0.84, detail);       // its shadow
    }
    if (wm < 0.5 && v > 0.55 && v < wallH - 0.4) {
      float col = floor(u / pitch);
      vec2 w = vec2(fract(u / pitch), fy);
      vec2 sz = vec2(pitch, floorH);
      float cell = hash1(vec2(col, fl) + seed * 17.0);
      bool ground = fl < 0.5;
      // Window: 0.9–1.6 m (houses) or 1.2–2.0 m (blocks) wide, sill 0.85–0.95 m up.
      float halfW = min(block ? 0.6 + 0.4 * ws : 0.45 + 0.35 * ws, pitch * 0.5 - 0.35);
      float sill = block ? 0.85 : 0.95, wh = block ? 1.45 : 1.2 + 0.35 * fs;
      // Ground floor: doors on houses, shop fronts on blocks.
      bool door = ground && !block && cell < 0.22;
      bool shop = ground && block && seed > 0.35;
      vec2 lo = door ? vec2(0.5 - 0.5 / pitch, 0.0) : shop ? vec2(0.06, 0.12) : vec2(0.5 - halfW / pitch, sill / floorH);
      vec2 hi = door ? vec2(0.5 + 0.5 / pitch, 2.1 / floorH) : shop ? vec2(0.94, 0.86) : vec2(0.5 + halfW / pitch, min(0.92, (sill + wh) / floorH));
      // Shutters on some houses.
      bool shutters = !block && !ground && seed > 0.55 && !brick;
      float sw = 0.36 / pitch;
      if (shutters && w.y > lo.y && w.y < hi.y && ((w.x > lo.x - sw && w.x < lo.x) || (w.x > hi.x && w.x < hi.x + sw))) {
        vec3 sc = seed > 0.8 ? vec3(0.22, 0.32, 0.22) : seed > 0.68 ? vec3(0.36, 0.24, 0.16) : vec3(0.55, 0.55, 0.52);
        float louvre = 0.85 + 0.15 * step(0.5, fract(w.y * sz.y * 14.0));
        base = mix(base, sc * louvre, detail);
      }
      // Brick: a soldier-course lintel over each opening.
      if (brick && w.x > lo.x - 0.03 && w.x < hi.x + 0.03 && (w.y - hi.y) * sz.y > 0.0 && (w.y - hi.y) * sz.y < 0.2) base *= mix(1.0, 0.82, detail);
      vec3 frameCol = fs > 0.75 ? vec3(0.30, 0.22, 0.16) : fs > 0.6 ? vec3(0.24, 0.25, 0.26) : vec3(0.88, 0.88, 0.86);
      if (block && !brick) frameCol = fs > 0.5 ? vec3(0.62, 0.63, 0.64) : vec3(0.86, 0.86, 0.84);
      // Windows resolve to a few pixels from ~200 m: fade them into the facade's average
      // tone (glass darkens it by its share of the wall) instead of letting them speckle.
      float wd = 1.0 - smoothstep(160.0, 480.0, d);
      if (!door) base *= 1.0 - (1.0 - wd) * 0.55 * (hi.x - lo.x) * (hi.y - lo.y);
      // …and at night their average glow.
      if (!door) glow = (1.0 - wd) * LOOK_NIGHT * 0.4 * (hi.x - lo.x) * (hi.y - lo.y) * vec3(1.0, 0.74, 0.42);
      if (wd > 0.0 && all(greaterThan(w, lo)) && all(lessThan(w, hi))) {
        vec2 e = min(w - lo, hi - w) * sz;
        vec2 p = (w - lo) * sz, P = (hi - lo) * sz; // within the opening [m]
        float frame = door ? 0.05 : 0.06;
        vec3 fill;
        if (door) {
          fill = vec3(0.30, 0.20, 0.13) * (0.9 + 0.1 * step(0.5, fract(w.x * sz.x * 3.0)));
        } else {
          float gs;
          vec3 glass = glassColour(n, up, hash1(vec2(col, fl) + 3.1), gs);
          // Recessed: the lintel shades the top, the reveal one side.
          glass *= 0.6 + 0.4 * smoothstep(0.04, 0.25, P.y - p.y) * smoothstep(0.04, 0.14, p.x);
          // Curtains in some windows: a lighter, warm interior at the sides.
          float b = hash1(vec2(col * 1.7, fl) + seed * 5.3 + 7.7);
          if (!shop && b > 0.45 && b < 0.7 && (p.x < 0.25 * P.x || p.x > 0.75 * P.x)) glass = mix(glass, vec3(0.62, 0.58, 0.52), 0.55);
          fill = glass;
          spec = gs * detail;
          // At night some windows are lit (shop fronts mostly dark), warm, each a little different.
          float lit = step(shop ? 0.8 : 0.6, hash1(vec2(col * 3.1 + 0.7, fl * 1.7) + seed * 9.0));
          emis = LOOK_NIGHT * lit * vec3(1.0, 0.74, 0.42) * (0.55 + 0.45 * b) * (0.8 + 0.2 * smoothstep(0.0, 0.3, p.y));
          // Mullion (wider windows), transom on some houses.
          if (!shop && P.x > 1.0 && abs(p.x - 0.5 * P.x) < 0.035) { fill = frameCol; spec = 0.0; emis = vec3(0.0); }
          if (!shop && !block && fs > 0.5 && abs(p.y - 0.72 * P.y) < 0.03) { fill = frameCol; spec = 0.0; emis = vec3(0.0); }
          // Roller shutters part way (or all the way) down.
          float down = b < 0.38 ? (b < 0.1 ? 1.0 : 0.15 + 0.8 * fract(b * 9.0)) : 0.0;
          if (!shop && P.y - p.y < down * P.y) {
            fill = (block ? vec3(0.70, 0.70, 0.68) : vec3(0.62, 0.58, 0.52)) * (0.88 + 0.12 * step(0.35, fract(p.y * 18.0)));
            spec = 0.0;
            emis *= 0.12; // light leaking through the slats
          }
        }
        if (min(e.x, e.y) < frame) { fill = frameCol; spec = 0.0; emis = vec3(0.0); }
        base = mix(base, fill, wd);
        spec *= wd;
        emis *= wd;
      }
      // Sill below windows, and grime washing down from it.
      if (!ground && w.x > lo.x - 0.02 && w.x < hi.x + 0.02) {
        float below = (lo.y - w.y) * sz.y;
        if (below >= 0.0 && below < 0.06) base = mix(base, vec3(0.86, 0.85, 0.82), detail);
        else if (below >= 0.06 && below < 0.9) base *= mix(1.0, 0.9 + 0.1 * smoothstep(0.06, 0.9, below) + 0.05 * vnoise(vec2(u * 12.0, 0.0)), detail);
      }
    }
  } else if (mat > 4.5 && mat < 5.5) {
    base = v_color.rgb * (0.95 + 0.1 * vnoise(vec2(u * 2.0, v * 2.0)));
  } else if (mat > 5.5 && mat < 6.5) {
    // Rooftop units: ribbed metal sides, a darker base line.
    base = v_color.rgb * (abs(n.z) < 0.5 ? 0.9 + 0.1 * step(0.5, fract(u * 6.0)) : 1.0) * (abs(n.z) < 0.5 && v < 0.1 ? 0.7 : 1.0);
  } else if (mat > 6.5 && mat < 7.5) {
    // Balconies: slab edge, a solid front to 1.05 m, glazing above on enclosed ones.
    float hb = hash1(floor(v_color.rgb * 255.0 + 0.5).rg * 0.37); // per balcony (its colour; quantized: interpolation noise must not reach the hash)
    vec3 concrete = vec3(0.70, 0.69, 0.66) * (0.92 + 0.08 * vnoise(vec2(u, v) * 3.0));
    if (v < -1.5) base = concrete * 0.95;                 // top
    else if (v < -0.5) base = concrete * 0.55;            // underside, in its own shade
    else if (v < 0.2) base = concrete;                    // slab edge
    else if (v < 1.05) {
      base = v_color.rgb * (hb > 0.5 ? 0.94 + 0.06 * step(0.5, fract(u * 5.0)) : 1.0);
      base *= 0.9 + 0.1 * smoothstep(0.2, 0.5, v);         // drip stain at the foot
      if (wallH < 1.5 && v > 0.98) base = vec3(0.80, 0.80, 0.78); // handrail
    } else {
      float gs;
      vec3 g = glassColour(n, up, hb, gs);
      float pane = 0.7 + 0.5 * hb;
      vec2 q = vec2(fract(u / pane), v - 1.05);
      vec3 fc = hb > 0.7 ? vec3(0.42, 0.30, 0.20) : vec3(0.88, 0.88, 0.86);
      bool fr = min(q.x, 1.0 - q.x) * pane < 0.045 || q.y < 0.06 || wallH - v < 0.08;
      if (hash1(vec2(floor(u / pane), hb)) > 0.75) g = mix(g, vec3(0.66, 0.62, 0.55), 0.6); // curtain
      base = fr ? fc : g;
      spec = fr ? 0.0 : gs;
      if (!fr && hb > 0.55) emis = LOOK_NIGHT * vec3(1.0, 0.74, 0.42) * (0.3 + 0.5 * hb);
    }
  } else if (mat > 9.5) {
    // Glass curtain wall: mullions every 1.5 m, opaque spandrels at the floor slabs.
    float gs;
    vec3 g = glassColour(n, up, seed, gs) * mix(vec3(1.0), v_color.rgb * 1.6, 0.35);
    float fy = fract(v / 3.6) * 3.6;
    vec2 pm = vec2(abs(fract(u / 1.5 + 0.5) - 0.5) * 1.5, abs(fract(v / 3.6 + 0.5) - 0.5) * 3.6);
    base = g; spec = gs;
    if (fy < 0.9 && v > 1.0) { base = mix(g, v_color.rgb * 0.55, 0.7); spec *= 0.3; }
    if (min(pm.x, pm.y) < 0.05 * mix(1.0, 3.0, smoothstep(150.0, 600.0, d))) { base = vec3(0.55, 0.57, 0.6); spec = 0.0; }
  }
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  float sky = 0.56 + 0.14 * dot(n, up);
  vec3 c = base * (sky * LOOK_AMBIENT + 0.75 * sun * czm_lightColor) + spec * czm_lightColor + emis + glow;
  c = mix(c, vec3(0.70, 0.78, 0.86) * LOOK_AMBIENT, clamp((d - 1500.0) / 9000.0, 0.0, 0.45));
  out_FragColor = vec4(c, 1.0);
}`;

/** Cesium's renderer classes: exported at runtime, not in its public typings. */
interface Texture {
  generateMipmap(): void;
}
const { Sampler, Texture, TextureWrap } = Cesium as unknown as {
  Sampler: new (o: Record<string, unknown>) => unknown;
  Texture: new (o: { context: unknown; source: HTMLImageElement; sampler: unknown }) => Texture;
  TextureWrap: { REPEAT: number };
};

/** Building textures: mipmapped and repeating (without mipmaps, they glitter at a distance). */
const TEXTURES = ["wall", "tiles", "flat", "gravel", "brick"] as const;
type Textures = Record<(typeof TEXTURES)[number], Texture>;

async function loadTextures(viewer: Viewer): Promise<Textures> {
  const base = new URL(`${import.meta.env.BASE_URL}buildings/`, location.href).href;
  const context = (viewer.scene as unknown as { context: unknown }).context;
  const sampler = new Sampler({ wrapS: TextureWrap.REPEAT, wrapT: TextureWrap.REPEAT, minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8 });
  const out = {} as Textures;
  await Promise.all(
    TEXTURES.map(async (k) => {
      const img = await Resource.fetchImage({ url: `${base}${k}.jpg`, preferImageBitmap: false });
      if (!img) throw new Error(`texture ${k}`);
      const t = new Texture({ context, source: img as HTMLImageElement, sampler });
      t.generateMipmap();
      out[k] = t;
    }),
  );
  return out;
}

let buildingMaterial: Material | undefined;
function material(tex: Textures): Material {
  if (buildingMaterial) return buildingMaterial;
  const m = new Material({
    fabric: {
      type: "BuildingDetail",
      uniforms: Object.fromEntries(TEXTURES.map((k) => [k, Material.DefaultImageId])),
      // str = (u, v [m], material + seed). Detail = photo / mid-grey (brick: the photo's own
      // colour). Roofs: two rotated samples mixed by noise (no visible repeat) and large
      // stains; emboss in shininess.
      source: `
float bh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bh(i), bh(i + vec2(1.0, 0.0)), f.x), mix(bh(i + vec2(0.0, 1.0)), bh(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 roofTex(float k, vec2 p) {
  return k < 2.5 ? texture(tiles, p / 4.0).rgb : k < 3.5 ? texture(flat, p / 9.0).rgb : texture(gravel, p / 3.0).rgb;
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  float k = floor(mi.str.z + 0.001);
  vec2 p = mi.str.xy;
  float far = smoothstep(60.0, 260.0, length(mi.positionToEyeEC));
  if (k > 7.5 && k < 9.5) {
    // Brick: 1 m of photo; large-scale tone variation; at a distance its mean colour.
    vec3 t = texture(brick, p).rgb, t2 = texture(brick, p + vec2(0.0, 0.012)).rgb;
    float tone = 0.9 + 0.2 * bn(p / 6.0);
    m.diffuse = mix(t * tone, vec3(0.417, 0.327, 0.295), far * 0.7) * 0.82;
    m.shininess = dot(t - t2, vec3(0.333)) * 2.0 * (1.0 - far);
    return m;
  }
  if (k > 4.5) { m.diffuse = vec3(1.0); return m; }
  vec3 t, t2;
  if (k < 1.5) {
    t = texture(wall, p / 2.0).rgb;
    t2 = texture(wall, (p + vec2(0.0, 0.02)) / 2.0).rgb;
    t = mix(vec3(128.0 / 255.0), t, 0.6);
  } else if (k < 2.5) {
    t = roofTex(k, p);
    t2 = roofTex(k, p + vec2(0.0, 0.05));
  } else {
    // Flat roofs: no repeat (two rotated samples mixed by noise), membrane seams, stains.
    vec2 q = mat2(0.866, 0.5, -0.5, 0.866) * p + 7.3;
    float w = bn(p / 7.0);
    t = mix(roofTex(k, p), roofTex(k, q), w);
    t2 = mix(roofTex(k, p + vec2(0.0, 0.05)), roofTex(k, q + vec2(0.0, 0.05)), w);
    float stains = 0.82 + 0.3 * bn(p / 23.0) + 0.1 * bn(p / 5.0);
    // Membrane seams, only where a pixel resolves them (else they alias into moiré).
    if (k < 3.5) stains *= 1.0 - 0.07 * (1.0 - step(0.04, fract(p.x / 1.0))) * (1.0 - smoothstep(25.0, 70.0, length(mi.positionToEyeEC)));
    t *= stains;
    t2 *= stains;
  }
  vec3 dtl = t * (255.0 / 128.0);
  m.diffuse = k < 2.5 ? mix(dtl, vec3(1.0), far) : mix(dtl, vec3(1.0), far * 0.6);
  m.shininess = dot(t - t2, vec3(0.333)) * (k < 1.5 ? 1.5 : 1.8) * (1.0 - far);
  return m;
}`,
    },
    translucent: false,
  });
  for (const k of TEXTURES) m.uniforms[k] = tex[k];
  return (buildingMaterial = m);
}

function primitive(r: OsmResult, shadows: boolean, tex: Textures): Primitive | undefined {
  const m: Mesh | undefined = r.mesh;
  if (!m || !m.indices.length) return undefined;
  const pos = new Float64Array(m.positions);
  const geometry = new Geometry({
    attributes: Object.assign(new GeometryAttributes(), {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: m.normals }),
      color: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: m.colors }),
      uvm: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, values: m.uvm }),
    }),
    indices: m.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(pos)),
  });
  const [lon, lat, h] = r.origin;
  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, h)) }),
    appearance: new MaterialAppearance({ material: material(tex), vertexShaderSource: VS, fragmentShaderSource: lookGlsl(FS), translucent: false, closed: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } }),
    asynchronous: false,
    compressVertices: false,
    allowPicking: false,
    shadows: shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED,
  });
}

export class OsmLayer {
  private readonly worker = new Worker(new URL("./osm-worker.ts", import.meta.url), { type: "module" });
  /** key → primitive (null while building or empty). */
  private readonly tiles = new Map<string, Primitive | null>();
  private readonly pending = new Map<number, string>();
  private nextId = 1;
  private url: string | undefined;
  private atlas: TreeAtlas | undefined;
  private textures: Textures | undefined;
  private lastKey = "";
  private readonly lamps = new Map<string, PointPrimitiveCollection>();

  private constructor(
    private readonly viewer: Viewer,
    private readonly o: OsmLayerOptions,
  ) {
    this.worker.onmessage = (e: MessageEvent<OsmResult>) => {
      const key = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (!key || !this.tiles.has(key)) return; // dropped meanwhile
      const p = e.data.trees ? (this.atlas ? treeImpostors(this.atlas, e.data.origin, e.data.trees) : undefined) : this.textures ? primitive(e.data, this.o.shadows, this.textures) : undefined;
      if (p) this.viewer.scene.primitives.add(p);
      this.tiles.set(key, p ?? null);
      // Street lamps at night: warm points, small in the distance.
      if (e.data.lamps?.length && LOOK.day < 0.6) {
        const pts = new PointPrimitiveCollection();
        const k = 1 - LOOK.day / 0.6, col = new Color(1, 0.78, 0.46, 0.95 * k);
        const size = new NearFarScalar(40, 1.6, 6000, 0.3);
        for (let i = 0; i < e.data.lamps.length; i += 3)
          pts.add({ position: Cartesian3.fromDegrees(e.data.lamps[i]!, e.data.lamps[i + 1]!, e.data.lamps[i + 2]!), pixelSize: 4, color: col, scaleByDistance: size });
        this.viewer.scene.primitives.add(pts);
        this.lamps.set(key, pts);
      }
    };
  }

  static async create(viewer: Viewer, o: OsmLayerOptions): Promise<OsmLayer | undefined> {
    const url = await openFreeMapTiles();
    if (!url) return undefined;
    const l = new OsmLayer(viewer, o);
    l.url = url;
    // Photoreal tree impostors (CC0 models rendered offline); without them no trees are drawn.
    if (o.buildings) l.textures = await loadTextures(viewer).catch((e) => (console.warn("building textures", e), undefined));
    if (o.trees) l.atlas = await loadTreeAtlas(new URL(import.meta.env.BASE_URL, location.href).href).catch(() => undefined);
    return l;
  }

  private request(key: string, req: Req): void {
    if (this.tiles.has(key)) return;
    this.tiles.set(key, null);
    const id = this.nextId++;
    this.pending.set(id, key);
    this.worker.postMessage({ ...req, id, url: this.url } as OsmRequest);
  }

  update(latDeg: number, lonDeg: number): void {
    if (!this.url) return;
    const [bx, by] = lonLatToTile(lonDeg, latDeg, 14).map(Math.floor) as [number, number];
    const [tx, ty] = lonLatToTile(lonDeg, latDeg, 16).map(Math.floor) as [number, number];
    const key = `${tx}/${ty}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const want = new Set<string>();
    const centre = (z: number, x: number, y: number) => {
      const [lon, lat] = tileToLonLat(x + 0.5, y + 0.5, z);
      return { lat, lon };
    };
    // Nearest first: the worker builds in request order.
    const jobs: [number, string, Req][] = [];
    if (this.o.buildings)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx, y = by + dy, k = `b/${x}/${y}`;
          const c = centre(14, x, y);
          if (this.o.covered(c.lat, c.lon)) continue;
          want.add(k);
          jobs.push([(dx * dx + dy * dy) * 16, k, { kind: "buildings", x, y }]);
        }
    if (this.o.trees) {
      const r = this.o.treeRings;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = tx + dx, y = ty + dy, k = `t/${x}/${y}`;
          const c = centre(16, x, y);
          if (this.o.covered(c.lat, c.lon)) continue;
          want.add(k);
          // Sparser further out (far trees are small; the forest keeps its outline).
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          jobs.push([dx * dx + dy * dy, k, { kind: "trees", x, y, spacingM: this.o.treeSpacingM * (1 + 0.6 * Math.max(0, ring - 1)) }]);
        }
    }
    for (const [, k, req] of jobs.sort((a, b) => a[0] - b[0])) this.request(k, req);
    // Drop what is now out of range (a margin of one tile/cell avoids churn at the edges).
    for (const [k, p] of this.tiles) {
      if (want.has(k)) continue;
      const [kind, xs, ys] = k.split("/") as [string, string, string];
      const far = kind === "b" ? Math.max(Math.abs(+xs - bx), Math.abs(+ys - by)) > 2 : Math.max(Math.abs(+xs - tx), Math.abs(+ys - ty)) > this.o.treeRings + 1;
      if (!far) continue;
      if (p) this.viewer.scene.primitives.remove(p);
      this.tiles.delete(k);
      const l = this.lamps.get(k);
      if (l) this.viewer.scene.primitives.remove(l);
      this.lamps.delete(k);
    }
  }
}
