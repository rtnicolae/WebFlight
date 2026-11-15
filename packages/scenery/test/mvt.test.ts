import { describe, expect, it } from "vitest";
import { decodeMvt, waterFromTile } from "../src/index.ts";

// A tiny protobuf writer for test tiles.
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const field = (num: number, wire: number) => varint((num << 3) | wire);
const bytes = (num: number, b: number[]) => [...field(num, 2), ...varint(b.length), ...b];
const str = (num: number, s: string) => bytes(num, [...new TextEncoder().encode(s)]);
const packed = (num: number, xs: number[]) => bytes(num, xs.flatMap(varint));
const zz = (n: number) => (n << 1) ^ (n >> 31);
const cmd = (id: number, count: number) => (count << 3) | id;

/** Polygon ring from absolute tile coordinates → MVT geometry commands. */
function ring(points: [number, number][], cursor: [number, number]): number[] {
  const out = [cmd(1, 1), zz(points[0]![0] - cursor[0]), zz(points[0]![1] - cursor[1]), cmd(2, points.length - 1)];
  let [x, y] = points[0]!;
  for (const p of points.slice(1)) {
    out.push(zz(p[0] - x), zz(p[1] - y));
    [x, y] = p;
  }
  out.push(cmd(7, 1));
  cursor[0] = x;
  cursor[1] = y;
  return out;
}

function tile(): Uint8Array {
  const cur: [number, number] = [0, 0];
  // Exterior clockwise in screen space (positive area, y down), hole counter-clockwise.
  const outer = ring([[100, 100], [3000, 100], [3000, 3000], [100, 3000]], cur);
  const hole = ring([[1000, 1000], [1000, 2000], [2000, 2000], [2000, 1000]], cur);
  const feature = [...field(1, 0), ...varint(7), ...packed(2, [0, 0]), ...field(3, 0), ...varint(3), ...packed(4, [...outer, ...hole])];
  const value = str(1, "lake");
  const layer = [...field(15, 0), ...varint(2), ...str(1, "water"), ...bytes(2, feature), ...str(3, "class"), ...bytes(4, value), ...field(5, 0), ...varint(4096)];
  return new Uint8Array(bytes(3, layer));
}

describe("MVT decoding", () => {
  it("decodes layers, tags and polygon rings", () => {
    const [l] = decodeMvt(tile());
    expect(l!.name).toBe("water");
    expect(l!.extent).toBe(4096);
    const f = l!.features[0]!;
    expect(f.id).toBe(7);
    expect(f.type).toBe(3);
    expect(f.properties).toEqual({ class: "lake" });
    expect(f.geometry).toHaveLength(2);
    expect(f.geometry[0]![0]).toEqual([100, 100]);
    expect(f.geometry[1]![2]).toEqual([2000, 2000]);
    expect(f.geometry[0]!.at(-1)).toEqual([100, 100]); // closed
  });

  it("assembles water polygons with holes in degrees", () => {
    const [p] = waterFromTile(tile(), 1, 1, 0); // tile (1, 0) at z1: lon 0..180, lat 0..85
    expect(p!.kind).toBe("lake");
    expect(p!.rings).toHaveLength(2);
    const [lon, lat] = p!.rings[0]![0]!;
    expect(lon).toBeCloseTo((100 / 4096) * 180, 6);
    expect(lat).toBeGreaterThan(80);
  });
});
