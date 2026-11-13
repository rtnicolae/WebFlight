/**
 * Minimal PNG decoder for 8-bit RGB/RGBA, non-interlaced (what Terrarium elevation tiles
 * use). Inflate goes through the standard DecompressionStream, available in browsers,
 * workers and Node ≥ 18, so this file needs no platform APIs.
 */

// Standard web API, also global in Node; declared here because the package has no DOM lib.
declare const DecompressionStream: new (format: "deflate") => { readable: unknown; writable: unknown };
declare const Blob: new (parts: Uint8Array[]) => { stream(): { pipeThrough(t: unknown): unknown } };
declare const Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> };

export interface DecodedImage {
  width: number;
  height: number;
  /** Channels per pixel (3 = RGB, 4 = RGBA). */
  channels: number;
  pixels: Uint8Array;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export async function decodePng(data: Uint8Array): Promise<DecodedImage> {
  if (u32(data, 0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= data.length) {
    const len = u32(data, pos);
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels || depth !== 8 || interlace) throw new Error(`unsupported PNG (type ${colorType}, depth ${depth}, interlace ${interlace})`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = await inflate(joined);
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const up = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
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
      out[dst + x] = r & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}
