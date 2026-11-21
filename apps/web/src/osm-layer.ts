/**
 * OpenStreetMap buildings and forest trees around the aircraft, everywhere (outside
 * Switzerland, where swisstopo's surveyed 3D tiles are used instead). Meshes are built in
 * osm-worker.ts; each tile becomes one Primitive with per-vertex colours and a small
 * sun-lit shader, so a town is a handful of draw calls.
 *  - buildings: zoom-14 tiles (~1.7 km) within ±1 tile; beyond, out to ±`farRings` tiles
 *    (±3: ~5–7 km), the light version (buildingMesh's `far`, a simpler shader),
 *    so towns in the distance stand up from the plain instead of lying flat in the photo;
 *    built by a second worker so they never hold up the tiles round the glider. Beyond, to
 *    ±`skylineRings` (±6: ~10–11 km), the skyline: blocks of flats and large halls, the
 *    buildings that still show that far. Roofs take their colours from the aerial photo
 *    (osm-worker.ts);
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
import { HAZE_FS, HAZE_VS, LOOK, lookGlsl } from "./lighting.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import { photoTileUrl } from "./imagery.ts";
import { osmShift, osmShiftIfKnown } from "./photo-align.ts";
import { loadTreeAtlas, treeImpostors, type TreeAtlas } from "./tree-impostors.ts";

export interface OsmLayerOptions {
  buildings: boolean;
  trees: boolean;
  shadows: boolean;
  /** Tree spacing [m] and how many zoom-16 cells around the aircraft get trees. */
  treeSpacingM: number;
  treeRings: number;
  /** Zoom-14 tiles around the aircraft with distant buildings (0: none beyond ±1). */
  farRings: number;
  /** …and beyond those, out to this many, the skyline: blocks and large buildings only. */
  skylineRings: number;
  /** Where another source already provides buildings/trees (swisstopo; Google's 3D cities). */
  covered: (latDeg: number, lonDeg: number) => boolean;
  /** Drawn under Google's 3D tiles (osm-worker.ts UNDER): theirs hide ours where they have them. */
  underGoogle?: boolean;
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
${HAZE_VS}
void main() {
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  hazeVS(p.xyz + czm_viewerPositionWC, v_positionEC);
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
${HAZE_FS}

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
  // Beyond ~1.4 km (distant tiles, and the far parts of near ones) textures, facade detail and
  // windows have faded out: what the textures average to there (brick: its mean colour), and
  // the noise below is skipped.
#ifdef FAR
  const bool farFrag = true;
#else
  bool farFrag = d > 1400.0;
#endif
  czm_material tex;
  if (farFrag) {
    tex.diffuse = mat > 7.5 && mat < 9.5 ? vec3(0.342, 0.268, 0.242) : vec3(1.0);
    tex.shininess = 0.0;
  } else tex = czm_getMaterial(mi);
  vec3 base = v_color.rgb * tex.diffuse * (1.0 + clamp(tex.shininess, -0.35, 0.45));
#ifdef FAR
  const float detail = 0.0;
#else
  float detail = 1.0 - smoothstep(350.0, 1400.0, d); // facade detail fades with distance
#endif
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
    if (detail > 0.0) {
      float streak = vnoise(vec2(u * 0.9, v * 0.08 + seed * 31.0));
      base *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 2.5, v), detail);
      base *= 1.0 - (brick ? 0.05 : 0.10) * detail * smoothstep(0.55, 0.95, streak);
    }
    // Plinth: a stone/render base course.
#ifdef UNDER_GOOGLE
    // Below our ground: under Google's tiles, whose ground lies a metre or two below ours in
    // places (more so on their coarser distant tiles), the plinth carried down: a raised
    // foundation, not the dark band earth made there.
    if (v < 0.55) base = mix(base, vec3(0.42, 0.41, 0.39) * (farFrag ? 1.0 : 0.9 + 0.2 * vnoise(vec2(u * 3.0, v * 3.0))), v < -0.05 ? 1.0 : detail * 0.85);
#else
    // Below the ground (the walls go 10 m down for slopes): earth, if coarse terrain shows it.
    if (v < -0.05) base = vec3(0.22, 0.2, 0.16);
    else if (v < 0.55 && detail > 0.0) base = mix(base, vec3(0.42, 0.41, 0.39) * (0.9 + 0.2 * vnoise(vec2(u * 3.0, v * 3.0))), detail * 0.85);
#endif
    // Contact shadow at the foot, eave shadow under the roof (houses).
    base *= mix(1.0, 0.72 + 0.28 * smoothstep(0.0, 0.9, v), detail);
    // (Gable ends, above the walls, only along the eaves.)
    if (!block) base *= mix(1.0, 0.68 + 0.32 * smoothstep(0.0, 0.7, abs(wallH - v)), detail);
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
#ifdef FAR
      const float wd = 0.0;
#else
      float wd = 1.0 - smoothstep(160.0, 480.0, d);
#endif
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
  } else if (mat > 11.5) {
    // Lamp head: glows at night.
    base = v_color.rgb;
    emis = LOOK_NIGHT * vec3(1.0, 0.8, 0.5) * 1.3;
  } else if (mat > 10.5) {
    base = v_color.rgb; // steel pole
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
  // The colours above are display values (palettes, photo, textures); with HDR the scene is
  // linear light, and our own shaders must say so (hdr.ts): converted here (no-op in LDR).
  // Unconverted, the final gamma lifted them pale: terracotta (150, 86, 66) came out a washed
  // salmon (209, 163, 146) beside Google's roofs.
  base = czm_gammaCorrect(base);
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  // Sky light plus sun, scaled so a roof in full sun comes to ~1.1x its colour (it was ~1.4x:
  // mid-brown tiles rendered bright salmon, brighter and more saturated than the roofs in the
  // aerial photo beside them, so towns read as flat orange speckle). Walls keep their
  // sun-to-shade ratio; shade is a little deeper, which gives blocks their volume.
  // Walls also get light bounced off the sunlit ground (without it, shaded walls went dull grey).
  float sky = 0.42 + 0.16 * dot(n, up) + 0.11 * (1.0 - abs(dot(n, up)));
  vec3 c = base * (sky * LOOK_AMBIENT + 0.62 * sun * czm_lightColor) + spec * czm_lightColor + emis + glow;
  c = hazeFS(c, v_positionEC);
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

/**
 * far: a distant tile (≥ ~1.7 km): the same shader compiled without what has faded out by then
 * (facade detail, windows, textures), so it gives the same colours for a fraction of the work.
 */
function primitive(r: OsmResult, shadows: boolean, tex: Textures, far = false, mesh: Mesh | undefined = r.mesh, underGoogle = false): Primitive | undefined {
  const m = mesh;
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
    boundingSphere: BoundingSphere.fromVertices(pos as unknown as number[]), // reads it by index: no copy
  });
  const [lon, lat, h] = r.origin;
  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, h)) }),
    appearance: new MaterialAppearance({ material: material(tex), vertexShaderSource: lookGlsl(VS), fragmentShaderSource: lookGlsl(`${far ? "#define FAR\n" : ""}${underGoogle ? "#define UNDER_GOOGLE\n" : ""}${FS}`), translucent: false, closed: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } }),
    asynchronous: false,
    compressVertices: false,
    allowPicking: false,
    shadows: shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED,
  });
}

/** Small parts of near buildings (balconies…) are drawn within this distance [m] of the glider. */
const DETAIL_M = 1000;

/** Versions of a tile's buildings: detailed, distant, skyline. */
type Level = "b" | "f" | "s";
const LEVELS: Level[] = ["b", "f", "s"];

const newWorker = () => new Worker(new URL("./osm-worker.ts", import.meta.url), { type: "module" });

export class OsmLayer {
  private readonly worker = newWorker();
  /** Distant buildings: their own worker (and queue). */
  private farWorker: Worker | undefined;
  /** key → primitive (null while building or empty). Keys: b/x/y buildings, f/x/y distant buildings, s/x/y skyline, t/x/y trees. */
  private readonly tiles = new Map<string, Primitive | null>();
  /** Keys whose result has come (the primitive may still be null: nothing there). */
  private readonly ready = new Set<string>();
  private readonly pending = new Map<number, string>();
  /** Finished tiles waiting to be turned into primitives (a few per frame: drain). */
  private readonly arrived: OsmResult[] = [];
  private nextId = 1;
  private url: string | undefined;
  private atlas: TreeAtlas | undefined;
  private textures: Textures | undefined;
  private lastKey = "";
  /** The zoom-14 tile under the aircraft. */
  private at: [number, number] = [0, 0];
  private readonly lamps = new Map<string, PointPrimitiveCollection>();
  /** Small parts of near tiles by quarter, with the quarter's extent [deg], drawn only when close. */
  private readonly details = new Map<string, { p: Primitive; lon0: number; lon1: number; lat0: number; lat1: number }[]>();
  /** Where the details were last shown for (lat, lon [deg]). */
  private detailAt: [number, number] = [NaN, NaN];
  private here: [number, number] = [0, 0];

  private constructor(
    private readonly viewer: Viewer,
    private readonly o: OsmLayerOptions,
  ) {
    this.worker.onmessage = (e: MessageEvent<OsmResult>) => this.arrived.push(e.data);
  }

  private received(r: OsmResult): void {
    const key = this.pending.get(r.id);
    this.pending.delete(r.id);
    if (!key || !this.tiles.has(key)) return; // dropped meanwhile
    // One version of a tile's buildings at a time. The one wanted now replaces the others
    // when it comes; one no longer wanted only stands in until the wanted one is there.
    const [kind, xs, ys] = key.split("/") as [string, string, string];
    if (kind !== "t") {
      const want = this.wantedVersion(+xs, +ys);
      if (kind === want) for (const l of LEVELS) l !== kind && this.drop(`${l}/${xs}/${ys}`);
      else if (want && this.ready.has(`${want}/${xs}/${ys}`)) return this.drop(key);
    }
    // The skyline lies beyond the shadows' reach (4 km at most, scene.ts): no shadows there.
    const near = kind === "b";
    const p = r.trees ? (this.atlas ? treeImpostors(this.atlas, r.origin, r.trees, this.o.shadows) : undefined) : this.textures ? primitive(r, this.o.shadows && kind !== "s", this.textures, !near, r.mesh, this.o.underGoogle) : undefined;
    if (p) this.viewer.scene.primitives.add(p);
    this.tiles.set(key, p ?? null);
    this.ready.add(key);
    // The small parts in quarters (see showDetails).
    if (r.mesh?.parts && this.textures) {
      const [lon0, lat1] = tileToLonLat(+xs, +ys, 14), [lon1, lat0] = tileToLonLat(+xs + 1, +ys + 1, 14);
      const lonM = (lon0 + lon1) / 2, latM = (lat0 + lat1) / 2;
      const quarters = r.mesh.parts.flatMap((part, i) => {
        const dp = primitive(r, this.o.shadows, this.textures!, false, part, this.o.underGoogle);
        if (!dp) return [];
        this.viewer.scene.primitives.add(dp);
        const east = i & 1, south = i & 2;
        return [{ p: dp, lon0: east ? lonM : lon0, lon1: east ? lon1 : lonM, lat0: south ? lat0 : latM, lat1: south ? latM : lat1 }];
      });
      this.details.set(key, quarters);
      this.detailAt = [NaN, NaN];
      this.showDetails(...this.here);
    }
    // Street lamps at night: warm points, small in the distance.
    if (r.lamps?.length && LOOK.day < 0.6) {
      const pts = new PointPrimitiveCollection();
      const k = 1 - LOOK.day / 0.6, col = new Color(1, 0.78, 0.46, 0.95 * k);
      const size = new NearFarScalar(40, 1.6, 6000, 0.3);
      for (let i = 0; i < r.lamps.length; i += 3) pts.add({ position: Cartesian3.fromDegrees(r.lamps[i]!, r.lamps[i + 1]!, r.lamps[i + 2]!), pixelSize: 4, color: col, scaleByDistance: size });
      this.viewer.scene.primitives.add(pts);
      this.lamps.set(key, pts);
    }
  }

  /** Tiles still being built (for tests and screenshots). */
  get pendingCount(): number {
    return this.pending.size; // (queued arrivals are still pending)
  }

  /**
   * Turning a finished tile into a primitive runs on the main thread, in the next render
   * (Cesium's geometry pipeline and the upload), in proportion to its vertices: a town is
   * 10–40 ms. Several arriving together stalled a frame for 100–160 ms in flight; now each
   * frame adds tiles up to ~250k vertices (at least one).
   */
  private drain(): void {
    let budget = 250_000;
    while (this.arrived.length && budget > 0) {
      const r = this.arrived.shift()!;
      const m = r.mesh;
      budget -= m ? (m.positions.length + (m.parts ?? []).reduce((a, p) => a + p.positions.length, 0)) / 3 : (r.trees?.length ?? 0) / 5 * 8;
      this.received(r);
    }
  }

  /**
   * Balconies, rooftop units, parapets and lamp posts are most of a town's triangles, drawn
   * once for the view and again for each shadow cascade; beyond ~1 km they are a pixel or two.
   * Each quarter tile's are drawn while the glider is within DETAIL_M of it.
   */
  private showDetails(latDeg: number, lonDeg: number): void {
    const [la, lo] = this.detailAt;
    const kx = 111_320 * Math.cos((latDeg * Math.PI) / 180), ky = 111_132;
    if (Math.hypot((lonDeg - lo) * kx, (latDeg - la) * ky) < 25) return; // moved less than 25 m
    this.detailAt = [latDeg, lonDeg];
    for (const quarters of this.details.values())
      for (const q of quarters) {
        const dx = Math.max(q.lon0 - lonDeg, 0, lonDeg - q.lon1) * kx, dy = Math.max(q.lat0 - latDeg, 0, latDeg - q.lat1) * ky;
        q.p.show = Math.hypot(dx, dy) < DETAIL_M;
      }
  }

  private drop(k: string): void {
    for (const q of this.details.get(k) ?? []) this.viewer.scene.primitives.remove(q.p);
    this.details.delete(k);
    const p = this.tiles.get(k);
    if (p) this.viewer.scene.primitives.remove(p);
    this.tiles.delete(k);
    this.ready.delete(k);
    const l = this.lamps.get(k);
    if (l) this.viewer.scene.primitives.remove(l);
    this.lamps.delete(k);
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

  private request(key: string, req: Req, ring = 0): void {
    if (this.tiles.has(key)) return;
    this.tiles.set(key, null);
    const id = this.nextId++;
    this.pending.set(id, key);
    // Moved onto the aerial photo (photo-align.ts); trees by their zoom-14 tile's measurement.
    // Distant towns only by a measurement already made (a few metres don't show kilometres
    // away), except the next ring out, measured ahead so its buildings don't jump when the
    // detailed version replaces the distant one.
    const [x14, y14] = req.kind === "buildings" ? [req.x, req.y] : [req.x >> 2, req.y >> 2];
    const far = req.kind === "buildings" && !!req.far;
    const worker = far ? (this.farWorker ??= this.spawnFar()) : this.worker;
    const shift = far && ring > 2 ? Promise.resolve(osmShiftIfKnown(x14, y14)) : osmShift(x14, y14);
    void shift.then((shift) => {
      // Roofs coloured from the aerial photo, when the ground is Bing's.
      const photo = req.kind === "buildings" && photoTileUrl ? { photoUrl: photoTileUrl } : {};
      if (this.tiles.has(key)) worker.postMessage({ ...req, ...photo, id, url: this.url, shift } as OsmRequest);
      else this.pending.delete(id);
    });
  }

  private spawnFar(): Worker {
    const w = newWorker();
    w.onmessage = (e: MessageEvent<OsmResult>) => this.arrived.push(e.data);
    return w;
  }

  /** How many zoom-14 tiles out buildings reach. */
  private reach(): number {
    return Math.max(1, this.o.farRings, this.o.skylineRings);
  }

  /**
   * Which version of zoom-14 tile x, y should be drawn now: b detailed (±1), f distant (to
   * ±farRings), s skyline (to ±skylineRings), each kept a ring further once it is there, so
   * flying along a tile edge doesn't swap them back and forth.
   */
  private wantedVersion(x: number, y: number): Level | undefined {
    const ring = Math.max(Math.abs(x - this.at[0]), Math.abs(y - this.at[1]));
    const has = (l: Level) => this.tiles.has(`${l}/${x}/${y}`);
    const F = this.o.farRings, S = this.o.skylineRings;
    if (ring <= 1 || (ring === 2 && has("b"))) return "b";
    if (ring <= F || (ring === F + 1 && has("f"))) return "f";
    if (ring <= S || (ring === S + 1 && has("s"))) return "s";
    return undefined;
  }

  update(latDeg: number, lonDeg: number): void {
    if (!this.url) return;
    this.here = [latDeg, lonDeg];
    this.drain();
    this.showDetails(latDeg, lonDeg);
    const [bx, by] = lonLatToTile(lonDeg, latDeg, 14).map(Math.floor) as [number, number];
    const [tx, ty] = lonLatToTile(lonDeg, latDeg, 16).map(Math.floor) as [number, number];
    const key = `${tx}/${ty}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.at = [bx, by];
    const want = new Set<string>();
    const centre = (z: number, x: number, y: number) => {
      const [lon, lat] = tileToLonLat(x + 0.5, y + 0.5, z);
      return { lat, lon };
    };
    // Nearest first: the worker builds in request order.
    const jobs: [number, string, Req, number][] = [];
    const S = this.reach();
    if (this.o.buildings)
      for (let dy = -S; dy <= S; dy++)
        for (let dx = -S; dx <= S; dx++) {
          const x = bx + dx, y = by + dy, ring = Math.max(Math.abs(dx), Math.abs(dy));
          const c = centre(14, x, y);
          if (this.o.covered(c.lat, c.lon)) continue;
          const v = this.wantedVersion(x, y);
          if (!v) continue;
          const k = `${v}/${x}/${y}`, d2 = dx * dx + dy * dy;
          want.add(k);
          // Near tiles first, then distant ones, then the skyline (each worker in this order).
          jobs.push([v === "b" ? d2 * 16 : v === "f" ? d2 : 1000 + d2, k, { kind: "buildings", x, y, ...(v === "f" ? { far: true } : v === "s" ? { far: true, skyline: true } : {}), ...(this.o.underGoogle ? { under: true } : {}) }, ring]);
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
          jobs.push([dx * dx + dy * dy, k, { kind: "trees", x, y, spacingM: this.o.treeSpacingM * (1 + 0.6 * Math.max(0, ring - 1)) }, ring]);
        }
    }
    for (const [, k, req, ring] of jobs.sort((a, b) => a[0] - b[0])) this.request(k, req, ring);
    // Drop what is now out of range (a margin of one tile/cell avoids churn at the edges).
    for (const k of [...this.tiles.keys()]) {
      if (want.has(k)) continue;
      const [kind, xs, ys] = k.split("/") as [string, string, string];
      const ring = kind === "t" ? Math.max(Math.abs(+xs - tx), Math.abs(+ys - ty)) : Math.max(Math.abs(+xs - bx), Math.abs(+ys - by));
      // Kept past the loading range (flying back shows them at once), and buildings until the
      // version of the tile wanted now is there to replace them.
      const v = kind === "t" ? undefined : this.wantedVersion(+xs, +ys);
      const gone = kind === "t" ? ring > this.o.treeRings + 4 : v ? this.ready.has(`${v}/${xs}/${ys}`) : ring > S + 1;
      if (gone) this.drop(k);
    }
  }
}
