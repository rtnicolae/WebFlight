/**
 * Does a PNG contain (partially) transparent pixels? FlightGear blends textures with alpha,
 * so cut-out textures (instrument faces) need alpha in glTF too. Decodes 8-bit RGBA and
 * grey+alpha PNGs (zlib + scanline filters); other formats count as opaque unless they have
 * a tRNS chunk.
 */
import zlib from "node:zlib";

export function pngTransparency(data: Uint8Array): { transparent: number; total: number } {
  const b = Buffer.from(data);
  if (b.readUInt32BE(0) !== 0x89504e47) return { transparent: 0, total: 0 };
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0, hasTrns = false;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("ascii", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "tRNS") hasTrns = true;
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : 0;
  if (!channels || depth !== 8 || interlace !== 0) return { transparent: hasTrns ? 1 : 0, total: 1 };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let transparent = 0;
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const f = raw[off]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[off + 1 + x]!;
      const a = x >= channels ? cur[x - channels]! : 0;
      const up = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let r: number;
      switch (f) {
        case 1: r = v + a; break;
        case 2: r = v + up; break;
        case 3: r = v + ((a + up) >> 1); break;
        case 4: {
          const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default: r = v;
      }
      cur[x] = r & 0xff;
    }
    for (let x = channels - 1; x < stride; x += channels) if (cur[x]! < 128) transparent++;
    prev.set(cur);
  }
  return { transparent, total: width * height };
}
