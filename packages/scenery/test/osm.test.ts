import { describe, expect, it } from "vitest";
import { buildingMesh, footprintRect, LocalFrame, treeMesh, type OsmPolygon } from "../src/index.ts";

const LAT = 45.7, LON = 25.5;
const frame = new LocalFrame(LON, LAT, 500);
/** A rectangle w×h metres (east × north) at offset (e, n), as a closed lon/lat ring, clockwise (as MVT exteriors arrive). */
function rect(e: number, n: number, w: number, h: number): [number, number][] {
  const p = (x: number, y: number) => frame.lonLat(x, y);
  return [p(e, n), p(e, n + h), p(e + w, n + h), p(e + w, n), p(e, n)];
}
const ground = () => 520;

describe("osm buildings", () => {
  it("fits the minimum rectangle of a rotated footprint", () => {
    const a = 0.4, c = Math.cos(a), s = Math.sin(a);
    const pts: [number, number][] = [[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]].map(([x, y]) => [x! * c - y! * s, x! * s + y! * c]);
    const r = footprintRect(pts);
    expect(r.long).toBeCloseTo(12, 5);
    expect(r.short).toBeCloseTo(8, 5);
    expect(r.fill).toBeCloseTo(1, 5);
  });

  it("extrudes a house with walls on the ground and a pitched roof above them", () => {
    const house: OsmPolygon = { rings: [rect(10, 10, 12, 8)], properties: { render_height: 5, render_min_height: 0 } };
    const m = buildingMesh([house], frame, ground);
    const z = Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[3 * i + 2]!);
    // Local up at ~20 m from the origin: 520 − 500 m, minus a negligible curvature drop.
    expect(Math.min(...z)).toBeCloseTo(19, 1); // 1 m below ground
    expect(Math.max(...z)).toBeGreaterThan(25 + 2); // ridge above the 5 m walls
    expect(Math.max(...z)).toBeLessThan(25 + 6.1);
    expect(m.indices.length % 3).toBe(0);
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
    // Wall normals are horizontal and point away from the footprint's centre.
    for (let i = 0; i < 16; i++) {
      const nx = m.normals[3 * i]!, ny = m.normals[3 * i + 1]!, nz = m.normals[3 * i + 2]!;
      expect(nz).toBe(0);
      const px = m.positions[3 * i]! - 16, py = m.positions[3 * i + 1]! - 14;
      expect(nx * px + ny * py).toBeGreaterThan(0);
    }
  });

  it("gives large or irregular buildings a flat roof with courtyards left open", () => {
    const block: OsmPolygon = { rings: [rect(0, 0, 60, 60), rect(20, 20, 20, 20).reverse()], properties: { render_height: 18 } };
    const m = buildingMesh([block], frame, ground);
    const n = m.positions.length / 3;
    let roofArea = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!].map((i) => [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!]);
      if (a![2]! > 30 && b![2]! > 30 && c![2]! > 30) roofArea += Math.abs((b![0]! - a![0]!) * (c![1]! - a![1]!) - (c![0]! - a![0]!) * (b![1]! - a![1]!)) / 2;
    }
    expect(n).toBeGreaterThan(0);
    expect(roofArea).toBeCloseTo(3600 - 400, -1);
  });
});

describe("osm trees", () => {
  it("scatters trees inside forests only, stably", () => {
    const wood: OsmPolygon = { rings: [rect(0, 0, 200, 100)], properties: { class: "wood" } };
    const a = treeMesh([wood], frame, ground, { spacingM: 10 });
    const b = treeMesh([wood], frame, ground, { spacingM: 10 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    const trees = a.positions.length / 3 / 30; // 5 tiers × 6 vertices
    expect(trees).toBeGreaterThan(150);
    expect(trees).toBeLessThan(230);
    for (let i = 0; i < a.positions.length / 3; i++) {
      expect(a.positions[3 * i]!).toBeGreaterThan(-12);
      expect(a.positions[3 * i]!).toBeLessThan(212);
    }
    // A bounds square keeps only its share.
    const half = treeMesh([wood], frame, ground, { spacingM: 10, bounds: { e0: 0, n0: 0, e1: 100, n1: 100 } });
    expect(half.positions.length / 3 / 30).toBeCloseTo(trees / 2, -1);
  });
});

import { treeInstances } from "../src/index.ts";
describe("tree instances (impostors)", () => {
  it("places trees inside forests with heights and kinds, stably", () => {
    const wood: OsmPolygon = { rings: [rect(0, 0, 200, 100)], properties: { class: "wood" } };
    const a = treeInstances([wood], frame, ground, { spacingM: 10 });
    expect(Array.from(a)).toEqual(Array.from(treeInstances([wood], frame, ground, { spacingM: 10 })));
    const n = a.length / 5;
    expect(n).toBeGreaterThan(150);
    for (let i = 0; i < n; i++) {
      expect(a[i * 5]!).toBeGreaterThan(-12);
      expect(a[i * 5]!).toBeLessThan(212);
      expect(a[i * 5 + 3]!).toBeGreaterThan(10);
      expect(Math.floor(a[i * 5 + 4]!)).toBeLessThanOrEqual(1);
    }
  });
});

import { townTreeInstances, type OsmTile } from "../src/index.ts";
describe("town trees", () => {
  it("stand in residential land, clear of buildings and roads", () => {
    const tile: OsmTile = {
      buildings: [{ rings: [rect(40, 40, 30, 30)], properties: {} }],
      forests: [],
      greens: [{ rings: [rect(0, 0, 200, 200)], properties: { kind: "residential" } }],
      roads: [{ pts: [frame.lonLat(0, 120), frame.lonLat(200, 120)], halfM: 3.5 }],
    };
    const a = townTreeInstances(tile, frame, ground, { e0: 0, n0: 0, e1: 200, n1: 200 });
    const n = a.length / 5;
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(110);
    for (let i = 0; i < n; i++) {
      const x = a[i * 5]!, y = a[i * 5 + 1]!;
      expect(x > 37.5 && x < 72.5 && y > 37.5 && y < 72.5).toBe(false);
      expect(Math.abs(y - 120)).toBeGreaterThan(4.4);
      expect(a[i * 5 + 3]!).toBeLessThan(13);
    }
    expect(Array.from(townTreeInstances(tile, frame, ground, { e0: 0, n0: 0, e1: 200, n1: 200 }))).toEqual(Array.from(a));
  });
});
