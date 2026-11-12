/**
 * Evaluates the converter's animation manifest (SimGear semantics) into per-node
 * model-space matrices and visibility. Pure TypeScript: no Cesium, testable in Node.
 *
 * - rotate: right-handed rotation about `axis` through `center` by value [deg]
 * - translate: offset along `axis` by value [m]
 * - spin: angle accumulates at value [rpm]
 * - select: node shown while the condition holds
 * Several animations on one node compose in declaration order, first = outermost.
 * A rotate/translate whose condition is false keeps its last value (as SimGear does).
 */

import type { AnimationEntry, Condition, Operand, ValueSpec } from "@webflight/fdm-core";

export type { AnimationEntry, Condition, Operand, ValueSpec };

export type PropertyGetter = (fgPath: string) => number | string | undefined;

/** Column-major 4x4. */
export type Mat4 = Float64Array;

const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
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

/** Rotation by `deg` (right-handed) about unit `axis` through `center`. */
export function rotationAbout(center: readonly number[], axis: readonly number[], deg: number): Mat4 {
  const [x, y, z] = axis as [number, number, number];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]; // row-major
  const m = identity();
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) m[col * 4 + r] = R[r * 3 + col]!;
  // translation = c - R c
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

const toNum = (v: number | string | undefined): number => (typeof v === "number" ? v : v === undefined || v === "" ? 0 : Number.isFinite(Number(v)) ? Number(v) : 0);

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

export function evaluateValue(v: ValueSpec, get: PropertyGetter): number {
  const input = v.property ? toNum(get(v.property)) : v.start;
  if (v.table && v.table.length > 0) {
    const t = v.table;
    if (input <= t[0]![0]) return t[0]![1];
    for (let i = 1; i < t.length; i++) {
      if (input <= t[i]![0]) {
        const [x0, y0] = t[i - 1]!, [x1, y1] = t[i]!;
        return x1 === x0 ? y1 : y0 + ((input - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return t[t.length - 1]![1];
  }
  let out = input * v.factor + v.offset;
  if (v.min !== undefined) out = Math.max(v.min, out);
  if (v.max !== undefined) out = Math.min(v.max, out);
  return out;
}

export interface NodeState {
  /** Model-space transform for the node (relative to its parent, whose own transform is identity). */
  matrix: Mat4;
  show: boolean;
}

export class AnimationRig {
  /** Animations per node, in declaration order. */
  private readonly perNode = new Map<string, number[]>();
  private readonly last: number[];
  private readonly spinAngle: number[];
  readonly state = new Map<string, NodeState>();

  constructor(readonly animations: readonly AnimationEntry[]) {
    animations.forEach((a, i) => {
      for (const n of a.nodes) (this.perNode.get(n) ?? this.perNode.set(n, []).get(n)!).push(i);
    });
    this.last = animations.map(() => 0);
    this.spinAngle = animations.map(() => 0);
    for (const n of this.perNode.keys()) this.state.set(n, { matrix: identity(), show: true });
  }

  get nodeNames(): string[] {
    return [...this.perNode.keys()];
  }

  /** Every property read by any animation. */
  get properties(): string[] {
    const out = new Set<string>();
    const walk = (c: Condition | undefined) => {
      if (!c) return;
      if (c.op === "prop") out.add(c.prop);
      else if (c.op === "and" || c.op === "or") c.args.forEach(walk);
      else if (c.op === "not") walk(c.arg);
      else if ("a" in c) for (const o of [c.a, c.b]) if ("prop" in o) out.add(o.prop);
    };
    for (const a of this.animations) {
      walk(a.condition);
      if (a.type !== "select" && a.value.property) out.add(a.value.property);
    }
    return [...out].sort();
  }

  update(get: PropertyGetter, dtSec: number): void {
    // Per-animation transform for this frame.
    const per: (Mat4 | boolean)[] = this.animations.map((a, i) => {
      if (a.type === "select") return testCondition(a.condition, get);
      const active = !a.condition || testCondition(a.condition, get);
      if (a.type === "spin") {
        if (active) this.spinAngle[i] = (this.spinAngle[i]! + evaluateValue(a.value, get) * 6 * dtSec) % 360; // rpm → deg/s
        return rotationAbout(a.center, a.axis, this.spinAngle[i]!);
      }
      if (active) this.last[i] = evaluateValue(a.value, get);
      return a.type === "rotate" ? rotationAbout(a.center, a.axis, this.last[i]!) : translation(a.axis, this.last[i]!);
    });
    for (const [node, list] of this.perNode) {
      const st = this.state.get(node)!;
      let m = identity();
      let show = true;
      for (const i of list) {
        const p = per[i]!;
        if (typeof p === "boolean") show &&= p;
        else m = multiply(m, p);
      }
      st.matrix = m;
      st.show = show;
    }
  }
}
