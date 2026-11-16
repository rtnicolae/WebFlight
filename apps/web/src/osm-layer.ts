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
  PrimitiveType,
  ShadowMode,
  Transforms,
  type Viewer,
} from "cesium";
import { lonLatToTile, tileToLonLat } from "@webflight/environment";
import type { Mesh } from "@webflight/scenery";
import type { OsmRequest, OsmResult } from "./osm-worker.ts";
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
 * the ground [m]), its building's wall height and a style seed:
 *  - houses (≤ 13 m): plinth, floor bands, windows with frames/sills/recess, shutters on some,
 *    doors on the ground floor, eave shadow under the roof;
 *  - blocks (> 13 m): precast panels (joints every 3.6 m × 2.8 m) or banded plaster, ribbon of
 *    windows, shop fronts on the ground floor;
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

void main() {
  vec3 n = normalize(v_normalEC);
  if (!gl_FrontFacing) n = -n;
  float d = length(v_positionEC);
  float mat = floor(v_uvm.z + 0.001), seed = fract(v_uvm.z);
  float u = v_uvm.x, v = v_uvm.y, wallH = v_uvm.w;
  czm_materialInput mi;
  mi.str = v_uvm.xyz;
  mi.positionToEyeEC = -v_positionEC;
  czm_material tex = czm_getMaterial(mi);
  vec3 base = v_color.rgb * tex.diffuse * (1.0 + clamp(tex.shininess, -0.35, 0.45));
  float detail = 1.0 - smoothstep(350.0, 1400.0, d); // facade detail fades with distance
  float spec = 0.0;

  if (mat < 1.5) {
    bool block = wallH > 13.0;
    float floorH = block ? 2.8 : 2.7;
    float fl = floor(v / floorH), fy = fract(v / floorH);
    // Dirt and weathering: darker towards the foot, soft vertical rain streaks.
    float streak = vnoise(vec2(u * 0.9, v * 0.08 + seed * 31.0));
    base *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 2.5, v), detail);
    base *= 1.0 - 0.10 * detail * smoothstep(0.55, 0.95, streak);
    // Plinth: a stone/render base course.
    if (v < 0.55) base = mix(base, vec3(0.42, 0.41, 0.39) * (0.9 + 0.2 * vnoise(vec2(u * 3.0, v * 3.0))), detail * 0.85);
    // Contact shadow at the foot, eave shadow under the roof (houses).
    base *= mix(1.0, 0.72 + 0.28 * smoothstep(0.0, 0.9, v), detail);
    if (!block) base *= mix(1.0, 0.68 + 0.32 * smoothstep(0.0, 0.7, wallH - v), detail);
    // Facade style by seed: houses get floor bands; blocks are panels (seed < 0.6) or banded.
    bool panels = block && seed < 0.6;
    if (panels) {
      vec2 pj = vec2(abs(fract(u / 3.6 + 0.5) - 0.5) * 3.6, abs(fract(v / 2.8 + 0.5) - 0.5) * 2.8);
      if (min(pj.x, pj.y) < 0.025 && v > 0.55) base *= mix(1.0, 0.72, detail);
    } else if (fl >= 1.0 && v < wallH - 0.3) {
      float band = fy * floorH;
      if (band < 0.12) base *= mix(1.0, 1.14, detail);            // cornice catching light
      else if (band < 0.26) base *= mix(1.0, 0.84, detail);       // its shadow
    }
    if (mat < 0.5 && v > 0.55 && v < wallH - 0.4) {
      float pitch = 2.8;
      float col = floor(u / pitch);
      vec2 w = vec2(fract(u / pitch), fy);
      float cell = hash1(vec2(col, fl) + seed * 17.0);
      bool ground = fl < 0.5;
      // Ground floor: doors on houses, shop fronts on blocks.
      bool door = ground && !block && cell < 0.22;
      bool shop = ground && block && seed > 0.35;
      vec2 lo = door ? vec2(0.36, 0.0) : shop ? vec2(0.06, 0.12) : vec2(0.32, 0.33);
      vec2 hi = door ? vec2(0.64, 0.78) : shop ? vec2(0.94, 0.86) : block ? vec2(0.68, 0.78) : vec2(0.68, 0.74);
      vec2 sz = vec2(pitch, floorH);
      // Shutters on some houses.
      bool shutters = !block && !ground && seed > 0.55;
      if (shutters && w.y > lo.y && w.y < hi.y && ((w.x > lo.x - 0.13 && w.x < lo.x) || (w.x > hi.x && w.x < hi.x + 0.13))) {
        vec3 sc = seed > 0.8 ? vec3(0.22, 0.32, 0.22) : seed > 0.68 ? vec3(0.36, 0.24, 0.16) : vec3(0.55, 0.55, 0.52);
        float louvre = 0.85 + 0.15 * step(0.5, fract(w.y * sz.y * 14.0));
        base = mix(base, sc * louvre, detail);
      }
      if (all(greaterThan(w, lo)) && all(lessThan(w, hi))) {
        vec2 e = min(w - lo, hi - w) * sz;
        float frame = door ? 0.05 : 0.07;
        vec3 fill;
        if (door) {
          fill = vec3(0.30, 0.20, 0.13) * (0.9 + 0.1 * step(0.5, fract(w.x * sz.x * 3.0)));
        } else {
          // Glass: dark interior with a sky reflection that varies per pane; recessed (the
          // lintel shades the top, the reveal one side).
          vec3 glass = vec3(0.17, 0.21, 0.26) + vec3(0.07, 0.09, 0.12) * hash1(vec2(col, fl) + 3.1);
          float topDist = (hi.y - w.y) * sz.y, sideDist = (w.x - lo.x) * sz.x;
          glass *= 0.55 + 0.45 * smoothstep(0.06, 0.30, topDist) * smoothstep(0.06, 0.16, sideDist);
          fill = glass;
          if (!shop && abs(w.x - 0.5) < 0.012) fill = vec3(0.86, 0.85, 0.82);   // mullion
          vec3 r = reflect(normalize(v_positionEC), n);
          spec = detail * pow(max(dot(r, czm_lightDirectionEC), 0.0), 60.0) * step(frame, min(e.x, e.y));
        }
        if (min(e.x, e.y) < frame) fill = block ? vec3(0.62, 0.63, 0.64) : vec3(0.86, 0.85, 0.82);
        base = mix(base, fill, detail);
      }
      // Sill below windows, and grime washing down from it.
      if (!ground && w.x > lo.x - 0.02 && w.x < hi.x + 0.02) {
        float below = (lo.y - w.y) * sz.y;
        if (below >= 0.0 && below < 0.06) base = mix(base, vec3(0.9, 0.89, 0.86), detail);
        else if (below >= 0.06 && below < 0.9) base *= mix(1.0, 0.9 + 0.1 * smoothstep(0.06, 0.9, below) + 0.05 * vnoise(vec2(u * 12.0, 0.0)), detail);
      }
    }
  } else if (mat > 4.5 && mat < 5.5) {
    base = v_color.rgb * (0.95 + 0.1 * vnoise(vec2(u * 2.0, v * 2.0)));
  } else if (mat > 5.5) {
    // Rooftop units: ribbed metal sides, a darker base line.
    base = v_color.rgb * (abs(n.z) < 0.5 ? 0.9 + 0.1 * step(0.5, fract(u * 6.0)) : 1.0) * (abs(n.z) < 0.5 && v < 0.1 ? 0.7 : 1.0);
  }
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  float sky = 0.56 + 0.14 * dot(n, normalize(czm_normal * vec3(0.0, 0.0, 1.0)));
  vec3 c = base * (sky + 0.75 * sun * czm_lightColor) + spec * czm_lightColor;
  c = mix(c, vec3(0.70, 0.78, 0.86), clamp((d - 1500.0) / 9000.0, 0.0, 0.45));
  out_FragColor = vec4(c, 1.0);
}`;

let buildingMaterial: Material | undefined;
function material(): Material {
  const base = new URL(`${import.meta.env.BASE_URL}buildings/`, location.href).href;
  buildingMaterial ??= new Material({
    fabric: {
      type: "BuildingDetail",
      uniforms: { wall: `${base}wall.jpg`, tiles: `${base}tiles.jpg`, flat: `${base}flat.jpg`, gravel: `${base}gravel.jpg` },
      // str = (u, v [m], material + seed). Detail = photo / mid-grey. Roofs: two rotated
      // samples mixed by noise (no visible repeat) and large stains; emboss in shininess.
      source: `
float bh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bh(i), bh(i + vec2(1.0, 0.0)), f.x), mix(bh(i + vec2(0.0, 1.0)), bh(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 roofTex(float k, vec2 p) {
  return k < 2.5 ? texture(tiles, fract(p / 4.0)).rgb : k < 3.5 ? texture(flat, fract(p / 9.0)).rgb : texture(gravel, fract(p / 3.0)).rgb;
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  float k = floor(mi.str.z + 0.001);
  vec2 p = mi.str.xy;
  float far = smoothstep(60.0, 260.0, length(mi.positionToEyeEC));
  if (k > 4.5) { m.diffuse = vec3(1.0); return m; }
  vec3 t, t2;
  if (k < 1.5) {
    t = texture(wall, fract(p / 2.0)).rgb;
    t2 = texture(wall, fract((p + vec2(0.0, 0.02)) / 2.0)).rgb;
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
    if (k < 3.5) stains *= 0.93 + 0.07 * step(0.04, fract(p.x / 1.0));
    t *= stains;
    t2 *= stains;
  }
  vec3 dtl = t * (255.0 / 128.0);
  m.diffuse = k < 2.5 ? mix(dtl, vec3(1.0), far) : mix(dtl, vec3(1.0), far * 0.6);
  m.shininess = dot(t - t2, vec3(0.333)) * (k < 1.5 ? 1.5 : 3.0) * (1.0 - far);
  return m;
}`,
    },
    translucent: false,
  });
  return buildingMaterial;
}

function primitive(r: OsmResult, shadows: boolean): Primitive | undefined {
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
    appearance: new MaterialAppearance({ material: material(), vertexShaderSource: VS, fragmentShaderSource: FS, translucent: false, closed: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } }),
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
  private lastKey = "";

  private constructor(
    private readonly viewer: Viewer,
    private readonly o: OsmLayerOptions,
  ) {
    this.worker.onmessage = (e: MessageEvent<OsmResult>) => {
      const key = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (!key || !this.tiles.has(key)) return; // dropped meanwhile
      const p = e.data.trees ? (this.atlas ? treeImpostors(this.atlas, e.data.origin, e.data.trees) : undefined) : primitive(e.data, this.o.shadows);
      if (p) this.viewer.scene.primitives.add(p);
      this.tiles.set(key, p ?? null);
    };
  }

  static async create(viewer: Viewer, o: OsmLayerOptions): Promise<OsmLayer | undefined> {
    const url = await openFreeMapTiles();
    if (!url) return undefined;
    const l = new OsmLayer(viewer, o);
    l.url = url;
    // Photoreal tree impostors (CC0 models rendered offline); without them no trees are drawn.
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
    }
  }
}
