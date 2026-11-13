/**
 * Evaluates the converter's animation manifest (SimGear semantics) into per-node
 * model-space matrices, visibility and texture (UV) matrices. No Cesium: testable in Node.
 *
 * - rotate: right-handed rotation about `axis` through `center` by value [deg]
 * - translate: offset along `axis` by value [m]
 * - spin: angle accumulates at value [rpm]
 * - select: node shown while the condition holds
 * - tex: texture translate/rotate (textranslate, texrotate, texmultiple)
 * Several transforms on one node compose in declaration order, first = outermost. A
 * rotate/translate/tex whose condition is false keeps its last value (as SimGear does).
 */
import { compileExpr, interp, type PropRef } from "@webflight/fg-host";
import type { AnimationEntry, Condition, Operand, PNode, ValueSpec } from "@webflight/fdm-core";

export type { AnimationEntry, Condition, Operand, ValueSpec };

export type PropertyGetter = (fgPath: string) => number | string | undefined;
export type PickEntry = Extract<AnimationEntry, { type: "pick" }>;
type TexEntry = Extract<AnimationEntry, { type: "tex" }>;

/** Column-major 4x4. */
export type Mat4 = Float64Array;
/** Column-major 3x3 (UV transform, glTF texture space). */
export type Mat3 = Float64Array;

const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};
const identity3 = (): Mat3 => {
  const m = new Float64Array(9);
  m[0] = m[4] = m[8] = 1;
  return m;
};

function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}
function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Float64Array(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k * 3 + r]! * b[c * 3 + k]!;
      out[c * 3 + r] = s;
    }
  return out;
}

/** Rotation by `deg` (right-handed) about unit `axis` through `center`. */
export function rotationAbout(center: readonly number[], axis: readonly number[], deg: number): Mat4 {
  const [x, y, z] = axis as [number, number, number];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  const m = identity();
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) m[col * 4 + r] = R[r * 3 + col]!;
  for (let r = 0; r < 3; r++) m[12 + r] = center[r]! - (R[r * 3]! * center[0]! + R[r * 3 + 1]! * center[1]! + R[r * 3 + 2]! * center[2]!);
  return m;
}

export function translation(axis: readonly number[], d: number): Mat4 {
  const m = identity();
  m[12] = axis[0]! * d;
  m[13] = axis[1]! * d;
  m[14] = axis[2]! * d;
  return m;
}

/**
 * UV transform for one FG texture step, in glTF texture space. FG texture coordinates have
 * v up; the converter wrote v' = 1 - v, so conjugate with that flip.
 */
export function texStep(t: TexEntry["transforms"][number], value: number): Mat3 {
  const m = identity3();
  if (t.kind === "translate") {
    m[6] = t.axis[0] * value;
    m[7] = -t.axis[1] * value;
    return m;
  }
  // Rotation about (cu, cv) in FG space → about (cu, 1 - cv) with the opposite sense.
  const a = (-value * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cu = t.center[0], cv = 1 - t.center[1];
  m[0] = c;
  m[1] = s;
  m[3] = -s;
  m[4] = c;
  m[6] = cu - (c * cu - s * cv);
  m[7] = cv - (s * cu + c * cv);
  return m;
}

const toNum = (v: number | string | undefined): number =>
  typeof v === "number" ? (Number.isFinite(v) ? v : 0) : v === undefined || v === "" ? 0 : Number.isFinite(Number(v)) ? Number(v) : 0;

function operand(o: Operand, get: PropertyGetter): number | string {
  if ("value" in o) return o.value;
  const v = get(o.prop);
  return v === undefined ? 0 : v;
}

export function testCondition(c: Condition, get: PropertyGetter): boolean {
  switch (c.op) {
    case "const": return c.value;
    case "and": return c.args.every((x) => testCondition(x, get));
    case "or": return c.args.some((x) => testCondition(x, get));
    case "not": return !testCondition(c.arg, get);
    case "prop": return toNum(get(c.prop)) !== 0;
    default: {
      const a = operand(c.a, get), b = operand(c.b, get);
      const bothNum = typeof a === "number" || typeof b === "number";
      const x = bothNum ? toNum(a) : a, y = bothNum ? toNum(b) : b;
      switch (c.op) {
        case "eq": return x === y;
        case "ne": return x !== y;
        case "lt": return x < y;
        case "gt": return x > y;
        case "le": return x <= y;
        case "ge": return x >= y;
      }
    }
  }
}

/** SGStepExpression::apply_mods. */
function stepScroll(v: number, step: number, scroll: number): number {
  if (step <= Number.MIN_VALUE) return v;
  let mod = Math.floor(v / step) * step;
  const rem = v <= Number.MIN_VALUE ? -(v % step) : step - (v % step);
  if (rem > Number.MIN_VALUE && rem < scroll) mod += ((scroll - rem) / scroll) * step;
  return mod;
}

/**
 * SimGear value evaluation: table → (bias, step); otherwise (bias, step) → factor/offset →
 * clip. Without bias/step this is the plain rotate/translate rule.
 */
export function evaluateValue(v: ValueSpec, get: PropertyGetter, expr?: () => number): number {
  if (expr) return expr();
  let x = v.property ? toNum(get(v.property)) : v.start;
  if (v.table && v.table.length > 0) {
    x = interp(v.table, x);
    if (v.bias) x += v.bias;
    if (v.step) x = stepScroll(x, v.step, v.scroll ?? 0);
    return x;
  }
  if (v.bias) x += v.bias;
  if (v.step) x = stepScroll(x, v.step, v.scroll ?? 0);
  let out = x * v.factor + v.offset;
  if (v.min !== undefined) out = Math.max(v.min, out);
  if (v.max !== undefined) out = Math.min(v.max, out);
  return out;
}

export interface NodeState {
  /** Model-space transform for the node (relative to its parent, whose own transform is identity). */
  matrix: Mat4;
  show: boolean;
  /** UV transform for the node's textured primitives (glTF texture space), if animated. */
  uv?: Mat3;
}

const normProp = (p: string) => ("/" + p.trim()).replace(/^\/+/, "/").replace(/\[0\]/g, "");

export class AnimationRig {
  private readonly perNode = new Map<string, number[]>();
  private readonly last: number[];
  private readonly lastTex: number[][];
  private readonly spinAngle: number[];
  private readonly exprs: ((() => number) | undefined)[][];
  private get: PropertyGetter = () => undefined;
  readonly state = new Map<string, NodeState>();
  /** pick/knob/slider entries by node name. */
  readonly picks = new Map<string, PickEntry[]>();

  constructor(readonly animations: readonly AnimationEntry[]) {
    // Expressions read the current getter through a read-only tree adapter.
    const tree = {
      node: (path: string): PropRef => {
        const p = normProp(path);
        const val = () => this.get(p);
        return {
          path: p,
          get: () => val(),
          set: () => {},
          num: () => toNum(val()),
          bool: () => toNum(val()) !== 0,
          str: () => String(val() ?? ""),
          get exists() {
            return val() !== undefined;
          },
        };
      },
    };
    const ctx = { tree, warn: (m: string) => console.warn(`animation: ${m}`) };
    this.exprs = animations.map((a) => {
      if (a.type === "rotate" || a.type === "translate" || a.type === "spin") return [a.value.expr ? compileExpr(a.value.expr, ctx) : undefined];
      if (a.type === "tex") return a.transforms.map((t) => (t.value.expr ? compileExpr(t.value.expr, ctx) : undefined));
      return [];
    });
    animations.forEach((a, i) => {
      if (a.type === "pick") {
        for (const n of a.nodes) (this.picks.get(n) ?? this.picks.set(n, []).get(n)!).push(a);
        return;
      }
      for (const n of a.nodes) (this.perNode.get(n) ?? this.perNode.set(n, []).get(n)!).push(i);
    });
    this.last = animations.map(() => 0);
    this.lastTex = animations.map((a) => (a.type === "tex" ? a.transforms.map((t) => t.value.start) : []));
    this.spinAngle = animations.map(() => 0);
    for (const [n, list] of this.perNode) {
      const hasTex = list.some((i) => animations[i]!.type === "tex");
      this.state.set(n, { matrix: identity(), show: true, ...(hasTex ? { uv: identity3() } : {}) });
    }
  }

  get nodeNames(): string[] {
    return [...this.perNode.keys()];
  }

  /** Every property read by any animation (including inside expressions). */
  get properties(): string[] {
    const out = new Set<string>();
    const walk = (c: Condition | undefined) => {
      if (!c) return;
      if (c.op === "prop") out.add(c.prop);
      else if (c.op === "and" || c.op === "or") c.args.forEach(walk);
      else if (c.op === "not") walk(c.arg);
      else if ("a" in c) for (const o of [c.a, c.b]) if ("prop" in o) out.add(o.prop);
    };
    const exprProps = (p: PNode | undefined) => {
      if (!p) return;
      if (p.n === "property" && p.v?.trim()) out.add(normProp(p.v));
      p.c?.forEach(exprProps);
    };
    const value = (v: ValueSpec) => {
      if (v.property) out.add(v.property);
      exprProps(v.expr);
    };
    for (const a of this.animations) {
      if (a.type === "pick") continue;
      if (a.type !== "select") walk(a.condition);
      else walk(a.condition);
      if (a.type === "tex") a.transforms.forEach((t) => value(t.value));
      else if (a.type !== "select") value(a.value);
    }
    return [...out].sort();
  }

  update(get: PropertyGetter, dtSec: number): void {
    this.get = get;
    const per: (Mat4 | Mat3 | boolean | undefined)[] = this.animations.map((a, i) => {
      if (a.type === "pick") return undefined;
      if (a.type === "select") return testCondition(a.condition, get);
      const active = !a.condition || testCondition(a.condition, get);
      if (a.type === "tex") {
        let m = identity3();
        a.transforms.forEach((t, k) => {
          if (active) this.lastTex[i]![k] = evaluateValue(t.value, get, this.exprs[i]![k]);
          m = multiply3(m, texStep(t, this.lastTex[i]![k]!));
        });
        return m;
      }
      if (a.type === "spin") {
        if (active) this.spinAngle[i] = (this.spinAngle[i]! + evaluateValue(a.value, get, this.exprs[i]![0]) * 6 * dtSec) % 360;
        return rotationAbout(a.center, a.axis, this.spinAngle[i]!);
      }
      if (active) this.last[i] = evaluateValue(a.value, get, this.exprs[i]![0]);
      return a.type === "rotate" ? rotationAbout(a.center, a.axis, this.last[i]!) : translation(a.axis, this.last[i]!);
    });
    for (const [node, list] of this.perNode) {
      const st = this.state.get(node)!;
      let m = identity();
      let uv: Mat3 | undefined = st.uv ? identity3() : undefined;
      let show = true;
      for (const i of list) {
        const p = per[i];
        const type = this.animations[i]!.type;
        if (typeof p === "boolean") show &&= p;
        else if (type === "tex" && p && uv) uv = multiply3(uv, p);
        else if (p) m = multiply(m, p);
      }
      st.matrix = m;
      st.show = show;
      if (uv) st.uv = uv;
    }
  }
}
