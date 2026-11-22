import { describe, expect, it } from "vitest";
import { cloudShadeRamp, cumulusShade, DeckField, deckLight, equalize, type DeckState, type TowerCloud } from "../src/sun-through.ts";

const el = (deg: number, azDeg = 180) => {
  const a = (azDeg * Math.PI) / 180, e = (deg * Math.PI) / 180;
  return { e: Math.sin(a) * Math.cos(e), n: Math.cos(a) * Math.cos(e), u: Math.sin(e) };
};
/** One tower, 300 m round, its centre 400 m over the base. */
const cloud = (e: number, n: number, u: number, opacity = 1): TowerCloud => ({ e, n, u, towers: new Float32Array([0, 0, 400, 300]), opacity });

describe("the sun through a cumulus", () => {
  it("shades a point whose ray to the sun passes under the tower, as its shadow on the ground", () => {
    // Sun due south at 45°: the shadow of a tower 1000 m up (base 600 + 400) falls 1000 m north.
    const sun = el(45);
    expect(cumulusShade([cloud(0, -1000, 600)], sun)).toBeCloseTo(1, 6);
    expect(cumulusShade([cloud(0, 1000, 600)], sun)).toBe(0);
    // Its soft rim: full to 55 % of the radius (×1.05), fading to nothing at it.
    const r = 300 * 1.05;
    expect(cumulusShade([cloud(0.7 * r, -1000, 600)], sun)).toBeCloseTo(1 - (0.7 - 0.55) / 0.45, 5);
    expect(cumulusShade([cloud(r + 1, -1000, 600)], sun)).toBe(0);
    // As faint as the cloud; overlapping, the darker.
    expect(cumulusShade([cloud(0, -1000, 600, 0.4)], sun)).toBeCloseTo(0.4, 6);
    expect(cumulusShade([cloud(0, -1000, 600, 0.4), cloud(0, -1000, 600, 0.7)], sun)).toBeCloseTo(0.7, 6);
  });

  it("does not shade from below, and shades inside the cloud", () => {
    const sun = el(45);
    // The glider over the tower (its centre 500 m below, its top 185 m below): no shade from it.
    expect(cumulusShade([cloud(0, 0, -900)], sun)).toBe(0);
    // In it: 100 m from the centre of a 300 m tower.
    expect(cumulusShade([cloud(0, 100, -400)], sun)).toBeCloseTo(1, 6);
  });
});

describe("the sun through the decks", () => {
  const flat = (v: number, size = 16) => new Uint8Array(size * size * 4).fill(v);

  it("samples the field like the GPU: repeating, mip levels the mean of four", () => {
    const size = 4, rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) rgba[4 * i] = i % 2 ? 255 : 0;
    const f = new DeckField(rgba, size);
    // Texel centres at (i + 0.5) / size.
    expect(f.sample(0.125, 0.125, 0)[0]).toBeCloseTo(0, 6);
    expect(f.sample(0.375, 0.125, 0)[0]).toBeCloseTo(1, 6);
    // Halfway between, and across the edge (repeat): the mean.
    expect(f.sample(0.25, 0.125, 0)[0]).toBeCloseTo(0.5, 6);
    expect(f.sample(1, 0.125, 0)[0]).toBeCloseTo(0.5, 6);
    // Level 1 and beyond: all 0.5; between levels, linear.
    expect(f.sample(0.125, 0.125, 1)[0]).toBeCloseTo(0.5, 6);
    expect(f.sample(0.125, 0.125, 0.5)[0]).toBeCloseTo(0.25, 6);
    expect(f.sample(0.3, 0.7, 9)[0]).toBeCloseTo(0.5, 6);
  });

  it("passes the two-stream share through a full deck, nothing taken by one below", () => {
    const f = new DeckField(flat(128), 16);
    const sun = el(30), mu = 0.5;
    const d: DeckState = { decks: [{ x: 1500, y: 2000, z: 1, w: 0 }, { x: 0, y: 0, z: 0, w: 0 }], at: [{ x: 0, y: 0, z: 0.01 }, { x: 0, y: 0, z: 0 }], camH: 800, n: 1 };
    const tau = 0.01 * 0.75 * 500;
    expect(deckLight(f, d, { e: 0, n: 0, u: 0 }, sun)).toBeCloseTo(1 / (1 + (0.1125 * tau) / (0.5 + 0.75 * mu)), 6);
    // Above its middle: none of its shade.
    expect(deckLight(f, d, { e: 0, n: 0, u: 1000 }, sun)).toBe(1);
  });

  it("lets the sun through the holes of a broken deck", () => {
    // The field all 0 (a hole everywhere at 60 % cover: the smoothstep starts at 0.4).
    const f = new DeckField(flat(0), 16);
    const d: DeckState = { decks: [{ x: 1500, y: 2000, z: 0.6, w: 0 }], at: [{ x: 0, y: 0, z: 0.05 }], camH: 800, n: 1 };
    expect(deckLight(f, d, { e: 0, n: 0, u: 0 }, el(30))).toBe(1);
    expect(equalize(0)).toBe(0);
    expect(equalize(0.5)).toBeCloseTo(0.5, 6);
    expect(equalize(1)).toBe(1);
  });

  it("takes the clouds' share of the light by the sun's height, as on the ground", () => {
    expect(cloudShadeRamp(30)).toBe(1);
    expect(cloudShadeRamp(7)).toBeCloseTo(0.5, 6);
    expect(cloudShadeRamp(0)).toBe(0);
  });
});
