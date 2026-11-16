/**
 * Cumulus clouds from soft sprite puffs (the classic flight-simulator technique): each cloud
 * is a cluster of camera-facing puffs filling a dome with a flat base at the cloud base. Puffs
 * are shaded by height (grey-blue base, white tops) and by the sun direction, sorted back to
 * front for clean blending, and fade with distance into the haze.
 */
import { LOOK } from "./lighting.ts";
import { BillboardCollection, BoundingRectangle, Cartesian3, Color, NearFarScalar, Transforms, Matrix4, type Billboard, type Scene } from "cesium";

export interface CloudSpec {
  /** Stable id: a cloud keeps its shape while the set around it changes. */
  id: string;
  latDeg: number;
  lonDeg: number;
  /** Cloud base [m]. */
  baseM: number;
  /** Horizontal radius [m]. */
  radiusM: number;
  /** 0..1: grows while forming, shrinks/fades while dying. */
  size: number;
  /** 0..1 opacity. */
  opacity: number;
}

interface Puff {
  /** Offset in the cloud's local east-north-up frame [m]. */
  e: number;
  n: number;
  u: number;
  sizeM: number;
  shade: Color;
  tex: number;
  /** Width/height of the sprite relative to sizeM (base puffs are wide and flat). */
  aspect?: number;
}

/**
 * The base of a cumulus: a wide slab with a lumpy top and a straight, slightly darker bottom
 * edge (feathered at the sides), so clouds stand on a flat underside.
 */
function baseTexture(px = 160): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d")!;
  let seed = 777;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 14; k++) {
    const x = px * (0.12 + 0.76 * rnd()), y = px * (0.45 + 0.12 * rnd()), r = px * (0.12 + 0.08 * rnd());
    const grad = g.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, "rgba(250,251,253,0.9)");
    grad.addColorStop(0.8, "rgba(214,220,230,0.8)");
    grad.addColorStop(1, "rgba(200,208,220,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const body = g.createLinearGradient(0, px * 0.55, 0, px * 0.86);
  body.addColorStop(0, "rgba(214,220,230,0.88)");
  body.addColorStop(1, "rgba(178,186,200,0.95)");
  g.fillStyle = body;
  g.fillRect(px * 0.06, px * 0.55, px * 0.88, px * 0.31);
  // Feather left/right and the top; keep the bottom edge crisp (2 px).
  g.globalCompositeOperation = "destination-in";
  const h = g.createLinearGradient(0, 0, px, 0);
  h.addColorStop(0, "rgba(0,0,0,0)");
  h.addColorStop(0.22, "rgba(0,0,0,1)");
  h.addColorStop(0.78, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, px, px * 0.86);
  g.clearRect(0, px * 0.86 + 2, px, px);
  return c;
}

/**
 * Puff textures: cauliflower lumps, each lit from above (white tops, grey undersides) with
 * a defined but soft rim, packed into a rounded blob with a flatter bottom.
 */
function puffTextures(count = 5, px = 160): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < count; t++) {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d")!;
    const lumps: [number, number, number][] = [];
    for (let k = 0; k < 26; k++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.8) * px * 0.26;
      const x = px / 2 + Math.cos(a) * d;
      const y = px * 0.55 + Math.sin(a) * d * 0.7 - (1 - Math.abs(Math.cos(a))) * px * 0.04;
      lumps.push([x, y, px * (0.09 + rnd() * 0.1)]);
    }
    // Bottom lumps first so upper ones overlap them, like a real cumulus face.
    lumps.sort((p, q) => q[1] - p[1]);
    for (const [x, y, r] of lumps) {
      // Light from above: the highlight centre sits high in each lump.
      const grad = g.createRadialGradient(x - r * 0.15, y - r * 0.35, r * 0.1, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.95)");
      grad.addColorStop(0.6, "rgba(246,248,252,0.92)");
      grad.addColorStop(0.88, "rgba(206,214,226,0.7)");
      grad.addColorStop(1, "rgba(190,200,214,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // Feather the outside so no sprite edge ever shows.
    g.globalCompositeOperation = "destination-in";
    const mask = g.createRadialGradient(px / 2, px * 0.52, px * 0.28, px / 2, px * 0.52, px / 2);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = mask;
    g.fillRect(0, 0, px, px);
    out.push(c);
  }
  return out;
}

export class CloudLayer {
  private readonly billboards = new BillboardCollection();
  private readonly slotTex: number[] = [];
  private readonly textures = puffTextures();
  /** Index of the flat-base texture in the sheet (after the puffs). */
  private readonly baseTex = this.textures.length;
  /**
   * All puffs in one sprite sheet, referenced by a data URL: Cesium keeps one atlas entry per
   * URL, and each billboard picks its puff with imageSubRegion. (Per-billboard setImage with a
   * shared id races in Cesium's atlas when hundreds load at once.)
   */
  private readonly sheet = (() => {
    const px = this.textures[0]!.width;
    const c = document.createElement("canvas");
    const tiles = [...this.textures, baseTexture(px)];
    c.width = px * tiles.length;
    c.height = px;
    const g = c.getContext("2d")!;
    tiles.forEach((t, i) => g.drawImage(t, i * px, 0));
    return { url: c.toDataURL("image/png"), px };
  })();
  private clouds: { spec: CloudSpec; puffs: Puff[]; centre: Cartesian3; enu: Matrix4 }[] = [];
  private readonly layouts = new Map<string, { radiusM: number; puffs: Puff[] }>();
  private slots: Billboard[] = [];
  private lastSort = 0;
  /**
   * Every visible puff with its world position, kept between updates by "cloud id:puff
   * index", so a sprite is rewritten only when what it shows changed (Cesium rewrites the
   * vertex data of every billboard touched; rewriting all ~10k twice a second stalled frames).
   */
  private items: { key: string; pos: Cartesian3; size: number; opacity: number; puff: Puff; version: number }[] = [];
  private readonly itemByKey = new Map<string, CloudLayer["items"][number]>();
  private readonly slotItem: (CloudLayer["items"][number] | undefined)[] = [];
  private readonly slotVersion: number[] = [];
  private lookStamp = "";
  private readonly lastCam = new Cartesian3();

  constructor(
    private readonly scene: Scene,
    /** Unit vector towards the sun in local east-north-up (for shading). */
    private readonly sun: { e: number; n: number; u: number },
  ) {
    scene.primitives.add(this.billboards);
    scene.preRender.addEventListener(() => this.sort());
  }

  /** Replace the set of clouds; puff layouts are kept per cloud id. */
  set(specs: CloudSpec[]): void {
    const seen = new Set<string>();
    this.clouds = specs.map((spec) => {
      seen.add(spec.id);
      let l = this.layouts.get(spec.id);
      if (!l || l.radiusM !== spec.radiusM) {
        l = { radiusM: spec.radiusM, puffs: this.layout(spec) };
        this.layouts.set(spec.id, l);
      }
      const centre = Cartesian3.fromDegrees(spec.lonDeg, spec.latDeg, spec.baseM);
      return { spec, puffs: l.puffs, centre, enu: Transforms.eastNorthUpToFixedFrame(centre) };
    });
    for (const id of this.layouts.keys()) if (!seen.has(id)) this.layouts.delete(id);
    const total = this.clouds.reduce((s, c) => s + c.puffs.length, 0);
    while (this.slots.length < total)
      this.slots.push(
        this.billboards.add({
          position: Cartesian3.ZERO,
          image: this.sheet.url,
          imageSubRegion: new BoundingRectangle(0, 0, this.sheet.px, this.sheet.px),
          sizeInMeters: true,
          translucencyByDistance: new NearFarScalar(15_000, 1, 70_000, 0),
          show: false,
        }),
      );
    const next: CloudLayer["items"] = [];
    const local = new Cartesian3();
    for (const c of this.clouds) {
      if (c.spec.size <= 0 || c.spec.opacity <= 0) continue;
      c.puffs.forEach((p, k) => {
        const key = `${c.spec.id}:${k}`;
        Cartesian3.fromElements(p.e * c.spec.size, p.n * c.spec.size, p.u * c.spec.size, local);
        const size = p.sizeM * c.spec.size;
        let it = this.itemByKey.get(key);
        if (!it) {
          it = { key, pos: new Cartesian3(), size: -1, opacity: -1, puff: p, version: 0 };
          this.itemByKey.set(key, it);
        }
        const pos = Matrix4.multiplyByPoint(c.enu, local, new Cartesian3());
        if (it.puff !== p || it.size !== size || it.opacity !== c.spec.opacity || !Cartesian3.equalsEpsilon(it.pos, pos, 0, 0.01)) {
          it.puff = p;
          it.size = size;
          it.opacity = c.spec.opacity;
          Cartesian3.clone(pos, it.pos);
          it.version++;
        }
        next.push(it);
      });
    }
    const live = new Set(next.map((i) => i.key));
    for (const k of this.itemByKey.keys()) if (!live.has(k)) this.itemByKey.delete(k);
    this.items = next;
    this.sort(true);
  }

  /** A cumulus: wide flat base, cauliflower dome above, tallest near the middle. */
  private layout(spec: CloudSpec): Puff[] {
    let seed = 7919;
    for (const ch of spec.id) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
    seed = (seed % 2147483646) + 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const r = spec.radiusM;
    const height = r * (0.55 + 0.45 * rnd());
    const n = Math.round(22 + Math.min(34, r / 22));
    const puffs: Puff[] = [];
    const sun = this.sun;
    for (let k = 0; k < n; k++) {
      // Dome: radius shrinks with height; the base layer is wide and flat.
      const h = Math.pow(rnd(), 1.4); // more puffs low down
      const reach = r * (1 - 0.65 * h) * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      const e = Math.cos(a) * reach, nn = Math.sin(a) * reach * (0.8 + 0.4 * rnd());
      const u = h * height + r * 0.02;
      const sizeM = r * (0.42 + 0.32 * rnd()) * (1 - 0.3 * h);
      // Shading: darker, bluish base; bright tops; brighter on the sun side.
      const len = Math.hypot(e, nn, u - height * 0.4) || 1;
      const sunSide = (e * sun.e + nn * sun.n + (u - height * 0.4) * sun.u) / len;
      const light = Math.min(1, 0.8 + 0.25 * h + 0.12 * sunSide);
      const shade = new Color(light * 0.96, light * 0.97, Math.min(1, light * 1.02 + 0.03), 1);
      puffs.push({ e, n: nn, u, sizeM, shade, tex: Math.floor(rnd() * this.textures.length) });
    }
    // The flat base: wide, low, slightly darker puffs whose centres sit just above the base,
    // drawn first (lowest), so the cloud stands on a broad, level underside.
    const baseCount = Math.round(6 + r / 120);
    for (let k = 0; k < baseCount; k++) {
      const a = (k / baseCount) * Math.PI * 2 + rnd() * 0.5, reach = r * (0.45 + 0.6 * rnd());
      const g = 0.74 + 0.06 * rnd();
      const sizeM = r * (0.55 + 0.2 * rnd());
      // The slab's flat edge is 86 % down the sprite: put it on the cloud base.
      const hM = (sizeM * 2) / 2.2;
      puffs.unshift({ e: Math.cos(a) * reach, n: Math.sin(a) * reach, u: hM * 0.36, sizeM, shade: new Color(g + 0.12, (g + 0.12) * 1.01, Math.min(1, (g + 0.12) * 1.05), 1), tex: this.baseTex, aspect: 2.2 });
    }
    return puffs;
  }

  /**
   * Back-to-front order relative to the camera: re-done at most twice a second and only when
   * the camera has moved 20 m or more (or the clouds changed); a sprite is rewritten only if
   * its puff, or that puff's position, size or opacity, or the light changed.
   */
  private sort(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastSort < 500) return;
    const cam = this.scene.camera.positionWC;
    if (!force && Cartesian3.distanceSquared(cam, this.lastCam) < 400) return;
    this.lastSort = now;
    Cartesian3.clone(cam, this.lastCam);
    const items = this.items;
    const d = new Float64Array(items.length);
    for (let i = 0; i < items.length; i++) d[i] = Cartesian3.distanceSquared(items[i]!.pos, cam);
    const order = Array.from({ length: items.length }, (_, i) => i).sort((a, b) => d[b]! - d[a]!);
    const look = LOOK.cloud.join(",");
    const lookChanged = look !== this.lookStamp;
    this.lookStamp = look;
    for (let i = 0; i < this.slots.length; i++) {
      const b = this.slots[i]!;
      const it = i < order.length ? items[order[i]!] : undefined;
      if (!it) {
        if (this.slotItem[i] !== undefined) b.show = false;
        this.slotItem[i] = undefined;
        continue;
      }
      if (!lookChanged && this.slotItem[i] === it && this.slotVersion[i] === it.version) continue;
      this.slotItem[i] = it;
      this.slotVersion[i] = it.version;
      b.show = true;
      b.position = it.pos;
      if (this.slotTex[i] !== it.puff.tex) {
        b.setImageSubRegion(this.sheet.url, new BoundingRectangle(it.puff.tex * this.sheet.px, 0, this.sheet.px, this.sheet.px));
        this.slotTex[i] = it.puff.tex;
      }
      const aspect = it.puff.aspect ?? 1.25;
      b.width = it.size * 2;
      b.height = (it.size * 2) / aspect;
      // A new value through the setter: changing `b.color` in place is never seen by Cesium
      // (its setter compares against the same object), so the light's tint never reached it.
      const sh = it.puff.shade;
      b.color = new Color(sh.red * LOOK.cloud[0]!, sh.green * LOOK.cloud[1]!, sh.blue * LOOK.cloud[2]!, 0.92 * it.opacity);
    }
  }
}
