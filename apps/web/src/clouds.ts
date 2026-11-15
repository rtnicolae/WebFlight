/**
 * Cumulus clouds from soft sprite puffs (the classic flight-simulator technique): each cloud
 * is a cluster of camera-facing puffs filling a dome with a flat base at the cloud base. Puffs
 * are shaded by height (grey-blue base, white tops) and by the sun direction, sorted back to
 * front for clean blending, and fade with distance into the haze.
 */
import { BillboardCollection, Cartesian3, Color, NearFarScalar, Transforms, Matrix4, type Billboard, type Scene } from "cesium";

export interface CloudSpec {
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
  private clouds: { spec: CloudSpec; puffs: Puff[]; centre: Cartesian3; enu: Matrix4 }[] = [];
  private slots: Billboard[] = [];
  private lastSort = 0;

  constructor(
    private readonly scene: Scene,
    /** Unit vector towards the sun in local east-north-up (for shading). */
    private readonly sun: { e: number; n: number; u: number },
  ) {
    scene.primitives.add(this.billboards);
    scene.preRender.addEventListener(() => this.sort());
  }

  /** Replace the set of clouds (positions/sizes); puff layouts are kept per index. */
  set(specs: CloudSpec[]): void {
    this.clouds = specs.map((spec, i) => {
      const prev = this.clouds[i];
      const centre = Cartesian3.fromDegrees(spec.lonDeg, spec.latDeg, spec.baseM);
      const puffs = prev && prev.spec.radiusM === spec.radiusM ? prev.puffs : this.layout(spec, i);
      return { spec, puffs, centre, enu: Transforms.eastNorthUpToFixedFrame(centre) };
    });
    const total = this.clouds.reduce((s, c) => s + c.puffs.length, 0);
    while (this.slots.length < total)
      this.slots.push(
        this.billboards.add({
          position: Cartesian3.ZERO,
          image: this.textures[0] as unknown as string,
          sizeInMeters: true,
          translucencyByDistance: new NearFarScalar(15_000, 1, 70_000, 0),
          show: false,
        }),
      );
    this.lastSort = 0;
    this.sort(true);
  }

  /** A cumulus: wide flat base, cauliflower dome above, tallest near the middle. */
  private layout(spec: CloudSpec, index: number): Puff[] {
    let seed = (index + 1) * 7919;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const r = spec.radiusM;
    const height = r * (0.7 + 0.5 * rnd());
    const n = Math.round(30 + Math.min(60, r / 14));
    const puffs: Puff[] = [];
    const sun = this.sun;
    for (let k = 0; k < n; k++) {
      // Dome: radius shrinks with height; the base layer is wide and flat.
      const h = Math.pow(rnd(), 1.4); // more puffs low down
      const reach = r * (1 - 0.65 * h) * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      const e = Math.cos(a) * reach, nn = Math.sin(a) * reach * (0.8 + 0.4 * rnd());
      const u = h * height + r * 0.18;
      const sizeM = r * (0.36 + 0.3 * rnd()) * (1 - 0.3 * h);
      // Shading: darker, bluish base; bright tops; brighter on the sun side.
      const len = Math.hypot(e, nn, u - height * 0.4) || 1;
      const sunSide = (e * sun.e + nn * sun.n + (u - height * 0.4) * sun.u) / len;
      const light = Math.min(1, 0.8 + 0.25 * h + 0.12 * sunSide);
      const shade = new Color(light * 0.96, light * 0.97, Math.min(1, light * 1.02 + 0.03), 1);
      puffs.push({ e, n: nn, u, sizeM, shade, tex: Math.floor(rnd() * this.textures.length) });
    }
    return puffs;
  }

  /** Back-to-front order relative to the camera (re-done at most twice a second). */
  private sort(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastSort < 500) return;
    this.lastSort = now;
    const cam = this.scene.camera.positionWC;
    const items: { pos: Cartesian3; d: number; puff: Puff; size: number; opacity: number }[] = [];
    for (const c of this.clouds) {
      if (c.spec.size <= 0 || c.spec.opacity <= 0) continue;
      for (const p of c.puffs) {
        const local = new Cartesian3(p.e * c.spec.size, p.n * c.spec.size, p.u * c.spec.size);
        const pos = Matrix4.multiplyByPoint(c.enu, local, new Cartesian3());
        items.push({ pos, d: Cartesian3.distanceSquared(pos, cam), puff: p, size: p.sizeM * c.spec.size, opacity: c.spec.opacity });
      }
    }
    items.sort((a, b) => b.d - a.d);
    for (let i = 0; i < this.slots.length; i++) {
      const b = this.slots[i]!;
      const it = items[i];
      if (!it) {
        b.show = false;
        continue;
      }
      b.show = true;
      b.position = it.pos;
      if (this.slotTex[i] !== it.puff.tex) {
        // Stable ids: the atlas keeps one copy of each puff texture.
        b.setImage(`puff-${it.puff.tex}`, this.textures[it.puff.tex] as unknown as string);
        this.slotTex[i] = it.puff.tex;
      }
      b.width = it.size * 2;
      b.height = it.size * 1.6;
      b.color = Color.fromAlpha(it.puff.shade, 0.92 * it.opacity, b.color);
    }
  }
}
