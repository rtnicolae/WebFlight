/**
 * SGI image files (.rgb/.rgba/.bw/.sgi, used by many FlightGear models) → PNG, for glTF.
 * Format: 512-byte header (magic 474, storage 0 = verbatim / 1 = RLE, bytes per channel,
 * xsize, ysize, zsize), channels stored planar, scanlines bottom to top. 8-bit only (FG's
 * textures are); 16-bit channels are reduced to their high byte.
 */
import zlib from "node:zlib";

export interface Image8 {
  width: number;
  height: number;
  /** 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA */
  channels: number;
  /** Top row first, interleaved. */
  pixels: Uint8Array;
}

export function decodeSgi(data: Uint8Array): Image8 {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.readUInt16BE(0) !== 474) throw new Error("not an SGI image");
  const rle = b[2] === 1, bpc = b[3]!;
  const w = b.readUInt16BE(6), h = b.readUInt16BE(8), zs = Math.max(1, Math.min(4, b.readUInt16BE(10)));
  const px = new Uint8Array(w * h * zs);
  const put = (row: number, z: number, x: number, v: number) => {
    px[((h - 1 - row) * w + x) * zs + z] = v;
  };
  if (!rle) {
    let o = 512;
    for (let z = 0; z < zs; z++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++, o += bpc) put(y, z, x, b[o]!);
  } else {
    const n = h * zs;
    for (let z = 0; z < zs; z++) {
      for (let y = 0; y < h; y++) {
        let o = b.readUInt32BE(512 + (z * h + y) * 4);
        let x = 0;
        for (;;) {
          const c = bpc === 2 ? b.readUInt16BE(o) & 0xff : b[o]!;
          o += bpc;
          const count = c & 0x7f;
          if (!count) break;
          if (c & 0x80) for (let i = 0; i < count && x < w; i++, o += bpc) put(y, z, x++, b[o]!);
          else {
            const v = b[o]!;
            o += bpc;
            for (let i = 0; i < count && x < w; i++) put(y, z, x++, v);
          }
        }
      }
    }
    void n;
  }
  return { width: w, height: h, channels: zs, pixels: px };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: Image8): Uint8Array {
  const { width: w, height: h, channels: ch, pixels } = img;
  const colorType = ch === 1 ? 0 : ch === 2 ? 4 : ch === 3 ? 2 : 6;
  const raw = Buffer.alloc(h * (w * ch + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * ch, w * ch).copy(raw, y * (w * ch + 1) + 1);
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
