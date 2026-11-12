/**
 * Tiny anti-aliased raster canvas for quick report plots (draws at SS× and box-filters
 * down). Text uses a built-in 5×7 bitmap font (upper case, digits, basic punctuation).
 */
import { encodePng } from "./png.ts";

export type Rgb = readonly [number, number, number];
export const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const SS = 3;

// prettier-ignore
const FONT: Record<string, string> = {
  "A":"01110100011000111111100011000110001","B":"11110100011000111110100011000111110","C":"01110100011000010000100001000101110",
  "D":"11100100101000110001100011001011100","E":"11111100001000011110100001000011111","F":"11111100001000011110100001000010000",
  "G":"01110100011000010111100011000101111","H":"10001100011000111111100011000110001","I":"01110001000010000100001000010001110",
  "J":"00111000100001000010000101001001100","K":"10001100101010011000101001001010001","L":"10000100001000010000100001000011111",
  "M":"10001110111010110101100011000110001","N":"10001100011100110101100111000110001","O":"01110100011000110001100011000101110",
  "P":"11110100011000111110100001000010000","Q":"01110100011000110001101011001001101","R":"11110100011000111110101001001010001",
  "S":"01111100001000001110000010000111110","T":"11111001000010000100001000010000100","U":"10001100011000110001100011000101110",
  "V":"10001100011000110001100010101000100","W":"10001100011000110101101011010101010","X":"10001100010101000100010101000110001",
  "Y":"10001100010101000100001000010000100","Z":"11111000010001000100010001000011111",
  "0":"01110100011001110101110011000101110","1":"00100011000010000100001000010001110","2":"01110100010000100010001000100011111",
  "3":"11111000100010000010000011000101110","4":"00010001100101010010111110001000010","5":"11111100001111000001000011000101110",
  "6":"00110010001000011110100011000101110","7":"11111000010001000100010000100001000","8":"01110100011000101110100011000101110",
  "9":"01110100011000101111000010001001100",
  " ":"00000000000000000000000000000000000",".":"00000000000000000000000000110001100",",":"00000000000000000000001100010001000",
  "-":"00000000000000011111000000000000000","+":"00000001000010011111001000010000000","(":"00010001000100001000010000010000010",
  ")":"01000001000001000010000100010001000","/":"00000000010001000100010001000000000",":":"00000011000110000000011000110000000",
  "=":"00000000001111100000111110000000000","%":"11000110010001000100010001001100011","~":"00000000000100010101000100000000000",
  "@":"01110100010000101101101011010101110","<":"00010001000100010000010000010000010",">":"01000001000001000001000100010001000",
};

export class Canvas {
  private readonly px: Float32Array; // supersampled RGB
  private readonly W: number;
  private readonly H: number;
  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.W = width * SS;
    this.H = height * SS;
    this.px = new Float32Array(this.W * this.H * 3);
    for (let i = 0; i < this.W * this.H; i++) this.px.set(background, i * 3);
  }

  private dot(x: number, y: number, c: Rgb): void {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.W || yi >= this.H) return;
    this.px.set(c, (yi * this.W + xi) * 3);
  }

  /** Filled rectangle in output pixels. */
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let j = Math.round(y * SS); j < Math.round((y + h) * SS); j++)
      for (let i = Math.round(x * SS); i < Math.round((x + w) * SS); i++) this.dot(i, j, c);
  }

  /** Filled disc, centre and radius in output pixels. */
  disc(cx: number, cy: number, r: number, c: Rgb): void {
    const R = r * SS, X = cx * SS, Y = cy * SS;
    for (let j = Math.floor(Y - R); j <= Math.ceil(Y + R); j++)
      for (let i = Math.floor(X - R); i <= Math.ceil(X + R); i++)
        if ((i - X) ** 2 + (j - Y) ** 2 <= R * R) this.dot(i, j, c);
  }

  /** Polyline with round joins, width in output pixels. */
  polyline(pts: readonly (readonly [number, number])[], width: number, c: Rgb): void {
    const r = width / 2;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1]!, [x1, y1] = pts[k]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * SS));
      for (let s = 0; s <= n; s++) this.disc(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, r, c);
    }
  }

  /** Text (upper-cased) at output pixel scale `size` per font pixel. Returns width. */
  text(str: string, x: number, y: number, c: Rgb, opts: { size?: number; align?: "left" | "center" | "right"; vertical?: boolean } = {}): number {
    const size = opts.size ?? 2;
    const s = str.toUpperCase();
    const w = s.length * 6 * size - size;
    let ox = opts.align === "center" ? -w / 2 : opts.align === "right" ? -w : 0;
    for (const ch of s) {
      const g = FONT[ch] ?? FONT[" "]!;
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++) {
          if (g[row * 5 + col] !== "1") continue;
          if (opts.vertical) this.rect(x + row * size, y - (ox + col * size) - size, size, size, c);
          else this.rect(x + ox + col * size, y + row * size, size, size, c);
        }
      ox += 6 * size;
    }
    return w;
  }

  toPng(): Buffer {
    const out = new Uint8Array(this.width * this.height * 3);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0;
          for (let j = 0; j < SS; j++)
            for (let i = 0; i < SS; i++) sum += this.px[((y * SS + j) * this.W + x * SS + i) * 3 + ch]!;
          out[(y * this.width + x) * 3 + ch] = Math.round(sum / (SS * SS));
        }
    return encodePng(this.width, this.height, out);
  }
}
