/**
 * OpenStreetMap buildings and forest trees around the aircraft, everywhere (outside
 * Switzerland, where swisstopo's surveyed 3D tiles are used instead). Meshes are built in
 * osm-worker.ts; each tile becomes one Primitive with per-vertex colours and a small
 * sun-lit shader, so a town is a handful of draw calls.
 *  - buildings: zoom-14 tiles (~1.7 km) within ±1 tile
 *  - trees: zoom-16 cells (~430 m) within ±`treeRings` cells, nearest first
 */
import {
  Appearance,
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
in float batchId;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
void main() {
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_color = color;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
void main() {
  vec3 n = normalize(v_normalEC);
  if (!gl_FrontFacing) n = -n;
  float sun = max(dot(n, czm_lightDirectionEC), 0.0);
  // Sky light from above, a little bounce from below.
  float sky = 0.42 + 0.18 * dot(n, normalize(czm_normal * vec3(0.0, 0.0, 1.0)));
  vec3 c = v_color.rgb * (sky + 0.85 * sun * czm_lightColor);
  // Aerial perspective: fade to the haze with distance.
  float d = length(v_positionEC);
  c = mix(c, vec3(0.70, 0.78, 0.86), clamp((d - 1500.0) / 9000.0, 0.0, 0.45));
  out_FragColor = vec4(c, 1.0);
}`;

function primitive(r: OsmResult, shadows: boolean): Primitive | undefined {
  const m: Mesh = r.mesh;
  if (!m.indices.length) return undefined;
  const pos = new Float64Array(m.positions);
  const geometry = new Geometry({
    attributes: Object.assign(new GeometryAttributes(), {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: m.normals }),
      color: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: m.colors }),
    }),
    indices: m.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(pos)),
  });
  const [lon, lat, h] = r.origin;
  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, h)) }),
    appearance: new Appearance({ vertexShaderSource: VS, fragmentShaderSource: FS, translucent: false, closed: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } }),
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
  private lastKey = "";

  private constructor(
    private readonly viewer: Viewer,
    private readonly o: OsmLayerOptions,
  ) {
    this.worker.onmessage = (e: MessageEvent<OsmResult>) => {
      const key = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (!key || !this.tiles.has(key)) return; // dropped meanwhile
      const p = primitive(e.data, this.o.shadows);
      if (p) this.viewer.scene.primitives.add(p);
      this.tiles.set(key, p ?? null);
    };
  }

  static async create(viewer: Viewer, o: OsmLayerOptions): Promise<OsmLayer | undefined> {
    const url = await openFreeMapTiles();
    if (!url) return undefined;
    const l = new OsmLayer(viewer, o);
    l.url = url;
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
          jobs.push([dx * dx + dy * dy, k, { kind: "trees", x, y, spacingM: this.o.treeSpacingM }]);
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
