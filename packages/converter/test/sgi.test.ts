import { describe, expect, it } from "vitest";
import { decodeSgi, encodePng } from "../src/sgi.ts";
import { pngTransparency } from "../src/png-alpha.ts";

/** A 2×2 RGBA SGI image, RLE: bottom row red/green, top row blue/transparent. */
function sgiRle(): Uint8Array {
  const w = 2, h = 2, zs = 4;
  const rows = [
    [[255, 0], [0, 255], [0, 0], [255, 255]], // y=0 (bottom): R, G, B, A per channel z
    [[0, 0], [0, 0], [255, 0], [255, 0]], // y=1 (top)
  ];
  const head = Buffer.alloc(512);
  head.writeUInt16BE(474, 0);
  head[2] = 1;
  head[3] = 1;
  head.writeUInt16BE(3, 4);
  head.writeUInt16BE(w, 6);
  head.writeUInt16BE(h, 8);
  head.writeUInt16BE(zs, 10);
  const tables = Buffer.alloc(h * zs * 8);
  const data: number[] = [];
  const base = 512 + tables.length;
  for (let z = 0; z < zs; z++)
    for (let y = 0; y < h; y++) {
      const off = base + data.length;
      const v = rows[y]![z]!;
      data.push(0x80 | w, ...v, 0); // literal run of 2, then end
      tables.writeUInt32BE(off, (z * h + y) * 4);
      tables.writeUInt32BE(4, h * zs * 4 + (z * h + y) * 4);
    }
  return new Uint8Array(Buffer.concat([head, tables, Buffer.from(data)]));
}

describe("SGI textures", () => {
  it("decodes RLE planes bottom-up into a top-down RGBA image and re-encodes as PNG", () => {
    const img = decodeSgi(sgiRle());
    expect([img.width, img.height, img.channels]).toEqual([2, 2, 4]);
    // Top row first: blue opaque, then transparent black.
    expect([...img.pixels.slice(0, 8)]).toEqual([0, 0, 255, 255, 0, 0, 0, 0]);
    // Bottom row: red opaque, green opaque.
    expect([...img.pixels.slice(8)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    const png = encodePng(img);
    expect(pngTransparency(png)).toEqual({ transparent: 1, total: 4 });
  });
});
