/**
 * SimGear expressions (simgear/structure/SGExpression.cxx), conditions
 * (simgear/props/condition.cxx) and InputValues (simgear/misc/inputvalue.cxx),
 * compiled from PropertyList JSON into closures over a PropertyTree.
 */
import { kid, kids, kidText, parseBool, text, type PNode } from "./plist.ts";
import { toNumber, type PropRef, type PropValue } from "./props.ts";

export type NumFn = () => number;
export type BoolFn = () => boolean;

/** What compilation needs from a tree: node lookup (PropertyTree, or a read-only adapter). */
export interface TreeLike {
  node(path: string): PropRef;
}

export interface CompileContext {
  tree: TreeLike;
  warn(msg: string): void;
}

const UNARY: Record<string, (x: number) => number> = {
  abs: Math.abs, fabs: Math.abs, sqr: (x) => x * x, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  ceil: Math.ceil, floor: Math.floor, exp: Math.exp, log: Math.log, log10: Math.log10,
  deg2rad: (x) => (x * Math.PI) / 180, rad2deg: (x) => (x * 180) / Math.PI,
};
const BINARY: Record<string, (a: number, b: number) => number> = {
  div: (a, b) => a / b, mod: (a, b) => a % b, atan2: Math.atan2, pow: Math.pow,
};
const NARY: Record<string, (xs: number[]) => number> = {
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  difference: (xs) => xs.slice(1).reduce((a, b) => a - b, xs[0] ?? 0),
  dif: (xs) => xs.slice(1).reduce((a, b) => a - b, xs[0] ?? 0),
  prod: (xs) => xs.reduce((a, b) => a * b, 1),
  product: (xs) => xs.reduce((a, b) => a * b, 1),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
};

/** Interpolation table [ind, dep] as SGInterpTable (clamped at the ends). */
export function interp(table: readonly (readonly [number, number])[], x: number, nearest = false): number {
  if (table.length === 0) return 0;
  if (x <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    if (x <= x1) {
      const [x0, y0] = table[i - 1]!;
      if (nearest) return x - x0 < x1 - x ? y0 : y1;
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return table[table.length - 1]![1];
}

export function readTable(p: PNode): [number, number][] {
  return kids(p, "entry").map((e) => [toNumber(kidText(e, "ind")), toNumber(kidText(e, "dep"))]);
}

/** Compile one expression element (e.g. <sum>, <property>, <table>). */
export function compileExpr(p: PNode, ctx: CompileContext): NumFn {
  const name = p.n;
  if (name === "value") {
    const v = toNumber(text(p));
    return () => v;
  }
  if (name === "property") {
    const ref = ctx.tree.node(text(p));
    return () => ref.num();
  }
  const args = () => kids(p).map((c) => compileExpr(c, ctx));
  if (UNARY[name]) {
    const f = UNARY[name], [a] = args();
    if (!a) return warnZero(ctx, `<${name}> without operand`);
    return () => f(a());
  }
  if (BINARY[name]) {
    const f = BINARY[name], [a, b] = args();
    if (!a || !b) return warnZero(ctx, `<${name}> needs two operands`);
    return () => f(a(), b());
  }
  if (NARY[name]) {
    const f = NARY[name], xs = args();
    return () => f(xs.map((x) => x()));
  }
  if (name === "clip") {
    const lo = toNumber(kidText(p, "clipMin") ?? String(-Number.MAX_VALUE));
    const hi = kidText(p, "clipMax") !== undefined ? toNumber(kidText(p, "clipMax")) : Number.MAX_VALUE;
    const inNode = kids(p).find((c) => c.n !== "clipMin" && c.n !== "clipMax");
    if (!inNode) return warnZero(ctx, "<clip> without input");
    const f = compileExpr(inNode, ctx);
    return () => Math.min(hi, Math.max(lo, f()));
  }
  if (name === "table") {
    const table = readTable(p);
    const nearest = kidText(p, "mode") === "nearest";
    const inNode = kids(p).find((c) => c.n !== "entry" && c.n !== "mode");
    if (!inNode) return warnZero(ctx, "<table> without input");
    const f = compileExpr(inNode, ctx);
    return () => interp(table, f(), nearest);
  }
  return warnZero(ctx, `expression <${name}> not supported`);
}

function warnZero(ctx: CompileContext, msg: string): NumFn {
  ctx.warn(msg);
  return () => 0;
}

// ---------------------------------------------------------------------------------------
// Conditions

type Operand = () => PropValue | undefined;

function operand(p: PNode, ctx: CompileContext): Operand {
  if (p.n === "property") {
    const ref = ctx.tree.node(text(p));
    return () => ref.get();
  }
  if (p.n === "value") {
    const raw = text(p);
    const asNum = Number(raw);
    const v: PropValue = raw !== "" && Number.isFinite(asNum) ? asNum : raw;
    return () => v;
  }
  if (p.n === "expression") {
    const c = p.c?.[0];
    if (!c) return () => 0;
    const f = compileExpr(c, ctx);
    return () => f();
  }
  ctx.warn(`condition operand <${p.n}> not supported`);
  return () => 0;
}

/** -1, 0, 1 like SGComparisonCondition::doComparison: numeric if possible, else string. */
function compare(a: PropValue | undefined, b: PropValue | undefined, precision: number | undefined): number {
  const numeric = (v: PropValue | undefined) => typeof v === "number" || typeof v === "boolean" || v === undefined || (v.trim() !== "" && Number.isFinite(Number(v)));
  if (numeric(a) && numeric(b)) {
    let x = toNumber(a), y = toNumber(b);
    if (precision !== undefined && precision > 0) {
      x = Math.round(x / precision) * precision;
      y = Math.round(y / precision) * precision;
    }
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = String(a ?? ""), y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

const CMP: Record<string, (c: number) => boolean> = {
  "less-than": (c) => c < 0, "less-than-equals": (c) => c <= 0, "greater-than": (c) => c > 0,
  "greater-than-equals": (c) => c >= 0, equals: (c) => c === 0, "not-equals": (c) => c !== 0,
};

function compileConditionElement(p: PNode, ctx: CompileContext): BoolFn {
  switch (p.n) {
    case "property": {
      const ref = ctx.tree.node(text(p));
      return () => ref.bool();
    }
    case "true": return () => true;
    case "false": return () => false;
    case "not": {
      const f = compileCondition(p, ctx);
      return () => !f();
    }
    case "and": {
      const fs = kids(p).map((c) => compileConditionElement(c, ctx));
      return () => fs.every((f) => f());
    }
    case "or": {
      const fs = kids(p).map((c) => compileConditionElement(c, ctx));
      return () => fs.some((f) => f());
    }
  }
  const test = CMP[p.n];
  if (test) {
    const [l, r, prec] = kids(p);
    if (!l || !r) {
      ctx.warn(`<${p.n}> needs two operands`);
      return () => false;
    }
    const a = operand(l, ctx), b = operand(r, ctx);
    const pr = prec ? operand({ ...prec, n: prec.n.replace(/^precision-/, "") }, ctx) : undefined;
    return () => test(compare(a(), b(), pr ? toNumber(pr()) : undefined));
  }
  ctx.warn(`condition <${p.n}> not supported (false)`);
  return () => false;
}

/** A <condition> (or <not>) element: children are AND-ed. */
export function compileCondition(p: PNode, ctx: CompileContext): BoolFn {
  const fs = kids(p).map((c) => compileConditionElement(c, ctx));
  return () => fs.every((f) => f());
}

// ---------------------------------------------------------------------------------------
// InputValue (simgear::Value): <input>, <gain>, <min>, ... in property rules

export interface InputValue {
  get(): number;
  enabled(): boolean;
  /** Write through to the property (inverse of scale/offset), if property-backed. */
  set(v: number): void;
}

export function compileValue(p: PNode, ctx: CompileContext, def = 0, defOffset = 0, defScale = 1): InputValue {
  const cond = kid(p, "condition");
  const enabled = cond ? compileCondition(cond, ctx) : () => true;
  const sub = (name: string, d: number) => {
    const k = kid(p, name);
    return k ? compileValue(k, ctx, d) : undefined;
  };
  const scale = sub("scale", defScale);
  const offset = sub("offset", defOffset);
  const max = sub("max", 0);
  const min = sub("min", 0);
  const abs = kidText(p, "abs") !== undefined && parseBool(kidText(p, "abs")!);
  const period = kid(p, "period");
  const pmin = period ? compileValue(kid(period, "min") ?? { n: "min", i: 0, v: "0" }, ctx) : undefined;
  const pmax = period ? compileValue(kid(period, "max") ?? { n: "max", i: 0, v: "0" }, ctx) : undefined;
  let value = def;
  const valueNode = kid(p, "value");
  if (valueNode) value = toNumber(text(valueNode));

  let source: NumFn | undefined;
  let ref: PropRef | undefined;
  const exprNode = kid(p, "expression");
  const propNode = kid(p, "property") ?? kid(p, "prop");
  if (exprNode?.c?.[0]) source = compileExpr(exprNode.c[0], ctx);
  else if (propNode) {
    ref = ctx.tree.node(text(propNode));
    if (valueNode) {
      const s = scale?.get() ?? 1;
      ref.set(s !== 0 ? (value - (offset?.get() ?? 0)) / s : 0);
    }
  } else if (!p.c?.length && text(p) !== "") {
    // Text-only node: a number, or a property path.
    const t = text(p);
    const x = Number(t);
    if (Number.isFinite(x)) value = x;
    else ref = ctx.tree.node(t);
  }
  const base: NumFn = source ?? (ref ? () => ref!.num() : () => value);
  return {
    enabled,
    get() {
      let v = base();
      if (scale) v *= scale.get();
      if (offset) v += offset.get();
      if (min) v = Math.max(v, min.get());
      if (max) v = Math.min(v, max.get());
      if (pmin && pmax) {
        const lo = pmin.get(), hi = pmax.get(), w = hi - lo;
        if (w > 0) v = ((((v - lo) % w) + w) % w) + lo;
      }
      return abs ? Math.abs(v) : v;
    },
    set(v: number) {
      if (!ref) return;
      const s = scale?.get() ?? 1;
      ref.set(s !== 0 ? (v - (offset?.get() ?? 0)) / s : 0);
    },
  };
}

/** simgear::ValueList: the first enabled value wins; `def` if none. */
export class ValueList {
  readonly items: InputValue[] = [];
  constructor(private readonly def = 0) {}
  get active(): InputValue | undefined {
    return this.items.find((v) => v.enabled());
  }
  get(): number {
    const a = this.active;
    return a ? a.get() : this.def;
  }
  get size(): number {
    return this.items.length;
  }
}
