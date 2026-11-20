/**
 * Windsocks by the runways near the camera, showing the day's surface wind. A glider pilot
 * reads one on every approach; Google's photos show at most a smudge.
 *
 * Where: placed as flight sims place them where no survey says (nothing hand-made per field):
 * beside every runway, a little past its first threshold on the left of the landing direction,
 * clear of the edge (15 m off a grass strip, 60 m off a paved runway, outside its shoulders),
 * and on runways of 1,500 m or more a second one by the other threshold.
 *
 * What: a 6 m pole and a 3.6 m sock in five orange and white bands (as ICAO's: fully
 * stretched at about 15 kt), pointing downwind and drooping in light air, with a little
 * flutter. The wind is the weather's 10 m wind the simulation flies in, only displayed.
 *
 * Standing on Google's ground: the drawn tiles' height at the pole's foot, picked when the
 * tiles there are in view (one pick a frame, again every 20 s while near as tiles sharpen), kept
 * with Google's height offset at the time so it follows when the offset moves; until then our
 * terrain's height. ?windsocks=0 turns them off.
 */
import { Cartesian3, Cartographic, Color, ColorGeometryInstanceAttribute, CylinderGeometry, GeometryInstance, Matrix4, PerInstanceColorAppearance, Primitive, ShadowMode, type Viewer } from "cesium";
import type { Google3D } from "./google3d.ts";
import type { Painted, RunwayPaint } from "./runway-paint.ts";

const POLE_M = 6;
const SEG = 5;
const SEG_M = 0.72;
/** Mouth and tail radius [m]. */
const R0 = 0.45, R1 = 0.17;
/** Made within this distance of the camera, taken away past DROP_M. */
const NEAR_M = 6000;
const DROP_M = 9000;

const ORANGE = Color.fromCssColorString("#f05a1e"), WHITE = Color.fromCssColorString("#eeeeea"), POLE = Color.fromCssColorString("#c9ccce");

interface Sock {
  key: string;
  lat: number;
  lon: number;
  /** Google's ground here plus their offset when picked (their unshifted height), if known. */
  unshifted?: number;
  pickedAt: number;
  pole: Primitive;
  segs: Primitive[];
  phase: number;
}

function piece(viewer: Viewer, length: number, top: number, bottom: number, color: Color): Primitive {
  const p = new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new CylinderGeometry({ length, topRadius: top, bottomRadius: bottom, slices: 20, vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    }),
    appearance: new PerInstanceColorAppearance({ flat: false, translucent: false, closed: false }),
    shadows: ShadowMode.ENABLED,
    asynchronous: false,
  });
  viewer.scene.primitives.add(p);
  return p;
}

export class Windsocks {
  private readonly socks = new Map<string, Sock>();
  private readonly off: () => void;
  private readonly t0 = performance.now();
  private readonly s = { up: new Cartesian3(), east: new Cartesian3(), north: new Cartesian3(), d: new Cartesian3(), dir: new Cartesian3(), x: new Cartesian3(), y: new Cartesian3(), p: new Cartesian3(), c: new Cartesian3(), base: new Cartesian3() };

  constructor(
    private readonly viewer: Viewer,
    private readonly runways: RunwayPaint,
    private readonly google3d: Google3D | undefined,
    private readonly groundAt: (latDeg: number, lonDeg: number) => number | undefined,
    private readonly wind: { fromDeg: number; kt: number },
  ) {
    this.off = viewer.scene.preRender.addEventListener(() => this.update());
  }

  destroy(): void {
    this.off();
    for (const k of [...this.socks.keys()]) this.remove(k);
  }

  /** Where they stand (for tests). */
  info(): { key: string; lat: number; lon: number; picked: boolean }[] {
    return [...this.socks.values()].map((s) => ({ key: s.key, lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6), picked: s.unshifted !== undefined }));
  }

  private remove(k: string): void {
    const s = this.socks.get(k);
    if (!s) return;
    const prims = this.viewer.scene.primitives;
    for (const p of [s.pole, ...s.segs]) prims.remove(p);
    this.socks.delete(k);
  }

  /** The feet of a runway's windsocks [world]. */
  private sites(r: Painted): { key: string; pos: Cartesian3 }[] {
    const L = 2 * r.halfL, paved = r.material === "asphalt" || r.material === "concrete";
    const clear = r.halfW + (paved ? 60 : 15), past = Math.min(150, 0.15 * L);
    const at = (along: number, across: number) => {
      const p = Cartesian3.add(r.centre, Cartesian3.multiplyByScalar(r.along, along, new Cartesian3()), new Cartesian3());
      return Cartesian3.add(p, Cartesian3.multiplyByScalar(r.across, across, new Cartesian3()), p);
    };
    // Left of the landing direction: −across for the le end, +across for the he end.
    const out = [{ key: `${r.name}@${r.centre.x.toFixed(0)}:le`, pos: at(-r.halfL + past, -clear) }];
    if (L >= 1500) out.push({ key: `${r.name}@${r.centre.x.toFixed(0)}:he`, pos: at(r.halfL - past, clear) });
    return out;
  }

  private update(): void {
    const cam = this.viewer.camera.positionWC;
    const wanted = new Set<string>();
    for (const r of this.runways.all) {
      if (Cartesian3.distance(cam, r.centre) - r.halfL > NEAR_M) continue;
      for (const site of this.sites(r)) {
        wanted.add(site.key);
        if (this.socks.has(site.key)) continue;
        const c = Cartographic.fromCartesian(site.pos);
        const pole = piece(this.viewer, POLE_M, 0.05, 0.07, POLE);
        const segs = Array.from({ length: SEG }, (_, i) => piece(this.viewer, SEG_M, R0 + ((R1 - R0) * (i + 1)) / SEG, R0 + ((R1 - R0) * i) / SEG, i % 2 === 0 ? ORANGE : WHITE));
        this.socks.set(site.key, { key: site.key, lat: (c.latitude * 180) / Math.PI, lon: (c.longitude * 180) / Math.PI, pickedAt: -1e9, pole, segs, phase: Math.random() * 10 });
      }
    }
    for (const [k, s] of this.socks) {
      const base = Cartesian3.fromDegrees(s.lon, s.lat, 0, undefined, this.s.base);
      if (!wanted.has(k) && Cartesian3.distance(cam, base) > DROP_M) this.remove(k);
    }
    this.pickOne(cam);
    const t = (performance.now() - this.t0) / 1000;
    for (const s of this.socks.values()) this.place(s, t);
  }

  /** One height pick a frame: the nearest windsock not yet (or not lately) picked. */
  private pickOne(cam: Cartesian3): void {
    const g = this.google3d;
    if (!g?.offsetKnown) return;
    const now = performance.now();
    let best: Sock | undefined, bd = 3000;
    for (const s of this.socks.values()) {
      if (now - s.pickedAt < (s.unshifted === undefined ? 1500 : 20_000)) continue;
      // (From the camera to the foot at sea level: the camera's own height comes in too.)
      const c = Cartographic.fromCartesian(cam);
      const d = Cartesian3.distance(Cartesian3.fromRadians(c.longitude, c.latitude, 0), Cartesian3.fromDegrees(s.lon, s.lat, 0, undefined, this.s.p));
      if (d < bd) (best = s), (bd = d);
    }
    if (!best) return;
    best.pickedAt = now;
    const h = g.tileset.getHeight(Cartographic.fromDegrees(best.lon, best.lat), this.viewer.scene);
    const ours = this.groundAt(best.lat, best.lon);
    // The tiles are drawn lowered onto our terrain: accept only near it (a coarse tile can
    // answer tens of metres off).
    if (h !== undefined && Number.isFinite(h) && (ours === undefined || Math.abs(h - ours) < 25)) best.unshifted = h + g.offsetM;
  }

  private place(s: Sock, t: number): void {
    const v = this.s;
    const g = this.google3d;
    const ground = s.unshifted !== undefined && g ? s.unshifted - g.offsetM : this.groundAt(s.lat, s.lon) ?? 0;
    const base = Cartesian3.fromDegrees(s.lon, s.lat, ground, undefined, v.base);
    v.up = Cartesian3.normalize(base, v.up);
    Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, v.up, v.east), v.east);
    Cartesian3.cross(v.up, v.east, v.north);
    // The pole, its centre half way up.
    this.orient(s.pole, Cartesian3.add(base, Cartesian3.multiplyByScalar(v.up, POLE_M / 2, v.c), v.c), v.up);
    // The sock from the top of the pole, downwind, drooping in light air, fluttering.
    const kt = Math.max(0, this.wind.kt * (1 + 0.12 * Math.sin(t * 0.7 + s.phase) + 0.08 * Math.sin(t * 2.3 + 2 * s.phase)));
    const ext = Math.min(1, kt / 15);
    const to = ((this.wind.fromDeg + 180) * Math.PI) / 180 + (0.06 + 0.12 * (1 - ext)) * Math.sin(t * (1.5 + 2.5 * ext) + s.phase);
    Cartesian3.add(Cartesian3.multiplyByScalar(v.east, Math.sin(to), v.d), Cartesian3.multiplyByScalar(v.north, Math.cos(to), v.x), v.d);
    const p = Cartesian3.add(base, Cartesian3.multiplyByScalar(v.up, POLE_M - 0.1, v.p), v.p);
    const droop0 = ((1 - ext) * 72 * Math.PI) / 180, dDroop = ((2 + (1 - ext) * 4) * Math.PI) / 180;
    for (let i = 0; i < SEG; i++) {
      const a = Math.min(Math.PI / 2 - 0.05, droop0 + i * dDroop);
      Cartesian3.add(Cartesian3.multiplyByScalar(v.d, Math.cos(a), v.dir), Cartesian3.multiplyByScalar(v.up, -Math.sin(a), v.x), v.dir);
      const centre = Cartesian3.add(p, Cartesian3.multiplyByScalar(v.dir, SEG_M / 2, v.c), v.c);
      this.orient(s.segs[i]!, centre, v.dir);
      Cartesian3.add(p, Cartesian3.multiplyByScalar(v.dir, SEG_M * 0.97, v.y), p);
    }
  }

  /** A cylinder's model matrix: its axis (local z) along `axis`, centred at `centre`. */
  private orient(prim: Primitive, centre: Cartesian3, axis: Cartesian3): void {
    const z = Cartesian3.normalize(axis, new Cartesian3());
    const ref = Math.abs(z.z) < 0.9 ? Cartesian3.UNIT_Z : Cartesian3.UNIT_X;
    const x = Cartesian3.normalize(Cartesian3.cross(ref, z, new Cartesian3()), new Cartesian3());
    const y = Cartesian3.cross(z, x, new Cartesian3());
    prim.modelMatrix = Matrix4.unpack([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, centre.x, centre.y, centre.z, 1], 0, prim.modelMatrix);
  }
}
