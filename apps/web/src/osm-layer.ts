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
in vec3 uvm;
in float batchId;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
out vec3 v_uvm;
void main() {
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  v_uvm = uvm;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

// Walls: plaster photo, and windows drawn from the wall coordinates (2.8 m apart, 2.7 m
// floors; glass with a sky tint and a sun glint, light frames). Roofs: clay tiles or bitumen.
// The photos are detail maps (mean = mid-grey), so each building keeps its own colour.
const FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
in vec3 v_uvm;
void main() {
  vec3 n = normalize(v_normalEC);
  if (!gl_FrontFacing) n = -n;
  float d = length(v_positionEC);
  czm_materialInput mi;
  mi.str = v_uvm;
  mi.positionToEyeEC = -v_positionEC;
  czm_material mat = czm_getMaterial(mi);
  vec3 base = v_color.rgb * mat.diffuse * (1.0 + clamp(mat.shininess, -0.35, 0.45));
  float spec = 0.0;
  if (v_uvm.z < 0.5 && v_uvm.y > 0.0) {
    vec2 w = vec2(fract(v_uvm.x / 2.8), fract(v_uvm.y / 2.7));
    vec2 lo = vec2(0.32, 0.33), hi = vec2(0.68, 0.74);
    if (all(greaterThan(w, lo)) && all(lessThan(w, hi))) {
      vec2 e = min(w - lo, hi - w) * vec2(2.8, 2.7);
      float far = smoothstep(500.0, 1500.0, d);
      // Glass: dark interior under a reflection of the sky.
      vec3 glass = vec3(0.20, 0.25, 0.31) + 0.10 * vec3(0.6, 0.75, 0.95) * fract(sin(dot(floor(v_uvm.xy / vec2(2.8, 2.7)), vec2(12.9898, 78.233))) * 43758.5453);
      // Recessed: the lintel shades the top of the pane, the reveal one side.
      float topDist = (hi.y - w.y) * 2.7, sideDist = (w.x - lo.x) * 2.8;
      glass *= 0.55 + 0.45 * smoothstep(0.07, 0.30, topDist) * smoothstep(0.07, 0.16, sideDist);
      vec3 win = min(e.x, e.y) < 0.07 ? vec3(0.86, 0.85, 0.82) : glass;
      // A sill catching the light under the window.
      if ((w.y - lo.y) * 2.7 < 0.05) win = vec3(0.93, 0.92, 0.9);
      // A mullion down the middle.
      if (abs(w.x - 0.5) < 0.012) win = vec3(0.86, 0.85, 0.82);
      base = mix(win, base, far);
      vec3 r = reflect(normalize(v_positionEC), n);
      spec = (1.0 - far) * (min(e.x, e.y) < 0.07 ? 0.0 : pow(max(dot(r, czm_lightDirectionEC), 0.0), 60.0));
    }
  }
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  // Sky light from above, a little bounce from below.
  float sky = 0.56 + 0.14 * dot(n, normalize(czm_normal * vec3(0.0, 0.0, 1.0)));
  vec3 c = base * (sky + 0.75 * sun * czm_lightColor) + spec * czm_lightColor;
  // Aerial perspective: fade to the haze with distance.
  c = mix(c, vec3(0.70, 0.78, 0.86), clamp((d - 1500.0) / 9000.0, 0.0, 0.45));
  out_FragColor = vec4(c, 1.0);
}`;

let buildingMaterial: Material | undefined;
function material(): Material {
  const base = new URL(`${import.meta.env.BASE_URL}buildings/`, location.href).href;
  buildingMaterial ??= new Material({
    fabric: {
      type: "BuildingDetail",
      uniforms: { wall: `${base}wall.jpg`, tiles: `${base}tiles.jpg`, flat: `${base}flat.jpg` },
      // str = (u, v [m], material). Detail = photo / mid-grey, fading to 1 with distance
      // (the photos have no mipmaps: far away they would shimmer).
      source: `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        float k = mi.str.z;
        vec3 t = k < 1.5 ? texture(wall, fract(mi.str.xy / 2.0)).rgb : k < 2.5 ? texture(tiles, fract(mi.str.xy / 4.0)).rgb : texture(flat, fract(mi.str.xy / 12.0)).rgb;
        float far = smoothstep(60.0, 260.0, length(mi.positionToEyeEC));
        // Walls: gentle plaster grain; roofs: the full tile pattern.
        vec3 dtl = t * (255.0 / 128.0);
        if (k < 1.5) dtl = mix(vec3(1.0), dtl, 0.6);
        m.diffuse = mix(dtl, vec3(1.0), far);
        // Relief: emboss from the photo's brightness a few centimetres further up (light
        // comes from above: the upper edges of tiles and bumps catch it). In m.shininess.
        vec2 up = mi.str.xy + vec2(0.0, k < 1.5 ? 0.02 : 0.05);
        vec3 t2 = k < 1.5 ? texture(wall, fract(up / 2.0)).rgb : k < 2.5 ? texture(tiles, fract(up / 4.0)).rgb : texture(flat, fract(up / 12.0)).rgb;
        m.shininess = (dot(t - t2, vec3(0.333)) * (k < 1.5 ? 1.5 : 3.0)) * (1.0 - far);
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
      uvm: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: m.uvm }),
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
