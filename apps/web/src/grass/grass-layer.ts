/**
 * 3D grass around the camera when it is near the ground (on the airfield, low passes): cells of
 * `cellM` metres within `radiusM` of the camera, built in grass-worker.ts, one Primitive each.
 * The shader sways the blade tips in the wind and thins the grass out with distance by
 * dithering (no blending, no sorting), so it fades into the textured ground.
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
  Transforms,
  type Cartographic,
  type Viewer,
} from "cesium";
import type { GrassRequest, GrassResult } from "./grass-worker.ts";

const VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float sway;
in vec4 color;
in float batchId;
out vec3 v_positionEC;
out vec4 v_color;
out float v_sway;
out vec3 v_upEC;
void main() {
  vec4 p = czm_computePosition();
  // Positions may be in the cell's local frame: get the world position through czm_model.
  mat3 m3 = mat3(czm_model);
  vec3 world = (czm_model * vec4(position3DHigh + position3DLow, 1.0)).xyz;
  vec3 up = normalize(world);
  // Wind: tips sway along a slowly turning horizontal direction, phase by position.
  float t = czm_frameNumber / 60.0;
  float ph = dot(world, vec3(0.37, 0.71, 0.53));
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
  vec3 north = cross(up, east);
  float gust = 0.5 + 0.5 * sin(t * 0.7 + ph * 0.05);
  vec3 dir = normalize(east * 0.8 + north * 0.6);
  p.xyz += (dir * sway * (0.025 + 0.03 * gust) * sin(t * 2.3 + ph * 1.7)) * m3;
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_color = color;
  v_sway = sway;
  v_upEC = mat3(czm_view) * up;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const FS = `
in vec3 v_positionEC;
in vec4 v_color;
in float v_sway;
in vec3 v_upEC;
void main() {
  float d = length(v_positionEC);
  // Thin out with distance: dithered (stable per pixel), from FADE0 to FADE1 metres.
  float keep = 1.0 - smoothstep(FADE0, FADE1, d);
  float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  if (h > keep) discard;
  // Light: sun on the blade (treated as facing up-ish), sky light, a little translucency.
  float sun = max(dot(normalize(v_upEC), czm_lightDirectionEC), 0.0);
  vec3 c = v_color.rgb * (0.5 + 0.55 * sun * czm_lightColor + 0.15 * v_sway);
  out_FragColor = vec4(c, 1.0);
}`;

export interface GrassOptions {
  cellM: number;
  radiusM: number;
  /** Tufts per m² on full grass. */
  density: number;
  /** Only while the camera is this low above the ground [m]. */
  maxHeightM: number;
}

export class GrassLayer {
  private readonly worker = new Worker(new URL("./grass-worker.ts", import.meta.url), { type: "module" });
  private readonly cells = new Map<string, Primitive | null>();
  private readonly pending = new Map<number, string>();
  private nextId = 1;
  private lastKey = "";

  constructor(
    private readonly viewer: Viewer,
    private readonly osmUrl: string,
    private readonly s2Url: string,
    private readonly o: GrassOptions,
  ) {
    this.worker.onmessage = (e: MessageEvent<GrassResult & { error?: string }>) => {
      const key = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (!key || !this.cells.has(key)) return;
      if (e.data.error || !e.data.count) {
        if (e.data.error) this.cells.delete(key); // retry on the next update
        return;
      }
      const p = this.primitive(e.data);
      this.viewer.scene.primitives.add(p);
      this.cells.set(key, p);
    };
  }

  private primitive(r: GrassResult): Primitive {
    const pos = new Float64Array(r.positions);
    const n = pos.length / 3;
    const geometry = new Geometry({
      attributes: Object.assign(new GeometryAttributes(), {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
        sway: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: r.sway }),
        color: new GeometryAttribute({ componentDatatype: ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: r.colors }),
      }),
      indices: Uint32Array.from({ length: n }, (_, i) => i),
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(Array.from(pos)),
    });
    const fs = FS.replaceAll("FADE0", (this.o.radiusM * 0.6).toFixed(1)).replaceAll("FADE1", (this.o.radiusM * 0.95).toFixed(1));
    return new Primitive({
      geometryInstances: new GeometryInstance({ geometry, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(r.origin[0], r.origin[1], r.origin[2])) }),
      appearance: new Appearance({ vertexShaderSource: VS, fragmentShaderSource: fs, translucent: false, closed: false, renderState: { depthTest: { enabled: true }, cull: { enabled: false } } }),
      asynchronous: false,
      compressVertices: false,
      allowPicking: false,
    });
  }

  /** Stream cells around the camera (call each frame; cheap when nothing changes). */
  update(camera: Cartographic, groundM: number | undefined): void {
    const latDeg = (camera.latitude * 180) / Math.PI, lonDeg = (camera.longitude * 180) / Math.PI;
    const low = groundM !== undefined && camera.height - groundM < this.o.maxHeightM;
    const c = this.o.cellM, kx = 111_320 * Math.cos((latDeg * Math.PI) / 180), ky = 111_132;
    const cx = Math.floor((lonDeg * kx) / c), cy = Math.floor((latDeg * ky) / c);
    const key = low ? `${cx}/${cy}` : "high";
    if (key === this.lastKey) return;
    this.lastKey = key;
    const want = new Set<string>();
    if (low) {
      const r = Math.ceil(this.o.radiusM / c);
      const jobs: [number, number, number][] = [];
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if ((Math.max(0, Math.abs(dx) - 0.5) * c) ** 2 + (Math.max(0, Math.abs(dy) - 0.5) * c) ** 2 > this.o.radiusM ** 2) continue;
          want.add(`${cx + dx}/${cy + dy}`);
          jobs.push([dx * dx + dy * dy, cx + dx, cy + dy]);
        }
      for (const [, x, y] of jobs.sort((a, b) => a[0] - b[0])) {
        const k = `${x}/${y}`;
        if (this.cells.has(k)) continue;
        this.cells.set(k, null);
        const id = this.nextId++;
        this.pending.set(id, k);
        // Densest at the camera, thinning outwards (the fade takes the rest).
        const dist = Math.hypot(x - cx, y - cy) * c;
        const density = this.o.density * Math.max(0.25, 1 - dist / this.o.radiusM);
        const req: GrassRequest = { id, lat: ((y + 0.5) * c) / ky, lon: ((x + 0.5) * c) / kx, cellM: c, density, osmUrl: this.osmUrl, s2Url: this.s2Url, seed: (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0 };
        this.worker.postMessage(req);
      }
    }
    for (const [k, p] of this.cells) {
      if (want.has(k)) continue;
      if (p) this.viewer.scene.primitives.remove(p);
      this.cells.delete(k);
    }
  }
}
