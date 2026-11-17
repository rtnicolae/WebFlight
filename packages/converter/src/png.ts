/**
 * PNG decode (8-bit grey, grey+alpha, RGB, RGBA, palette; not interlaced) to RGBA, and PNG
 * encode (RGBA or RGB, 8-bit, "up" filtered). node:zlib only: no image library.
 */
import zlib from "node:zlib";

export interface Rgba {
  width: number;
  height: number;
  /** RGBA rows, top to bottom. */
  data: Uint8Array;
}

export function decodePng(input: Uint8Array): Rgba {
  const b = Buffer.from(input);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | undefined, trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos), type = b.toString("ascii", pos + 4, pos + 8), body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (type ${colorType}, depth ${depth}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1), f = raw[off]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[off + 1 + x]!, a = x >= channels ? cur[x - channels]! : 0, up = prev[x]!, c = x >= channels ? prev[x - channels]! : 0;
      let r = v;
      if (f === 1) r = v + a;
      else if (f === 2) r = v + up;
      else if (f === 3) r = v + ((a + up) >> 1);
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (colorType === 6) out.set(cur.subarray(s, s + 4), o);
      else if (colorType === 2) out.set([cur[s]!, cur[s + 1]!, cur[s + 2]!, 255], o);
      else if (colorType === 0) out.set([cur[s]!, cur[s]!, cur[s]!, 255], o);
      else if (colorType === 4) out.set([cur[s]!, cur[s]!, cur[s]!, cur[s + 1]!], o);
      else {
        const i = cur[s]!;
        out.set([palette![i * 3]!, palette![i * 3 + 1]!, palette![i * 3 + 2]!, trns && i < trns.length ? trns[i]! : 255], o);
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** Encode RGBA pixels as a PNG; rgb: drop the alpha channel. */
export function encodePng(img: Rgba, opts: { rgb?: boolean; level?: number } = {}): Uint8Array {
  const ch = opts.rgb ? 3 : 4, stride = img.width * ch;
  const raw = Buffer.alloc((stride + 1) * img.height);
  const row = new Uint8Array(stride), prev = new Uint8Array(stride);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) for (let k = 0; k < ch; k++) row[x * ch + k] = img.data[(y * img.width + x) * 4 + k]!;
    const off = y * (stride + 1);
    raw[off] = 2; // "up": smooth images compress far better
    for (let x = 0; x < stride; x++) raw[off + 1 + x] = (row[x]! - prev[x]!) & 0xff;
    prev.set(row);
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
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.rgb ? 2 : 6;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: opts.level ?? 9 })), chunk("IEND", Buffer.alloc(0))]),
  );
}

/** Twice the size with a Lanczos-3 filter (separable), each channel clamped to 0–255. */
export function upscale2x(img: Rgba): Rgba {
  const lanczos = (x: number) => (x === 0 ? 1 : Math.abs(x) >= 3 ? 0 : (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * Math.PI * x * x));
  // Output pixel 2i + p sits at source i + (p ? 0.25 : -0.25).
  const taps = [0, 1].map((p) => {
    const f = p ? 0.25 : -0.25, w: number[] = [];
    for (let k = -3; k <= 3; k++) w.push(lanczos(k - f));
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((v) => v / s);
  });
  const { width: W, height: H } = img, W2 = W * 2, H2 = H * 2;
  const tmp = new Float32Array(W2 * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W2; x++) {
      const i = x >> 1, w = taps[x & 1]!;
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += w[k + 3]! * img.data[(y * W + Math.min(W - 1, Math.max(0, i + k))) * 4 + c]!;
        tmp[(y * W2 + x) * 4 + c] = s;
      }
    }
  const out = new Uint8Array(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) {
    const j = y >> 1, w = taps[y & 1]!;
    for (let x = 0; x < W2; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += w[k + 3]! * tmp[(Math.min(H - 1, Math.max(0, j + k)) * W2 + x) * 4 + c]!;
        out[(y * W2 + x) * 4 + c] = Math.min(255, Math.max(0, Math.round(s)));
      }
  }
  return { width: W2, height: H2, data: out };
}
