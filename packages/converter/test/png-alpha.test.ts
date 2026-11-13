import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngTransparency } from "../src/png-alpha.ts";

/** Minimal RGBA PNG (CRCs are not checked by the reader). */
function rgbaPng(width: number, rows: number[][]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Filter type 1 (Sub) on the second row to exercise unfiltering.
  const raw = Buffer.concat(rows.map((r, y) => {
    if (y === 0) return Buffer.from([0, ...r]);
    const sub = r.map((v, i) => (i >= 4 ? (v - r[i - 4]! + 256) & 0xff : v));
    return Buffer.from([1, ...sub]);
  }));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("pngTransparency", () => {
  it("counts transparent pixels through scanline filters", () => {
    const png = rgbaPng(2, [[255, 0, 0, 255, 0, 0, 0, 0], [10, 10, 10, 255, 20, 20, 20, 255]]);
    expect(pngTransparency(png)).toEqual({ transparent: 1, total: 4 });
  });
});
