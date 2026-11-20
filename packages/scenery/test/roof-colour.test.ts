import { describe, expect, it } from "vitest";
import { footprintColour, type Rgba } from "../src/roof-colour.ts";

/** A grey street with a red roof (x 10–20, y 10–18), a dark shadow strip along its south edge and a chimney. */
function scene(): Rgba {
  const w = 40, h = 30, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = [120, 120, 118];
      if (x >= 10 && x < 20 && y >= 10 && y < 18) c = [150, 80, 60];
      if (x >= 10 && x < 20 && y >= 18 && y < 20) c = [30, 30, 32]; // shadow beside it
      if (x === 14 && y === 13) c = [250, 250, 250]; // chimney cap
      data.set([c[0]!, c[1]!, c[2]!, 255], i);
    }
  return { w, h, data };
}
const roof: [number, number][] = [[10, 10], [20, 10], [20, 18], [10, 18], [10, 10]];

describe("footprintColour", () => {
  it("averages the roof, not the street, the shadow or the chimney", () => {
    const c = footprintColour(scene(), roof, 1)!;
    expect(c[0]).toBeCloseTo(150, 0);
    expect(c[1]).toBeCloseTo(80, 0);
    expect(c[2]).toBeCloseTo(60, 0);
  });

  it("stays on the roof when the outline is a pixel off", () => {
    const off = roof.map(([x, y]) => [x + 0.8, y + 0.9] as [number, number]);
    const c = footprintColour(scene(), off, 1.2)!;
    expect(Math.abs(c[0] - 150)).toBeLessThan(6);
    expect(Math.abs(c[1] - 80)).toBeLessThan(6);
  });

  it("takes the innermost pixels of a roof too small to keep clear of its outline", () => {
    const small: [number, number][] = [[12, 12], [14, 12], [14, 14], [12, 14], [12, 12]];
    expect(footprintColour(scene(), small, 3)![0]).toBeCloseTo(150, 0);
  });

  it("leaves out a tree over part of the roof", () => {
    const img = scene();
    for (let y = 11; y < 14; y++) for (let x = 11; x < 15; x++) img.data.set([60, 95, 50, 255], (y * img.w + x) * 4);
    const c = footprintColour(img, roof, 1)!;
    expect(c[0]).toBeCloseTo(150, 0);
    expect(c[1]).toBeCloseTo(80, 0);
  });

  it("gives nothing for a roof mostly under trees", () => {
    const img = scene();
    for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) img.data.set([60, 95, 50, 255], (y * img.w + x) * 4);
    expect(footprintColour(img, roof, 1)).toBeUndefined();
  });

  it("keeps olive-brown roofs (red above green)", () => {
    const img = scene();
    for (let y = 10; y < 18; y++) for (let x = 10; x < 20; x++) img.data.set([98, 90, 62, 255], (y * img.w + x) * 4);
    expect(footprintColour(img, roof, 1)![0]).toBeCloseTo(98, 0);
  });

  it("gives nothing off the image or without a pixel centre inside", () => {
    expect(footprintColour(scene(), [[38, 5], [42, 5], [42, 8], [38, 8], [38, 5]], 1)).toBeUndefined();
    expect(footprintColour(scene(), [[5.6, 5.6], [5.9, 5.6], [5.9, 5.9], [5.6, 5.6]], 1)).toBeUndefined();
  });
});
