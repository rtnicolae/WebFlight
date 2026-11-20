import { describe, expect, it } from "vitest";
import { decodePng, encodePng, upscale2x, type Rgba } from "../src/png.ts";

const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};

describe("png", () => {
  it("round-trips RGBA and RGB", () => {
    const a = img(17, 9, (x, y) => [x * 13, y * 27, (x * y) & 255, 255 - x]);
    expect(decodePng(encodePng(a))).toEqual(a);
    const rgb = decodePng(encodePng(a, { rgb: true }));
    expect(rgb.data[4 * 5]).toBe(a.data[4 * 5]);
    expect(rgb.data[4 * 5 + 3]).toBe(255);
  });

  it("doubles the size, keeping flat areas flat and edges in place", () => {
    const a = img(8, 8, (x) => (x < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const b = upscale2x(a);
    expect(b.width).toBe(16);
    expect(b.data[(5 * 16 + 1) * 4]).toBe(255); // well inside the white half
    expect(b.data[(5 * 16 + 14) * 4]).toBe(0); // well inside the black half
    expect(b.data[(5 * 16 + 7) * 4]).toBeGreaterThan(b.data[(5 * 16 + 8) * 4]!); // the edge between 7 and 8
  });
});
