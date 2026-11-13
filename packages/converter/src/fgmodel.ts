/**
 * FlightGear model (XML + AC3D) → glTF scene + animation manifest.
 *
 * Coordinate frames
 * - AC frame: the .ac file's own axes, y up. glTF uses the same axes (glTF is y-up too).
 * - FG model frame: x aft, y right, z up; SimGear maps AC (x, y, z) → FG (x, -z, y).
 *   Animation centers/axes and <offsets> in model XML are in the FG model frame.
 * All geometry is baked into the AC frame of the top-level model; glTF node transforms are
 * identity, so an animation is a plain model-space matrix on its node.
 */
import fs from "node:fs";
import path from "node:path";
import { type AcFile, type AcObject, isPolygon, isSmooth, isTwoSided, parseAc3d } from "./ac3d.ts";
import { type GlbImage, type GlbMaterial, type GlbNode, type GlbPrimitive } from "./glb.ts";
import { PropNode, getProp, readPropertyList, toPNode, type PNodeJson } from "./proplist.ts";
import { FgResolver } from "./resolve.ts";

// ---------------------------------------------------------------------------------------
// Manifest types (consumed by the web renderer)

import type { AnimationEntry, Condition, Operand, TexTransform, ValueSpec } from "@webflight/fdm-core";

export type { AnimationEntry, Condition, Operand, ValueSpec };

// ---------------------------------------------------------------------------------------
// Small linear algebra (row-major 4x4, column vectors)

type M4 = number[];
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul4 = (a: M4, b: M4): M4 => {
  const r = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j]! += a[i * 4 + k]! * b[k * 4 + j]!;
  return r;
};
const xfPoint = (m: M4, v: readonly number[]): [number, number, number] => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]! + m[3]!,
  m[4]! * v[0]! + m[5]! * v[1]! + m[6]! * v[2]! + m[7]!,
  m[8]! * v[0]! + m[9]! * v[1]! + m[10]! * v[2]! + m[11]!,
];
const xfDir = (m: M4, v: readonly number[]): [number, number, number] => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[4]! * v[0]! + m[5]! * v[1]! + m[6]! * v[2]!,
  m[8]! * v[0]! + m[9]! * v[1]! + m[10]! * v[2]!,
];
const norm3 = (v: readonly number[]): [number, number, number] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
/** FG model frame → AC frame: (x, y, z)_fg → (x, z, -y)_ac. */
const fgToAc = (v: readonly number[]): [number, number, number] => [v[0]!, v[2]!, -v[1]!];
const FG_TO_AC: M4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const AC_TO_FG: M4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const rotAxis = (axis: readonly number[], deg: number): M4 => {
  const [x, y, z] = norm3(axis);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1];
};

/** <offsets> (FG frame: x/y/z-m, roll/pitch/heading-deg) as an AC-frame matrix. */
function offsetsMatrix(o: PropNode | undefined): M4 {
  if (!o) return I4;
  const g = (k: string) => Number(getProp(o, k) ?? 0) || 0;
  // SimGear (model.cxx): rotate pitch about y, roll about x, heading about z, then translate.
  let m = mul4(rotAxis([0, 0, 1], g("heading-deg")), mul4(rotAxis([1, 0, 0], g("roll-deg")), rotAxis([0, 1, 0], g("pitch-deg"))));
  m[3] = g("x-m");
  m[7] = g("y-m");
  m[11] = g("z-m");
  m = [...m];
  return mul4(FG_TO_AC, mul4(m, AC_TO_FG));
}

// ---------------------------------------------------------------------------------------
// PropNode helpers

const childList = (n: PropNode | undefined, name: string): PropNode[] =>
  n ? [...n.children.entries()].filter(([k]) => k.startsWith(name + "[")).sort((a, b) => idx(a[0]) - idx(b[0])).map(([, v]) => v) : [];
const idx = (key: string) => Number(/\[(\d+)\]$/.exec(key)?.[1] ?? 0);
const child = (n: PropNode | undefined, name: string) => n?.children.get(`${name}[0]`);
const text = (n: PropNode | undefined, name: string) => child(n, name)?.value;
const num = (n: PropNode | undefined, name: string): number | undefined => {
  const v = text(n, name);
  if (v === undefined || v.trim() === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

/** Normalise a property path relative to the model root ("/" for the user aircraft). */
export function normProp(p: string): string {
  if (p.trim() === "") return "";
  const abs = p.trim().startsWith("/") ? p.trim() : "/" + p.trim();
  return abs.replace(/\[0\]/g, "").replace(/\/+/g, "/");
}

const CMP: Record<string, "eq" | "ne" | "lt" | "gt" | "le" | "ge"> = {
  equals: "eq", "not-equals": "ne", "less-than": "lt", "greater-than": "gt", "less-than-equals": "le", "greater-than-equals": "ge",
};

/** Parse the children of a condition element; the caller combines them. */
function parseConditionParts(n: PropNode, warn: (m: string) => void): Condition[] {
  const parts: Condition[] = [];
  for (const [key, c] of n.children) {
    const name = key.replace(/\[\d+\]$/, "");
    if (name === "and" || name === "or") parts.push({ op: name, args: parseConditionParts(c, warn) });
    else if (name === "not") parts.push({ op: "not", arg: parseCondition(c, warn) });
    else if (name === "property") {
      const prop = normProp(c.value ?? "");
      if (prop) parts.push({ op: "prop", prop });
    }
    else if (CMP[name]) {
      const ops: Operand[] = [];
      for (const [k2, o] of c.children) {
        const n2 = k2.replace(/\[\d+\]$/, "");
        if (n2 === "property") ops.push({ prop: normProp(o.value ?? "") });
        else if (n2 === "value") {
          const v = o.value ?? "";
          ops.push({ value: v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v });
        }
      }
      if (ops.length === 2) parts.push({ op: CMP[name]!, a: ops[0]!, b: ops[1]! });
      else warn(`condition <${name}> with ${ops.length} operands ignored`);
    } else warn(`condition element <${name}> not supported (treated as true)`);
  }
  return parts;
}

/** A <condition> (or <not>) element: its children are AND-ed, as in SimGear. */
function parseCondition(n: PropNode, warn: (m: string) => void): Condition {
  const parts = parseConditionParts(n, warn);
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 0) return { op: "const", value: true };
  return { op: "and", args: parts };
}

/** Properties read by an expression (PropertyList JSON). */
function exprProperties(p: PNodeJson, out: Set<string>): void {
  if (p.n === "property" && p.v?.trim()) out.add(normProp(p.v));
  for (const c of p.c ?? []) exprProperties(c, out);
}

function parseValue(a: PropNode, unit: "-deg" | "-m" | "", warn: (m: string) => void, tex = false): ValueSpec | undefined {
  const exprNode = child(a, "expression");
  if (exprNode) {
    const first = [...exprNode.children][0];
    if (!first) {
      warn("empty <expression>");
      return undefined;
    }
    const m = /^(.*)\[(\d+)\]$/.exec(first[0])!;
    return { expr: toPNode(first[1], m[1]!, Number(m[2])), start: 0, factor: 1, offset: 0 };
  }
  const prop = text(a, "property");
  const spec: ValueSpec = {
    ...(prop ? { property: normProp(prop) } : {}),
    start: num(a, `starting-position${unit}`) ?? 0,
    factor: num(a, "factor") ?? 1,
    offset: num(a, `offset${unit}`) ?? 0,
  };
  const min = num(a, `min${unit}`), max = num(a, `max${unit}`);
  if (min !== undefined) spec.min = min;
  if (max !== undefined) spec.max = max;
  const interp = child(a, "interpolation");
  if (interp) spec.table = childList(interp, "entry").map((e) => [num(e, "ind") ?? 0, num(e, "dep") ?? 0]);
  if (tex) {
    const bias = num(a, "bias"), step = num(a, "step"), scroll = num(a, "scroll");
    if (bias) spec.bias = bias;
    if (step) spec.step = step;
    if (scroll) spec.scroll = scroll;
  }
  return spec;
}

/** Merge a <model><overlay> into a model file's tree (overlay wins), like copyProperties. */
function mergeOverlay(target: PropNode, src: PropNode): void {
  for (const [key, sc] of src.children) {
    let tc = target.children.get(key);
    if (!tc) {
      tc = new PropNode();
      target.children.set(key, tc);
    }
    if (sc.children.size > 0) mergeOverlay(tc, sc);
    else {
      tc.value = sc.value;
      if (sc.type) tc.type = sc.type;
      if (sc.alias) tc.alias = sc.alias;
    }
  }
}

/** In model files, alias="/params/x" refers to this file's own tree: substitute the value. */
function resolveDocAliases(root: PropNode, node: PropNode = root, depth = 0): void {
  for (const c of node.children.values()) {
    if (c.alias && depth < 64) {
      const v = getProp(root, c.alias);
      if (v !== undefined) {
        c.value = v;
        c.alias = undefined;
      }
    }
    resolveDocAliases(root, c, depth + 1);
  }
}

// ---------------------------------------------------------------------------------------
// Scene building

interface SceneNode {
  name: string; // unique
  children: SceneNode[];
  primitives: GlbPrimitive[];
}

export interface ConvertedModel {
  nodes: GlbNode[];
  roots: number[];
  materials: GlbMaterial[];
  images: GlbImage[];
  animations: AnimationEntry[];
  /** Every property referenced by animations/conditions. */
  properties: string[];
  /** glTF node name → parent node name (for picking: a click on a mesh inside a group). */
  parents: Record<string, string>;
  warnings: string[];
  stats: { objects: number; triangles: number; models: number; skippedAnimations: Record<string, number> };
}

interface Ctx {
  aircraftDir: string;
  aircraftName: string;
  resolver: FgResolver;
  used: Set<string>;
  /** Nodes with texture animations: their textured primitives get their own materials. */
  texNodes: Set<SceneNode>;
  materials: GlbMaterial[];
  materialKeys: Map<string, number>;
  images: GlbImage[];
  imageKeys: Map<string, number>;
  animations: AnimationEntry[];
  properties: Set<string>;
  warnings: string[];
  stats: ConvertedModel["stats"];
}

function uniqueName(ctx: Ctx, base: string): string {
  let n = base || "node";
  for (let i = 1; ctx.used.has(n); i++) n = `${base}#${i}`;
  ctx.used.add(n);
  return n;
}

function resolveFile(ctx: Ctx, ref: string, fromDir: string): string | undefined {
  return ctx.resolver.resolve(ref, fromDir);
}

/** Path for messages: aircraft-relative, or "FGData:" + FG_ROOT-relative. */
function displayPath(ctx: Ctx, file: string): string {
  const shared = ctx.resolver.sharedPathOf(file);
  return shared ? `FGData:${shared}` : path.relative(ctx.aircraftDir, file);
}

function textureIndex(ctx: Ctx, file: string | undefined, acDir: string): number | undefined {
  if (!file) return undefined;
  const resolved = ctx.resolver.resolve(file, acDir);
  if (!resolved) {
    ctx.warnings.push(`texture not found: ${file}`);
    return undefined;
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : undefined;
  if (!mime) {
    ctx.warnings.push(`texture format not supported yet (${ext}): ${file}`);
    return undefined;
  }
  let i = ctx.imageKeys.get(resolved);
  if (i === undefined) {
    ctx.images.push({ mimeType: mime, data: new Uint8Array(fs.readFileSync(resolved)) });
    i = ctx.images.length - 1;
    ctx.imageKeys.set(resolved, i);
  }
  return i;
}

function materialIndex(ctx: Ctx, ac: AcFile, mat: number, image: number | undefined, twoSided: boolean): number {
  const m = ac.materials[mat] ?? { name: "default", rgb: [0.8, 0.8, 0.8], emis: [0, 0, 0], shi: 0, trans: 0 };
  const key = JSON.stringify([m.name, m.rgb, m.emis, m.shi, m.trans, image, twoSided]);
  let i = ctx.materialKeys.get(key);
  if (i === undefined) {
    ctx.materials.push({
      name: m.name,
      baseColor: [m.rgb[0], m.rgb[1], m.rgb[2], 1 - m.trans],
      emissive: m.emis,
      roughness: Math.min(1, Math.max(0.25, 1 - m.shi / 128)),
      doubleSided: twoSided,
      ...(image !== undefined ? { image } : {}),
    });
    i = ctx.materials.length - 1;
    ctx.materialKeys.set(key, i);
  }
  return i;
}

/** Triangulate a planar polygon (ear clipping in its dominant plane). Returns corner indices. */
function triangulate(pts: [number, number, number][], normal: readonly number[]): number[] {
  const n = pts.length;
  if (n === 3) return [0, 1, 2];
  if (n === 4) return [0, 1, 2, 0, 2, 3];
  const ax = Math.abs(normal[0]!), ay = Math.abs(normal[1]!), az = Math.abs(normal[2]!);
  const [u, v] = ax > ay && ax > az ? [1, 2] : ay > az ? [2, 0] : [0, 1];
  const sign = (ax > ay && ax > az ? normal[0]! : ay > az ? normal[1]! : normal[2]!) >= 0 ? 1 : -1;
  const p2 = pts.map((p) => [p[u]!, p[v]!]);
  const area = (a: number[], b: number[], c: number[]) => ((b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!)) * sign;
  const inTri = (p: number[], a: number[], b: number[], c: number[]) => area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0;
  const rem = [...Array(n).keys()];
  const out: number[] = [];
  let guard = 0;
  while (rem.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < rem.length; i++) {
      const ia = rem[(i + rem.length - 1) % rem.length]!, ib = rem[i]!, ic = rem[(i + 1) % rem.length]!;
      const a = p2[ia]!, b = p2[ib]!, c = p2[ic]!;
      if (area(a, b, c) <= 0) continue;
      if (rem.some((j) => j !== ia && j !== ib && j !== ic && inTri(p2[j]!, a, b, c))) continue;
      out.push(ia, ib, ic);
      rem.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (rem.length >= 3) for (let i = 1; i + 1 < rem.length; i++) out.push(rem[0]!, rem[i]!, rem[i + 1]!); // fallback fan
  return out;
}

function buildPrimitives(ctx: Ctx, ac: AcFile, obj: AcObject, acDir: string, frame: M4): GlbPrimitive[] {
  const V = obj.vertices.map((v) => xfPoint(frame, v));
  const image = textureIndex(ctx, obj.texture, acDir);
  // Face normals (Newell, unnormalised → area weighted).
  const faces = obj.surfaces.filter((s) => isPolygon(s) && s.refs.length >= 3);
  const fn = faces.map((s) => {
    const n = [0, 0, 0];
    for (let i = 0; i < s.refs.length; i++) {
      const a = V[s.refs[i]!]!, b = V[s.refs[(i + 1) % s.refs.length]!]!;
      n[0]! += (a[1] - b[1]) * (a[2] + b[2]);
      n[1]! += (a[2] - b[2]) * (a[0] + b[0]);
      n[2]! += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return n;
  });
  const fnUnit = fn.map(norm3);
  const cosCrease = Math.cos((obj.crease * Math.PI) / 180);
  const byVertex = new Map<number, number[]>();
  faces.forEach((s, f) => {
    if (!isSmooth(s)) return;
    for (const r of s.refs) (byVertex.get(r) ?? byVertex.set(r, []).get(r)!).push(f);
  });

  const groups = new Map<number, { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; dedupe: Map<string, number> }>();
  faces.forEach((s, f) => {
    if (Math.hypot(...fn[f]!) < 1e-12) return;
    const mat = materialIndex(ctx, ac, s.mat, image, isTwoSided(s));
    let g = groups.get(mat);
    if (!g) groups.set(mat, (g = { pos: [], nrm: [], uv: [], idx: [], dedupe: new Map() }));
    const corner = s.refs.map((r, k) => {
      let n: number[] = fnUnit[f]!;
      if (isSmooth(s)) {
        const acc = [0, 0, 0];
        for (const f2 of byVertex.get(r) ?? []) {
          const u = fnUnit[f2]!;
          if (u[0]! * n[0]! + u[1]! * n[1]! + u[2]! * n[2]! >= cosCrease - 1e-9) for (let c = 0; c < 3; c++) acc[c]! += fn[f2]![c]!;
        }
        n = norm3(acc);
      }
      const [tu, tv] = s.uvs[k]!;
      const uv = [obj.texoff[0] + tu * obj.texrep[0], 1 - (obj.texoff[1] + tv * obj.texrep[1])];
      const p = V[r]!;
      const key = `${r}|${uv[0]!.toFixed(5)},${uv[1]!.toFixed(5)}|${n[0]!.toFixed(3)},${n[1]!.toFixed(3)},${n[2]!.toFixed(3)}`;
      let vi = g.dedupe.get(key);
      if (vi === undefined) {
        vi = g.pos.length / 3;
        g.pos.push(p[0], p[1], p[2]);
        g.nrm.push(n[0]!, n[1]!, n[2]!);
        g.uv.push(uv[0]!, uv[1]!);
        g.dedupe.set(key, vi);
      }
      return vi;
    });
    const tri = triangulate(s.refs.map((r) => V[r]!), fnUnit[f]!);
    for (const t of tri) g.idx.push(corner[t]!);
    ctx.stats.triangles += tri.length / 3;
  });
  return [...groups].map(([material, g]) => ({
    positions: new Float32Array(g.pos),
    normals: new Float32Array(g.nrm),
    ...(image !== undefined ? { uvs: new Float32Array(g.uv) } : {}),
    indices: new Uint32Array(g.idx),
    material,
  }));
}

function buildAcTree(ctx: Ctx, ac: AcFile, obj: AcObject, acDir: string, frame: M4, byName: Map<string, SceneNode[]>): SceneNode {
  ctx.stats.objects++;
  const node: SceneNode = { name: uniqueName(ctx, obj.name || obj.type), children: [], primitives: obj.type === "light" ? [] : buildPrimitives(ctx, ac, obj, acDir, frame) };
  if (obj.name) (byName.get(obj.name) ?? byName.set(obj.name, []).get(obj.name)!).push(node);
  for (const k of obj.kids) node.children.push(buildAcTree(ctx, ac, k, acDir, frame, byName));
  return node;
}

function findParent(root: SceneNode, target: SceneNode): SceneNode | undefined {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.children.includes(target)) return n;
    stack.push(...n.children);
  }
  return undefined;
}

const ANIM_TYPES = new Set<string>(["rotate", "translate", "spin", "select"]);
const TEX_TYPES = new Set<string>(["textranslate", "texrotate", "texmultiple"]);
const PICK_TYPES = new Set<string>(["pick", "knob", "slider", "touch"]);

/** Load a model file (.xml or .ac) under `frame` (its AC frame → top-level AC frame). */
function loadModel(ctx: Ctx, file: string, frame: M4, overlay?: PropNode): SceneNode | undefined {
  ctx.stats.models++;
  const dir = path.dirname(file);
  const rel = displayPath(ctx, file);
  if (file.endsWith(".ac")) {
    const ac = parseAc3d(fs.readFileSync(file, "latin1"));
    return buildAcTree(ctx, ac, ac.root, dir, frame, new Map());
  }
  const props = readPropertyList(file, { aircraftDir: ctx.aircraftDir, aircraftName: ctx.aircraftName, warnings: ctx.warnings, resolver: ctx.resolver });
  if (overlay) mergeOverlay(props, overlay);
  resolveDocAliases(props);
  const own = mul4(frame, offsetsMatrix(child(props, "offsets")));
  const group: SceneNode = { name: uniqueName(ctx, `model:${rel}`), children: [], primitives: [] };
  const byName = new Map<string, SceneNode[]>();
  const lineObjects = new Map<string, [[number, number, number], [number, number, number]]>();
  const acPath = text(props, "path");
  if (acPath) {
    const acFile = resolveFile(ctx, acPath, dir);
    if (!acFile) ctx.warnings.push(`${rel}: model file not found: ${acPath}`);
    else {
      const ac = parseAc3d(fs.readFileSync(acFile, "latin1"));
      group.children.push(buildAcTree(ctx, ac, ac.root, path.dirname(acFile), own, byName));
      const visit = (o: AcObject) => {
        if (o.vertices.length >= 2 && o.surfaces.length > 0 && o.surfaces.every((x) => !isPolygon(x))) {
          lineObjects.set(o.name, [xfPoint(own, o.vertices[0]!), xfPoint(own, o.vertices[o.vertices.length - 1]!)]);
        }
        o.kids.forEach(visit);
      };
      visit(ac.root);
    }
  }

  const warn = (m: string) => ctx.warnings.push(`${rel}: ${m}`);
  const use = (c: Condition | undefined): void => {
    if (!c) return;
    if (c.op === "prop") ctx.properties.add(c.prop);
    else if (c.op === "and" || c.op === "or") c.args.forEach(use);
    else if (c.op === "not") use(c.arg);
    else if ("a" in c) for (const o of [c.a, c.b]) if ("prop" in o) ctx.properties.add(o.prop);
  };

  // Submodels first: SimGear loads them before installing animations, and animations
  // may refer to a submodel by its <name>.
  for (const m of childList(props, "model")) {
    const p = text(m, "path");
    if (!p) continue;
    const sub = resolveFile(ctx, p.trim(), dir);
    if (!sub) {
      ctx.warnings.push(`${rel}: submodel not found: ${p.trim()}`);
      continue;
    }
    if (!/\.(xml|ac)$/i.test(sub)) {
      ctx.warnings.push(`${rel}: submodel type not supported: ${p.trim()}`);
      continue;
    }
    const node = loadModel(ctx, sub, mul4(own, offsetsMatrix(child(m, "offsets"))), child(m, "overlay"));
    if (!node) continue;
    group.children.push(node);
    const subName = text(m, "name")?.trim();
    if (subName) (byName.get(subName) ?? byName.set(subName, []).get(subName)!).push(node);
    const condNode = child(m, "condition");
    if (condNode) {
      const condition = parseCondition(condNode, warn);
      use(condition);
      ctx.animations.push({ type: "select", nodes: [node.name], condition });
    }
  }
  for (const a of childList(props, "animation")) {
    const type = text(a, "type")?.trim() as AnimationEntry["type"] | undefined;
    let targets = childList(a, "object-name").flatMap((o) => {
      const found = byName.get((o.value ?? "").trim());
      if (!found) warn(`animation object not found: ${o.value}`);
      return found ?? [];
    });
    const animName = text(a, "name")?.trim();
    if (animName && targets.length > 0) {
      // A named animation groups its objects so later animations can refer to the name.
      // As in SimGear, the group takes the place of the first object under its current
      // parent, so it stays inside any group (and select) that already contained it.
      const g: SceneNode = { name: uniqueName(ctx, animName), children: [], primitives: [] };
      const host = findParent(group, targets[0]!) ?? group;
      host.children.splice(host.children.indexOf(targets[0]!), 0, g);
      for (const t of targets) {
        const parent = findParent(group, t);
        if (parent && parent !== g) parent.children.splice(parent.children.indexOf(t), 1);
        g.children.push(t);
      }
      (byName.get(animName) ?? byName.set(animName, []).get(animName)!).push(g);
      targets = [g];
    }
    if (!type) continue;
    const kind = type as string;
    if (!ANIM_TYPES.has(kind) && !TEX_TYPES.has(kind) && !PICK_TYPES.has(kind)) {
      ctx.stats.skippedAnimations[kind] = (ctx.stats.skippedAnimations[kind] ?? 0) + 1;
      continue;
    }
    if (targets.length === 0) continue;
    const nodes = targets.map((t) => t.name);
    const condNode = child(a, "condition");
    const condition = condNode ? parseCondition(condNode, warn) : undefined;
    use(condition);
    if (TEX_TYPES.has(kind)) {
      const cfgs = kind === "texmultiple" ? childList(a, "transform").map((t) => ({ cfg: t, sub: text(t, "subtype")?.trim() ?? "" })) : [{ cfg: a, sub: kind }];
      const transforms: TexTransform[] = [];
      for (const { cfg, sub } of cfgs) {
        const ax = child(cfg, "axis");
        const v = [num(ax, "x") ?? 0, num(ax, "y") ?? 0];
        const len = Math.hypot(v[0]!, v[1]!) || 1;
        if (sub === "textranslate") {
          const value = parseValue(cfg, "", warn, true);
          if (!value) continue;
          if (value.property) ctx.properties.add(value.property);
          value.start = num(cfg, "starting-position") ?? 0;
          transforms.push({ kind: "translate", axis: [v[0]! / len, v[1]! / len], value });
        } else if (sub === "texrotate") {
          const value = parseValue(cfg, "-deg", warn, true);
          if (!value) continue;
          if (value.property) ctx.properties.add(value.property);
          const c = child(cfg, "center");
          transforms.push({ kind: "rotate", center: [num(c, "x") ?? 0, num(c, "y") ?? 0], value });
        } else warn(`texture transform "${sub}" not supported`);
      }
      if (transforms.length) {
        ctx.animations.push({ type: "tex", nodes, transforms, ...(condition ? { condition } : {}) });
        for (const t of targets) ctx.texNodes.add(t);
      }
      continue;
    }
    if (PICK_TYPES.has(kind)) {
      const pj = (name: string) => {
        const n = child(a, name);
        return n ? toPNode(n, name) : undefined;
      };
      const action = pj("action"), increase = pj("increase"), decrease = pj("decrease");
      const drag = text(a, "drag-direction")?.trim();
      const tip = child(child(child(a, "hovered"), "binding"), "label");
      ctx.animations.push({
        type: "pick",
        nodes,
        kind: kind as "pick" | "knob" | "slider" | "touch",
        ...(action ? { action } : {}),
        ...(increase ? { increase } : {}),
        ...(decrease ? { decrease } : {}),
        ...(drag === "vertical" || drag === "horizontal" ? { drag } : {}),
        ...(tip?.value ? { tooltip: tip.value.trim() } : {}),
      });
      if (kind !== "knob" && kind !== "slider") continue;
      // Knobs rotate and sliders translate their objects by the bound property.
      if (!text(a, "property") && !child(a, "expression")) continue;
    }
    const motion: "rotate" | "translate" | "spin" = kind === "knob" ? "rotate" : kind === "slider" ? "translate" : (kind as "rotate" | "translate" | "spin");
    if (type === "select") {
      ctx.animations.push({ type, nodes, condition: condition ?? { op: "const", value: true } });
      continue;
    }
    const value = parseValue(a, motion === "translate" ? "-m" : motion === "spin" ? "" : "-deg", warn);
    if (!value) continue;
    if (value.property) ctx.properties.add(value.property);
    if (value.expr) exprProperties(value.expr, ctx.properties);
    const axisNode = child(a, "axis");
    let center = [0, 0, 0];
    let axis: number[];
    if (axisNode && num(axisNode, "x1-m") !== undefined) {
      const p1 = [num(axisNode, "x1-m") ?? 0, num(axisNode, "y1-m") ?? 0, num(axisNode, "z1-m") ?? 0];
      const p2 = [num(axisNode, "x2-m") ?? 0, num(axisNode, "y2-m") ?? 0, num(axisNode, "z2-m") ?? 0];
      center = p1.map((v, i) => (v + p2[i]!) / 2);
      axis = p2.map((v, i) => v - p1[i]!);
    } else if (axisNode && child(axisNode, "object-name")) {
      // Axis given by a line object in the .ac (already in the top-level AC frame).
      const objName = text(axisNode, "object-name")!.trim();
      const line = lineObjects.get(objName);
      if (!line) {
        warn(`axis object not found: ${objName}`);
        continue;
      }
      const [p1, p2] = line;
      const c = child(a, "center");
      const centerTop = c ? xfPoint(own, fgToAc([num(c, "x-m") ?? 0, num(c, "y-m") ?? 0, num(c, "z-m") ?? 0])) : (p1.map((v, i) => (v + p2[i]!) / 2) as [number, number, number]);
      const axisTop = norm3(p2.map((v, i) => v - p1[i]!));
      if (motion === "translate") ctx.animations.push({ type: motion, nodes, value, axis: axisTop, ...(condition ? { condition } : {}) });
      else ctx.animations.push({ type: motion, nodes, value, center: centerTop, axis: axisTop, ...(condition ? { condition } : {}) });
      continue;
    } else {
      // Missing components are 0 (readVec3); only a missing <axis> defaults to +z for rotations.
      axis = axisNode ? [num(axisNode, "x") ?? 0, num(axisNode, "y") ?? 0, num(axisNode, "z") ?? 0] : motion === "translate" ? [0, 0, 0] : [0, 0, 1];
    }
    const c = child(a, "center");
    if (c) center = [num(c, "x-m") ?? center[0]!, num(c, "y-m") ?? center[1]!, num(c, "z-m") ?? center[2]!];
    // FG frame → this file's AC frame → top-level AC frame.
    const axisTop = norm3(xfDir(own, fgToAc(axis)));
    const centerTop = xfPoint(own, fgToAc(center));
    if (motion === "translate") ctx.animations.push({ type: motion, nodes, value, axis: axisTop, ...(condition ? { condition } : {}) });
    else ctx.animations.push({ type: motion, nodes, value, center: centerTop, axis: axisTop, ...(condition ? { condition } : {}) });
  }

  return group;
}

export function convertFgModel(aircraftDir: string, modelFile: string, resolver: FgResolver = new FgResolver(aircraftDir, path.basename(aircraftDir))): ConvertedModel {
  const ctx: Ctx = {
    aircraftDir,
    aircraftName: path.basename(aircraftDir),
    resolver,
    used: new Set(),
    texNodes: new Set(),
    materials: [],
    materialKeys: new Map(),
    images: [],
    imageKeys: new Map(),
    animations: [],
    properties: new Set(),
    warnings: [],
    stats: { objects: 0, triangles: 0, models: 0, skippedAnimations: {} },
  };
  const root = loadModel(ctx, modelFile, I4);
  if (!root) throw new Error(`could not load ${modelFile}`);
  // Texture-animated nodes: own material copies flagged for KHR_texture_transform, so the
  // renderer can move their UVs without affecting other objects sharing the texture.
  const visit = (n: SceneNode) => {
    for (const p of n.primitives) {
      const m = ctx.materials[p.material]!;
      if (m.image === undefined) continue;
      ctx.materials.push({ ...m, name: `${m.name}@${n.name}`, texTransform: true });
      p.material = ctx.materials.length - 1;
    }
    n.children.forEach(visit);
  };
  ctx.texNodes.forEach(visit);
  // Flatten to glTF node list.
  const nodes: GlbNode[] = [];
  const add = (n: SceneNode): number => {
    const i = nodes.length;
    nodes.push({ name: n.name, children: [], primitives: n.primitives });
    nodes[i]!.children = n.children.map(add);
    return i;
  };
  const rootIndex = add(root);
  const parents: Record<string, string> = {};
  for (const n of nodes) for (const c of n.children) parents[nodes[c]!.name] = n.name;
  return {
    nodes,
    roots: [rootIndex],
    materials: ctx.materials,
    images: ctx.images,
    animations: ctx.animations,
    properties: [...ctx.properties].sort(),
    parents,
    warnings: ctx.warnings,
    stats: ctx.stats,
  };
}
