/**
 * Water on Google's 3D tiles: lakes, ponds and rivers from OpenStreetMap (OpenFreeMap vector
 * tiles), drawn as level surfaces that reflect our sky (atmosphere.ts) with wind ripples and
 * the sun's glint, instead of Google's photo of water (flat, dull, the sky of the day it was
 * taken, often noisy).
 *
 * Each polygon is a plane laid on the ellipsoid (1 km subdivisions: a 10 km lake sags 2 m),
 * set at Google's own water level there: the median of height picks on the tiles inside the
 * polygon, taken once the tiles are in. The shoreline is then where Google's banks rise out of
 * our plane (closer to the real one than OSM's outline); Google's water mesh, a few cm below,
 * is hidden by it. Polygons without a level yet are not drawn.
 *
 * Light (in HDR, scene units): Fresnel (2% looking straight down, all at grazing angles)
 * between the sky's radiance in the reflected direction and the water's own dark body colour,
 * plus the sun's glint (GGX on the rippled normal: bright enough to bloom). Ripples: six wave
 * trains round the wind direction, longer and slower in a stronger wind, faded with distance
 * (no shimmer far away).
 *
 * Standing water only (lakes, ponds): OSM's river polygons cover whole gravel beds. Streams z11
 * tiles (lakes: ±2, ~±40 km) and z14 tiles (ponds: ±1) round the glider. With the atmosphere only (HDR, Google 3D);
 * ?water3d=0: off.
 */
import * as Cesium from "cesium";
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Cartographic, Intersect, Matrix4, PolygonGeometry, PolygonHierarchy, Transforms, VertexFormat, type Viewer } from "cesium";
import { fetchWater, type WaterPolygon } from "@webflight/scenery";
import { lonLatToTile } from "@webflight/environment";
import type { Google3D } from "./google3d.ts";
import { SKY_LOOKUP_GLSL, type Atmosphere } from "./atmosphere.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as unknown as Record<string, any>;

const VS = /* glsl */ `
in vec3 position;
uniform vec2 u_origin;   // this polygon's frame origin, metres east/north in a global frame (mod 4096)
out vec3 v_posEC;
out vec2 v_xy;
void main() {
  vec4 p = czm_modelView * vec4(position, 1.0);
  v_posEC = p.xyz;
  v_xy = position.xy + u_origin;
  gl_Position = czm_projection * p;
}`;

const FS = /* glsl */ `${SKY_LOOKUP_GLSL}
in vec3 v_posEC;
in vec2 v_xy;
uniform vec4 u_wind;     // direction to (x east, y north), strength 0–1, time [s]
uniform vec3 u_body;     // the water's own colour, relative to the sky's light
uniform float u_glint;   // the sun's glint strength
uniform float u_hor[16]; // the terrain's horizon round this water: elevation [rad] every 22.5° from north
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
// Slopes of ten wave trains scattered round the wind (east, north), each faded where it is
// smaller than a few pixels (from the screen footprint, so grazing views don't shimmer in
// stripes), in slow gust patches.
vec2 waveSlope(vec2 p, float fp) {
  vec2 w = normalize(u_wind.xy + vec2(1e-4));
  float t = u_wind.w, k = 0.6 + 1.4 * u_wind.z;
  float gust = 0.55 + 0.9 * wNoise(p / 90.0 + w * t * 0.05);
  vec2 g = vec2(0.0);
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float L = 0.3 * pow(1.55, fi) * k;                    // wavelength 0.3 m … 15 m
    float a = (wHash(vec2(fi, 3.7)) - 0.5) * 2.2;          // angle off the wind
    vec2 d = vec2(w.x * cos(a) - w.y * sin(a), w.x * sin(a) + w.y * cos(a));
    float kk = 6.2831853 / L, om = sqrt(9.81 * kk);        // deep-water dispersion
    float s = 0.07 * (0.4 + 0.6 * u_wind.z) * gust * (1.0 - smoothstep(L * 0.12, L * 0.45, fp));
    g += d * s * cos(dot(d, p) * kk - om * t + 6.2831853 * wHash(vec2(fi, 9.1)));
  }
  return g;
}
void main() {
  float fp = max(length(dFdx(v_xy)), length(dFdy(v_xy)));
  vec2 sl = waveSlope(v_xy, fp);
  // The normal in the polygon's frame, then eye space.
  vec3 n = normalize(czm_normal * normalize(vec3(-sl, 1.0)));
  vec3 V = normalize(-v_posEC);
  if (dot(n, V) < 0.02) n = normalize(n + V * (0.02 - dot(n, V)));
  float NV = max(dot(n, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = wfSkyRadiance(normalize(czm_inverseViewRotation * R));
  vec3 skyUp = wfSkyRadiance(normalize(czm_inverseViewRotation * czm_normal * vec3(0.0, 0.0, 1.0)));
  // Below the hills round the water the reflection is of them, not of the sky (a lake in a
  // valley at low sun was a sheet of bright sky): their lit slopes, dim and green-brown.
  vec3 Rl = transpose(czm_normal) * R;  // in the water's own east/north/up
  float az = atan(Rl.x, Rl.y) / 6.2831853 * 16.0;
  az = az < 0.0 ? az + 16.0 : az;
  int i0 = int(floor(az)) - (int(floor(az)) / 16) * 16, i1 = i0 == 15 ? 0 : i0 + 1;
  float hor = mix(u_hor[i0], u_hor[i1], fract(az));
  float el = asin(clamp(Rl.z, -1.0, 1.0));
  float skyLum = dot(skyUp, vec3(0.2126, 0.7152, 0.0722));
  vec3 hill = vec3(0.07, 0.085, 0.055) * (dot(czm_lightColorHdr, vec3(0.33)) * 0.5 + skyLum * 0.8);
  sky = mix(hill, sky, smoothstep(hor - 0.01, hor + 0.015, el));
  vec3 body = u_body * dot(skyUp, vec3(0.2126, 0.7152, 0.0722));
  vec3 col = mix(body, sky, F);
  // The sun's glint: GGX. Where the ripples are too small to draw (far, grazing) they become
  // roughness, and the path glitters: many small facets catch the sun, most don't (a hashed
  // sparkle mask on a fine grid; a solid lobe was a sheet of white).
  vec3 L = czm_lightDirectionEC;
  float NL = max(dot(n, L), 0.0);
  if (NL > 0.0) {
    vec3 H = normalize(L + V);
    float NH = max(dot(n, H), 0.0);
    float a = mix(0.03, 0.07, u_wind.z) + clamp(fp * 0.012, 0.0, 0.05), a2 = a * a;
    float dd = NH * NH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    vec2 cell = floor(v_xy / max(fp * 1.5, 0.4) + u_wind.w * 0.7);
    float sparkle = mix(1.0, step(0.9, wHash(cell)) * 5.0, clamp(fp * 0.5, 0.0, 0.9));
    col += min(czm_lightColorHdr * D * Fs / (4.0 * NV + 1e-3) * u_glint * sparkle, vec3(15.0));
  }
#ifdef WATER_DEBUG
  col = vec3(4.0, 0.0, 0.0);
#endif
  out_FragColor = vec4(col, 1.0);
}`;

interface Body {
  poly: WaterPolygon;
  /** Frame at the polygon's centre on the ellipsoid; the plane is raised by `level`. */
  frame: Matrix4;
  model: Matrix4;
  centre: Cartographic;
  origin: Cartesian2;
  /** Points inside the polygon where Google's height is picked [lon, lat] (triangle centroids). */
  probes: [number, number][];
  /** The plane's own height at each probe above its base (0: level). */
  probeBase: number[];
  heights: number[];
  probeNext: number;
  /** When the level was last measured (it is measured again: tiles sharpen). */
  probedAt: number;
  /** The terrain's horizon seen from the water (16 directions), once the level is known. */
  horizon: number[];
  /** Water level in Google's own (unshifted) heights; drawn lowered by its current offset. */
  level: number | undefined;
  va: unknown;
  count: number;
  sphere: BoundingSphere;
  cmd: unknown;
}

export class Water {
  private readonly tiles = new Map<string, Body[] | null>();
  private readonly centres: Record<number, string> = {};
  private program: unknown;
  private wind = { dir: new Cartesian2(1, 0), strength: 0.2 };
  private readonly t0 = performance.now();
  /** Deep water's own colour (light scattered back from inside), relative to the sky's light. */
  private readonly body = new Cartesian3(0.045, 0.11, 0.11);
  private readonly sky: Record<string, () => unknown>;
  show = true;
  /** ?wglint= the sun's glint strength (tuning). */
  private readonly glint = Number(new URLSearchParams(location.search).get("wglint") ?? 0.25);

  constructor(
    private readonly viewer: Viewer,
    private readonly google3d: Google3D,
    atmosphere: Atmosphere,
    private readonly url: string,
    /** Our terrain's height [m] (Google's tiles are drawn lowered to match it). */
    private readonly groundAt: (latDeg: number, lonDeg: number, zoom?: number) => number | undefined,
  ) {
    this.sky = atmosphere.skyUniforms();
    viewer.scene.primitives.add(this);
  }

  /** The day's wind: from [deg], speed [kt]. */
  setWind(fromDeg: number, kt: number): void {
    const to = ((fromDeg + 180) * Math.PI) / 180;
    this.wind = { dir: new Cartesian2(Math.sin(to), Math.cos(to)), strength: Math.min(1, kt / 20) };
  }

  /** Every frame with the glider's position: tiles round it. */
  follow(latDeg: number, lonDeg: number): void {
    const ring = (z: number, r: number, keep: number, kinds: (k: string) => boolean, minAreaM2: number) => {
      const [fx, fy] = lonLatToTile(lonDeg, latDeg, z);
      const cx = Math.floor(fx), cy = Math.floor(fy), key = `${cx}/${cy}`;
      if (this.centres[z] === key) return;
      this.centres[z] = key;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.load(z, cx + dx, cy + dy, kinds, minAreaM2);
      for (const [k, bodies] of this.tiles) {
        const [tz, x, y] = k.split("/").map(Number) as [number, number, number];
        if (tz === z && (Math.abs(x - cx) > keep || Math.abs(y - cy) > keep)) {
          for (const b of bodies ?? []) (b.va as { destroy(): void }).destroy();
          this.tiles.delete(k);
        }
      }
    };
    // Standing water only: OSM maps rivers here as polygons over their whole gravel bed (at
    // Codlea a 300 m band of mostly dry stones became a sheet of water).
    ring(11, 2, 3, (k) => k === "lake" || k === "ocean", 20_000);
    ring(14, 1, 2, (k) => k === "pond" || k === "lake", 800);
  }

  private load(z: number, x: number, y: number, kinds: (k: string) => boolean, minAreaM2: number): void {
    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, null);
    void fetchWater(z, x, y, kinds, this.url)
      .then((all) => {
        if (!this.tiles.has(key)) return;
        const bodies = all
          .map((p) => ({ p, a: areaM2(p.rings[0]!) }))
          .filter((e) => e.a >= minAreaM2)
          .sort((a, b) => b.a - a.a)
          .slice(0, 80)
          .map((e) => this.build(e.p))
          .filter((b): b is Body => !!b);
        this.tiles.set(key, bodies);
      })
      .catch(() => {});
  }

  private build(poly: WaterPolygon): Body | undefined {
    const context = (this.viewer.scene as unknown as { context: unknown }).context;
    const ring = (r: [number, number][]) => Cartesian3.fromDegreesArray(r.slice(0, -1).flat());
    const triangulate = (rings: [number, number][][]) =>
      PolygonGeometry.createGeometry(new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(ring(rings[0]!), rings.slice(1).map((h) => new PolygonHierarchy(ring(h)))), vertexFormat: VertexFormat.POSITION_ONLY, granularity: Cesium.Math.toRadians(0.01) }));
    // Drawn 40 m past OSM's outline (at a reservoir in Google's photo the water reached well
    // past it: a teal rim round ours). Where the shore is higher than the water it hides the
    // plane anyway, so the shoreline is Google's; the levels are probed inside the outline.
    const geom = triangulate([offsetRing(poly.rings[0]!, 40), ...poly.rings.slice(1).map((h) => offsetRing(h, -40))]);
    const inner = triangulate(poly.rings);
    if (!geom || !inner) return undefined;
    const pos = geom.attributes.position!.values as unknown as Float64Array, idx = geom.indices as unknown as Uint16Array | Uint32Array;
    // Frame at the centre of the vertices, on the ellipsoid.
    const centreWC = BoundingSphere.fromVertices(Array.from(pos)).center;
    const centre = Cartographic.fromCartesian(centreWC);
    centre.height = 0;
    const frame = Transforms.eastNorthUpToFixedFrame(Cartographic.toCartesian(centre));
    const inv = Matrix4.inverseTransformation(frame, new Matrix4());
    const local = new Float32Array(pos.length), p = new Cartesian3(), n = pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) {
      Matrix4.multiplyByPoint(inv, Cartesian3.fromElements(pos[i]!, pos[i + 1]!, pos[i + 2]!, p), p);
      local[i] = p.x;
      local[i + 1] = p.y;
      local[i + 2] = p.z;
    }
    // Probes: centroids of the largest triangles of the outline itself (inside it).
    const tris: { a: number; c: [number, number]; b: number }[] = [];
    const ipos = inner.attributes.position!.values as unknown as Float64Array, iidx = inner.indices as unknown as Uint16Array | Uint32Array;
    const P = (k: number) => Cartesian3.fromElements(ipos[3 * k]!, ipos[3 * k + 1]!, ipos[3 * k + 2]!);
    for (let t = 0; t < iidx.length; t += 3) {
      const A = P(iidx[t]!), B = P(iidx[t + 1]!), Cc = P(iidx[t + 2]!);
      const area = Cartesian3.magnitude(Cartesian3.cross(Cartesian3.subtract(B, A, new Cartesian3()), Cartesian3.subtract(Cc, A, new Cartesian3()), new Cartesian3())) / 2;
      const cc = Cartographic.fromCartesian(Cartesian3.multiplyByScalar(Cartesian3.add(Cartesian3.add(A, B, new Cartesian3()), Cc, new Cartesian3()), 1 / 3, new Cartesian3()));
      tris.push({ a: area, c: [Cesium.Math.toDegrees(cc.longitude), Cesium.Math.toDegrees(cc.latitude)], b: 0 });
    }
    const best = tris.sort((a, b) => b.a - a.a).slice(0, 9);
    const probes = best.map((t) => t.c), probeBase = best.map((t) => t.b);
    const vb = C.Buffer.createVertexBuffer({ context, typedArray: local, usage: C.BufferUsage.STATIC_DRAW });
    const ib = C.Buffer.createIndexBuffer({ context, typedArray: idx instanceof Uint32Array ? idx : new Uint16Array(idx), usage: C.BufferUsage.STATIC_DRAW, indexDatatype: idx instanceof Uint32Array ? C.IndexDatatype.UNSIGNED_INT : C.IndexDatatype.UNSIGNED_SHORT });
    const va = new C.VertexArray({ context, indexBuffer: ib, attributes: [{ index: 0, vertexBuffer: vb, componentsPerAttribute: 3, componentDatatype: C.ComponentDatatype.FLOAT }] });
    const kx = 111_320 * Math.cos(centre.latitude);
    const origin = new Cartesian2(((Cesium.Math.toDegrees(centre.longitude) * kx) % 4096 + 4096) % 4096, ((Cesium.Math.toDegrees(centre.latitude) * 111_132) % 4096 + 4096) % 4096);
    const sphere = BoundingSphere.fromVertices(Array.from(pos));
    return { poly, frame, model: Matrix4.clone(frame), centre, origin, probes, probeBase, heights: [], probeNext: 0, level: undefined, horizon: new Array(16).fill(0), probedAt: 0, va, count: idx.length, sphere, cmd: undefined };
  }

  /**
   * Google's water level: a few height picks a frame (0.8 ms) among the bodies in view still
   * without one, or measured more than 15 s ago (finer tiles have come since). A pick counts
   * only within 60 m of our terrain: on a coarse tile (before the fine ones load) it lands on
   * a chord of a triangle hundreds of km across, kilometres below the ground; a reservoir's
   * water can be tens of metres above the valley floor the terrain data has.
   */
  private probe(cull: { computeVisibility(b: BoundingSphere): number }): void {
    const t0 = performance.now();
    for (const bodies of this.tiles.values())
      for (const b of bodies ?? []) {
        if (b.probeNext >= b.probes.length) {
          if (b.level === undefined || t0 - b.probedAt > 15_000) (b.probeNext = 0), (b.heights = []);
          else continue;
        }
        if (cull.computeVisibility(b.sphere) === Intersect.OUTSIDE) continue;
        while (b.probeNext < b.probes.length && performance.now() - t0 < 0.8) {
          const [lon, lat] = b.probes[b.probeNext++]!;
          const h = this.google3d.tileset.getHeight(Cartographic.fromDegrees(lon, lat), this.viewer.scene), o = this.groundAt(lat, lon);
          if (h !== undefined && o !== undefined && Number.isFinite(h) && Math.abs(h - o) < 60) b.heights.push(h - b.probeBase[b.probeNext - 1]!);
        }
        if (b.probeNext >= b.probes.length) {
          b.probedAt = t0;
          if (b.heights.length >= Math.min(3, b.probes.length)) {
            const v = [...b.heights].sort((x, y) => x - y);
            // The median, a little above (Google's water mesh is noisy; ours covers it).
            b.level = v[Math.floor(v.length / 2)]! + 0.25 + this.google3d.offsetM;
            this.place(b);
            this.horizonOf(b);
          }
        }
        if (performance.now() - t0 >= 0.8) return;
      }
  }

  /**
   * The highest elevation angle of our terrain in 16 directions from the water's centre, out to
   * 8 km (ground beyond the shore only: the first 60 m skipped).
   */
  private horizonOf(b: Body): void {
    const lat0 = Cesium.Math.toDegrees(b.centre.latitude), lon0 = Cesium.Math.toDegrees(b.centre.longitude);
    const kx = 111_320 * Math.cos(b.centre.latitude), ky = 111_132, h0 = b.level! - this.google3d.offsetM;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      let best = 0;
      for (let d = 60 + b.sphere.radius * 0.5; d < 8000; d *= 1.18) {
        const h = this.groundAt(lat0 + (Math.cos(a) * d) / ky, lon0 + (Math.sin(a) * d) / kx, 12);
        if (h !== undefined) best = Math.max(best, Math.atan2(h - h0, d));
      }
      b.horizon[k] = best;
    }
  }

  /** The plane at its level, as Google's tiles are drawn now (lowered by their offset). */
  private place(b: Body): void {
    const h = b.level! - this.google3d.offsetM, f = b.frame;
    Matrix4.setTranslation(f, new Cartesian3(f[12]! + f[8]! * h, f[13]! + f[9]! * h, f[14]! + f[10]! * h), b.model);
  }
  private placedOffset = Number.NaN;

  /** One body's uniforms (all of them, in one place). */
  private uniforms(b: Body, wind: Cartesian4): Record<string, () => unknown> {
    return { ...this.sky, u_origin: () => b.origin, u_wind: () => wind, u_body: () => this.body, u_glint: () => this.glint, u_hor: () => b.horizon };
  }

  /** Cesium primitive interface. */
  update(frameState: { commandList: unknown[]; context: unknown; cullingVolume: { computeVisibility(b: BoundingSphere): number }; passes: { render: boolean } }): void {
    if (!this.show || !frameState.passes.render) return;
    this.probe(frameState.cullingVolume);
    // Google's offset moved (it is blended in): every plane with it.
    if (this.google3d.offsetM !== this.placedOffset) {
      this.placedOffset = this.google3d.offsetM;
      for (const bodies of this.tiles.values()) for (const b of bodies ?? []) if (b.level !== undefined) this.place(b);
    }
    const context = frameState.context;
    if (!this.program) this.program = C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: (new URLSearchParams(location.search).get("waterdbg") === "1" ? "#define WATER_DEBUG\n" : "") + FS, attributeLocations: { position: 0 } });
    const w = this.wind, t = (performance.now() - this.t0) / 1000;
    const wind = new Cartesian4(w.dir.x, w.dir.y, w.strength, t);
    for (const bodies of this.tiles.values())
      for (const b of bodies ?? []) {
        if (b.level === undefined) continue;
        if (frameState.cullingVolume.computeVisibility(b.sphere) === Intersect.OUTSIDE) continue;
        if (!b.cmd)
          b.cmd = new C.DrawCommand({
            vertexArray: b.va,
            primitiveType: C.PrimitiveType.TRIANGLES,
            shaderProgram: this.program,
            renderState: C.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true, cull: { enabled: false } }),
            pass: C.Pass.OPAQUE,
            owner: this,
            modelMatrix: b.model,
            boundingVolume: b.sphere,
            count: b.count,
            uniformMap: this.uniforms(b, wind),
          });
        const cmd = b.cmd as Record<string, unknown>;
        cmd["uniformMap"] = this.uniforms(b, wind);
        frameState.commandList.push(b.cmd);
      }
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    for (const bodies of this.tiles.values()) for (const b of bodies ?? []) (b.va as { destroy(): void }).destroy();
    this.tiles.clear();
  }
}

/**
 * A closed [lon, lat] ring moved outwards (away from its inside) by d metres, each vertex along
 * its corner's bisector (miter, limited). Enough for tens of metres round a lake.
 */
function offsetRing(r: [number, number][], d: number): [number, number][] {
  const lat0 = r[0]![1], kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 111_132;
  const pts = r.slice(0, -1).map(([lo, la]) => [lo * kx, la * ky] as [number, number]);
  const n = pts.length;
  if (n < 3) return r;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]!, [x2, y2] = pts[(i + 1) % n]!;
    area += x1 * y2 - x2 * y1;
  }
  // Outward normal of an edge: right of it for a counter-clockwise ring, left for clockwise.
  const sgn = area > 0 ? 1 : -1;
  const normal = (a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [(sgn * dy) / l, (-sgn * dx) / l] as [number, number];
  };
  const out = pts.map((p, i) => {
    const n1 = normal(pts[(i - 1 + n) % n]!, p), n2 = normal(p, pts[(i + 1) % n]!);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const k = d / Math.max(0.4, mx * n1[0] + my * n1[1]);
    return [(p[0] + mx * k) / kx, (p[1] + my * k) / ky] as [number, number];
  });
  out.push(out[0]!);
  return out;
}

/** Area of a closed [lon, lat] ring [m²] (local equirectangular). */
function areaM2(r: [number, number][]): number {
  const k = 111_320 * Math.cos(((r[0]?.[1] ?? 0) * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * k * (r[j]![1] + r[i]![1]) * 111_132;
  return Math.abs(a / 2);
}
