/**
 * Minimal Mapbox Vector Tile (v2) decoder: layers, features, tags and geometry, per the
 * vector-tile-spec (protobuf; commands MoveTo=1, LineTo=2, ClosePath=7 with zigzag params).
 * Geometry comes out in tile units (0..extent), y down.
 */

export type GeomType = 0 | 1 | 2 | 3; // unknown, point, linestring, polygon

export interface MvtFeature {
  id?: number;
  type: GeomType;
  properties: Record<string, string | number | boolean>;
  /** Rings (polygons), lines or point lists, in tile units. */
  geometry: [number, number][][];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let result = 0, shift = 0, b: number;
    do {
      b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  }
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`mvt: wire type ${wire}`);
  }
  string(): string {
    const len = this.varint();
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  packed(): number[] {
    const r = this.sub();
    const out: number[] = [];
    while (r.pos < r.end) out.push(r.varint());
    return out;
  }
}

const zigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function value(r: Reader): string | number | boolean {
  let v: string | number | boolean = "";
  while (r.pos < r.end) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    const dv = new DataView(r.buf.buffer, r.buf.byteOffset);
    if (field === 1) v = r.string();
    else if (field === 2) {
      v = dv.getFloat32(r.pos, true);
      r.pos += 4;
    } else if (field === 3) {
      v = dv.getFloat64(r.pos, true);
      r.pos += 8;
    } else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = r.varint() !== 0;
    else r.skip(wire);
  }
  return v;
}

function geometry(cmds: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let x = 0, y = 0, i = 0;
  let cur: [number, number][] | undefined;
  while (i < cmds.length) {
    const c = cmds[i++]!, id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]!);
        y += zigzag(cmds[i++]!);
        if (id === 1) {
          cur = [];
          parts.push(cur);
        }
        cur!.push([x, y]);
      }
    } else if (id === 7 && cur?.length) cur.push([cur[0]![0], cur[0]![1]]);
  }
  return parts;
}

export function decodeMvt(data: Uint8Array): MvtLayer[] {
  const top = new Reader(data);
  const layers: MvtLayer[] = [];
  while (top.pos < top.end) {
    const tag = top.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      top.skip(tag & 7);
      continue;
    }
    const r = top.sub();
    let name = "", extent = 4096;
    const keys: string[] = [], values: (string | number | boolean)[] = [];
    const raw: { id?: number; type: GeomType; tags: number[]; geom: number[] }[] = [];
    while (r.pos < r.end) {
      const t = r.varint(), field = t >> 3;
      if (field === 1) name = r.string();
      else if (field === 2) {
        const f = r.sub();
        const feat: { id?: number; type: GeomType; tags: number[]; geom: number[] } = { type: 0, tags: [], geom: [] };
        while (f.pos < f.end) {
          const ft = f.varint(), ff = ft >> 3;
          if (ff === 1) feat.id = f.varint();
          else if (ff === 2) feat.tags = f.packed();
          else if (ff === 3) feat.type = f.varint() as GeomType;
          else if (ff === 4) feat.geom = f.packed();
          else f.skip(ft & 7);
        }
        raw.push(feat);
      } else if (field === 3) keys.push(r.string());
      else if (field === 4) values.push(value(r.sub()));
      else if (field === 5) extent = r.varint();
      else r.skip(t & 7);
    }
    layers.push({
      name,
      extent,
      features: raw.map((f) => {
        const properties: Record<string, string | number | boolean> = {};
        for (let k = 0; k + 1 < f.tags.length; k += 2) properties[keys[f.tags[k]!]!] = values[f.tags[k + 1]!]!;
        return { ...(f.id !== undefined ? { id: f.id } : {}), type: f.type, properties, geometry: geometry(f.geom) };
      }),
    });
  }
  return layers;
}
