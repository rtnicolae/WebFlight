/**
 * AC3D (.ac) reader. Produces an object tree with vertices baked into the file's root
 * frame (each object's `rot`/`loc` applied cumulatively), which is how FlightGear's
 * animation coordinates refer to them.
 *
 * Format: https://www.inivis.com/ac3d/man/ac3dfileformat.html
 */

export interface AcMaterial {
  name: string;
  rgb: [number, number, number];
  amb: [number, number, number];
  emis: [number, number, number];
  spec: [number, number, number];
  shi: number;
  trans: number;
}

export interface AcSurface {
  flags: number;
  mat: number;
  /** Vertex indices into the object's `vertices`. */
  refs: number[];
  /** Per-ref texture coordinates (AC origin bottom-left). */
  uvs: [number, number][];
}

export interface AcObject {
  type: string; // world | poly | group | light
  name: string;
  texture: string | undefined;
  texrep: [number, number];
  texoff: [number, number];
  crease: number;
  hidden: boolean;
  /** Root-frame positions. */
  vertices: [number, number, number][];
  surfaces: AcSurface[];
  kids: AcObject[];
}

export interface AcFile {
  materials: AcMaterial[];
  root: AcObject;
}

type Mat3 = number[]; // row-major 3x3
const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul3 = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
};
const apply3 = (m: Mat3, v: readonly number[]): [number, number, number] => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
];

class Lines {
  private i = 0;
  constructor(private readonly lines: string[]) {}
  get done(): boolean {
    return this.i >= this.lines.length;
  }
  next(): string {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i++]!.trim();
      if (l.length > 0) return l;
    }
    throw new Error("AC3D: unexpected end of file");
  }
  raw(): string {
    return this.lines[this.i++] ?? "";
  }
}

/** Split a line into tokens, keeping "quoted strings" together (quotes removed). */
function tokens(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]!);
  return out;
}

const nums = (t: string[], from: number, n: number) => t.slice(from, from + n).map(Number);

function parseMaterial(t: string[]): AcMaterial {
  const get = (key: string, n: number) => {
    const i = t.indexOf(key);
    return i < 0 ? new Array<number>(n).fill(0) : nums(t, i + 1, n);
  };
  return {
    name: t[1] ?? "",
    rgb: get("rgb", 3) as [number, number, number],
    amb: get("amb", 3) as [number, number, number],
    emis: get("emis", 3) as [number, number, number],
    spec: get("spec", 3) as [number, number, number],
    shi: get("shi", 1)[0]!,
    trans: get("trans", 1)[0]!,
  };
}

function parseObject(L: Lines, header: string[], parentRot: Mat3, parentLoc: readonly number[]): AcObject {
  const obj: AcObject = {
    type: header[1] ?? "poly",
    name: "",
    texture: undefined,
    texrep: [1, 1],
    texoff: [0, 0],
    crease: 61,
    hidden: false,
    vertices: [],
    surfaces: [],
    kids: [],
  };
  let rot: Mat3 = IDENT;
  let loc = [0, 0, 0];
  let local: number[][] = [];
  for (;;) {
    const line = L.next();
    const t = tokens(line);
    switch (t[0]) {
      case "name": obj.name = t[1] ?? ""; break;
      case "data": {
        // "data N" then N characters (possibly spanning lines)
        let n = Number(t[1]);
        while (n > 0 && !L.done) n -= L.raw().length + 1;
        break;
      }
      case "texture": obj.texture = t[1]; break;
      case "texrep": obj.texrep = nums(t, 1, 2) as [number, number]; break;
      case "texoff": obj.texoff = nums(t, 1, 2) as [number, number]; break;
      case "rot": rot = nums(t, 1, 9); break;
      case "loc": loc = nums(t, 1, 3); break;
      case "crease": obj.crease = Number(t[1]); break;
      case "hidden": obj.hidden = true; break;
      case "url": case "subdiv": case "locked": case "folded": break;
      case "numvert": {
        const n = Number(t[1]);
        local = [];
        for (let i = 0; i < n; i++) local.push(nums(tokens(L.next()), 0, 3));
        break;
      }
      case "numsurf": {
        const n = Number(t[1]);
        for (let s = 0; s < n; s++) {
          const surf: AcSurface = { flags: 0, mat: 0, refs: [], uvs: [] };
          for (;;) {
            const st = tokens(L.next());
            if (st[0] === "SURF") surf.flags = parseInt(st[1]!, 16);
            else if (st[0] === "mat") surf.mat = Number(st[1]);
            else if (st[0] === "refs") {
              const k = Number(st[1]);
              for (let r = 0; r < k; r++) {
                const rt = tokens(L.next());
                surf.refs.push(Number(rt[0]));
                surf.uvs.push([Number(rt[1] ?? 0), Number(rt[2] ?? 0)]);
              }
              break;
            } else throw new Error(`AC3D: unexpected '${st[0]}' in SURF of ${obj.name}`);
          }
          obj.surfaces.push(surf);
        }
        break;
      }
      case "kids": {
        // World transform of this object: parentRot * (rot * v + loc) + parentLoc
        const wRot = mul3(parentRot, rot);
        const pl = apply3(parentRot, loc);
        const wLoc = [pl[0] + parentLoc[0]!, pl[1] + parentLoc[1]!, pl[2] + parentLoc[2]!];
        obj.vertices = local.map((v) => {
          const r = apply3(wRot, v);
          return [r[0] + wLoc[0]!, r[1] + wLoc[1]!, r[2] + wLoc[2]!];
        });
        const n = Number(t[1]);
        for (let k = 0; k < n; k++) {
          const h = tokens(L.next());
          if (h[0] !== "OBJECT") throw new Error(`AC3D: expected OBJECT, got '${h[0]}'`);
          obj.kids.push(parseObject(L, h, wRot, wLoc));
        }
        return obj;
      }
      default:
        throw new Error(`AC3D: unknown token '${t[0]}' in object ${obj.name}`);
    }
  }
}

export function parseAc3d(text: string): AcFile {
  const L = new Lines(text.split(/\r?\n/));
  const head = L.next();
  if (!head.startsWith("AC3D")) throw new Error("not an AC3D file");
  const materials: AcMaterial[] = [];
  for (;;) {
    const t = tokens(L.next());
    if (t[0] === "MATERIAL" || t[0] === "MAT") materials.push(parseMaterial(t));
    else if (t[0] === "OBJECT") return { materials, root: parseObject(L, t, IDENT, [0, 0, 0]) };
    else throw new Error(`AC3D: unexpected '${t[0]}' before first OBJECT`);
  }
}

/** Surface type bits (low nibble): 0 polygon, 1 closed line, 2 line. */
export const isPolygon = (s: AcSurface) => (s.flags & 0x0f) === 0;
export const isSmooth = (s: AcSurface) => (s.flags & 0x10) !== 0;
export const isTwoSided = (s: AcSurface) => (s.flags & 0x20) !== 0;
