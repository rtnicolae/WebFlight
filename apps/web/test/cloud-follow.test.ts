import { describe, expect, it } from "vitest";
import { DISSOLVE_S, DrawnClouds, FOLLOW_S, GROW_S, type CloudTarget } from "../src/cloud-follow.ts";
import type { CloudSpec } from "../src/clouds.ts";

const cloud = (o: Partial<CloudSpec> = {}): CloudSpec => ({ id: "1:2:0", latDeg: 45.65, lonDeg: 25.5, baseM: 2300, radiusM: 800, size: 1, opacity: 1, groundM: 530, tall: 1, ...o });
const at = (c: CloudSpec, dying = false): CloudTarget[] => [{ c, dying }];
/** Run for `s` seconds in 1 s steps; the clouds drawn at the end. */
const run = (d: DrawnClouds, t: CloudTarget[], s: number) => {
  let out: CloudSpec[] = [];
  for (let i = 0; i < s; i++) out = d.update(t, 1, false);
  return out;
};

describe("clouds as drawn follow their thermals' gradually", () => {
  it("draws the sky as it is while it is being made", () => {
    const d = new DrawnClouds();
    expect(d.update(at(cloud()), 0, true)).toEqual([cloud()]);
  });

  it("grows a new cloud in instead of showing it at once, and none for a thermal met dying", () => {
    const d = new DrawnClouds();
    d.update([], 0, true);
    expect(d.update(at(cloud()), 1, false)).toEqual([]); // from nothing
    let out = run(d, at(cloud()), 45);
    expect(out[0]!.opacity).toBeCloseTo(45 / GROW_S, 6);
    out = run(d, at(cloud()), 120);
    expect(out[0]!.opacity).toBe(1);
    expect(out[0]!.size).toBe(1);
    // A thermal first seen dying (a full cloud fading by its cycle) gets no cloud...
    const e = new DrawnClouds();
    e.update([], 0, true);
    expect(run(e, at(cloud({ opacity: 0.8 }), true), 30)).toEqual([]);
    // ... until it is reborn.
    expect(run(e, at(cloud()), 30)[0]!.opacity).toBeCloseTo(30 / GROW_S, 6);
  });

  it("glides to a thermal's new lean and top rather than stepping", () => {
    const d = new DrawnClouds();
    d.update(at(cloud()), 0, true);
    // The weather moved on: the column leans 60 m further east, its top 40 m higher.
    const next = cloud({ lonDeg: 25.5 + 60 / (111_195 * Math.cos((45.65 * Math.PI) / 180)), baseM: 2340 });
    const out = run(d, at(next), 1)[0]!;
    const k = 1 - Math.exp(-1 / FOLLOW_S);
    expect(out.baseM).toBeCloseTo(2300 + 40 * k, 6);
    expect(out.lonDeg - 25.5).toBeCloseTo((next.lonDeg - 25.5) * k, 9);
    expect(run(d, at(next), 120)[0]!.baseM).toBeCloseTo(2340, 0); // e^-6 of the 40 m left
  });

  it("dissolves a cloud whose thermal is placed elsewhere and grows the new one there", () => {
    const d = new DrawnClouds();
    d.update(at(cloud()), 0, true);
    // The flight model's copy of the thermal, 2 km off the far sky's.
    const there = cloud({ latDeg: 45.65 + 2000 / 111_195 });
    let out = d.update(at(there), 1, false);
    expect(out).toHaveLength(1);
    expect(out[0]!.latDeg).toBe(45.65); // the old one, where it was
    expect(out[0]!.opacity).toBeCloseTo(1 - 1 / DISSOLVE_S, 6);
    out = run(d, at(there), 60);
    const old = out.find((c) => c.latDeg === 45.65)!, fresh = out.find((c) => c.latDeg !== 45.65)!;
    expect(old.opacity).toBeCloseTo(1 - 61 / DISSOLVE_S, 6);
    expect(fresh.latDeg).toBeCloseTo(there.latDeg, 9);
    expect(fresh.opacity).toBeCloseTo(60 / GROW_S, 6);
    expect(fresh.id).not.toBe(old.id); // each its own shape
    out = run(d, at(there), 120);
    expect(out).toHaveLength(1);
    expect(out[0]!.opacity).toBe(1);
  });

  it("dissolves a cloud gone from the thermals, and drops it once gone", () => {
    const d = new DrawnClouds();
    d.update(at(cloud()), 0, true);
    expect(run(d, [], 60)[0]!.opacity).toBeCloseTo(1 - 60 / DISSOLVE_S, 6);
    expect(run(d, [], 61)).toEqual([]);
    expect(d.size).toBe(0);
  });

  it("leaves a thermal's own cycle as it is: a cumulus dying over five minutes", () => {
    const d = new DrawnClouds();
    d.update(at(cloud()), 0, true);
    let out: CloudSpec[] = [];
    for (let s = 1; s <= 300; s++) {
      const f = s / 300, c = cloud({ size: 1 - 0.4 * f, opacity: 1 - f });
      out = d.update(at(c, true), 1, false);
      if (s < 300) {
        expect(out[0]!.opacity).toBeCloseTo(c.opacity, 9);
        expect(out[0]!.size).toBeCloseTo(c.size, 9);
      }
    }
    expect(out).toEqual([]);
  });
});
