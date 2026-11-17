import { describe, expect, it } from "vitest";
import { photoOffset, rng, type AlignFootprint, type Gray } from "../src/index.ts";

const inside = (ring: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

function fill(img: Gray, ring: [number, number][], v: number) {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) if (inside(ring, x + 0.5, y + 0.5)) img.data[y * img.w + x] = v;
}

/**
 * A village photo at 0.4 m pixels: grass-like noise, houses whose roofs show at the footprint
 * moved by (dx, dy), and long, sharp shadows (a decoy: their outlines are the strongest edges).
 */
function village(dx: number, dy: number, seed = 7): { img: Gray; fps: AlignFootprint[] } {
  const r = rng(seed);
  const img: Gray = { w: 700, h: 700, data: new Float32Array(700 * 700) };
  for (let i = 0; i < img.data.length; i++) img.data[i] = 90 + 30 * r();
  const fps: AlignFootprint[] = [];
  for (let gy = 0; gy < 7; gy++)
    for (let gx = 0; gx < 7; gx++) {
      const cx = 90 + gx * 85 + 10 * r(), cy = 90 + gy * 85 + 10 * r();
      const w = 20 + 15 * r(), h = 15 + 10 * r(), a = r() * Math.PI;
      const c = Math.cos(a), s = Math.sin(a);
      const ring = ([[-w, -h], [w, -h], [w, h], [-w, h]] as const).map(([x, y]) => [cx + (x * c - y * s) / 2, cy + (x * s + y * c) / 2] as [number, number]);
      fps.push({ ring, heightM: 5 });
      fill(img, ring.map(([x, y]) => [x + dx + 14, y + dy + 10]), 30); // shadow
      fill(img, ring.map(([x, y]) => [x + dx, y + dy]), 150 + 60 * r()); // roof
    }
  return { img, fps };
}

describe("photo alignment", () => {
  it("finds how far the roofs sit from the footprints, not their shadows", () => {
    const { img, fps } = village(-6.2, 9.7);
    const o = photoOffset(img, fps, 0.4);
    expect(o).toBeDefined();
    expect(o!.buildings).toBe(49);
    expect(o!.dx).toBeCloseTo(-6.2, 0);
    expect(o!.dy).toBeCloseTo(9.7, 0);
  });

  it("finds no displacement when the photo matches the map", () => {
    const { img, fps } = village(0, 0, 3);
    const o = photoOffset(img, fps, 0.4)!;
    expect(Math.hypot(o.dx, o.dy)).toBeLessThan(0.6);
  });

  it("gives no answer when the photo shows nothing of the buildings", () => {
    const { fps } = village(0, 0);
    const r = rng(11);
    const noise: Gray = { w: 700, h: 700, data: new Float32Array(700 * 700).map(() => 90 + 30 * r()) };
    expect(photoOffset(noise, fps, 0.4)).toBeUndefined();
  });

  it("ignores tall buildings (their roofs lean further) and too few houses", () => {
    const { img, fps } = village(3, 3);
    expect(photoOffset(img, fps.map((f) => ({ ...f, heightM: 20 })), 0.4)).toBeUndefined();
    expect(photoOffset(img, fps.slice(0, 10), 0.4)).toBeUndefined();
  });
});
