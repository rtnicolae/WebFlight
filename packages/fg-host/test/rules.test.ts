import { describe, expect, it } from "vitest";
import { compileCondition, compileExpr, compileValue } from "../src/expr.ts";
import type { PNode } from "../src/plist.ts";
import { PropertyTree } from "../src/props.ts";
import { PropertyRules } from "../src/rules.ts";

/** Tiny builder: el("sum", [el("value", "1"), ...]) */
let counters = new Map<string, number>();
function el(n: string, body?: string | PNode[]): PNode {
  return typeof body === "string" ? { n, i: 0, v: body } : { n, i: 0, ...(body ? { c: reindex(body) } : {}) };
}
function reindex(cs: PNode[]): PNode[] {
  counters = new Map();
  return cs.map((c) => {
    const i = counters.get(c.n) ?? 0;
    counters.set(c.n, i + 1);
    return { ...c, i };
  });
}
const ctx = (tree = new PropertyTree()) => ({ tree, warn: (m: string) => { throw new Error(m); } });

describe("expressions", () => {
  it("evaluates nested SGExpressions with tables", () => {
    const c = ctx();
    c.tree.set("/a", 3);
    const f = compileExpr(
      el("product", [
        el("property", "/a"),
        el("difference", [el("value", "10"), el("value", "4"), el("value", "1")]),
        el("table", [el("property", "/a"), el("entry", [el("ind", "0"), el("dep", "0")]), el("entry", [el("ind", "10"), el("dep", "1")])]),
      ]),
      c,
    );
    expect(f()).toBeCloseTo(3 * 5 * 0.3, 12);
    expect(compileExpr(el("div", [el("value", "1"), el("max", [el("property", "/zero"), el("value", "0.0001")])]), c)()).toBeCloseTo(10000, 6);
  });

  it("evaluates conditions like SGCondition, including string and precision compares", () => {
    const c = ctx();
    c.tree.set("/sim/flight-model", "jsb");
    c.tree.set("/x", 0.501);
    const cond = (k: PNode[]) => compileCondition(el("condition", k), c)();
    expect(cond([el("equals", [el("property", "/sim/flight-model"), el("value", "jsb")])])).toBe(true);
    expect(cond([el("equals", [el("property", "/x"), el("value", "0.5"), el("precision-value", "0.01")])])).toBe(true);
    expect(cond([el("or", [el("property", "/nope"), el("not", [el("property", "/nope")])])])).toBe(true);
    expect(cond([el("property", "/x"), el("less-than", [el("property", "/x"), el("value", "0.5")])])).toBe(false);
  });

  it("InputValue applies scale, offset, min, max, abs and writes <value> into its property", () => {
    const c = ctx();
    c.tree.set("/p", -4);
    const v = compileValue(el("input", [el("property", "/p"), el("scale", "2"), el("offset", "1"), el("min", "-5"), el("abs", "true")]), c);
    expect(v.get()).toBe(5);
    compileValue(el("input", [el("property", "/q"), el("value", "7")]), c);
    expect(c.tree.num("/q")).toBe(7);
  });
});

describe("property rules", () => {
  it("runs gain filters with conditional inputs, noise-spike and moving-average", () => {
    const tree = new PropertyTree();
    tree.set("/in", 10);
    tree.set("/broken", 0);
    const rules = new PropertyRules(
      "test",
      el("PropertyList", [
        el("filter", [
          el("type", "gain"), el("gain", "2"),
          el("input", [el("condition", [el("property", "/broken")]), el("value", "0")]),
          el("input", "/in"),
          el("output", "/out"),
        ]),
        el("filter", [el("type", "noise-spike"), el("max-rate-of-change", "1"), el("input", "/in"), el("output", "/spike"), el("initialize-to", "none")]),
        el("filter", [el("type", "moving-average"), el("samples", "4"), el("input", "/in"), el("output", "/avg")]),
      ]),
      tree,
      (m) => { throw new Error(m); },
    );
    rules.update(0.5);
    expect(tree.num("/out")).toBe(20);
    expect(tree.num("/spike")).toBeCloseTo(0.5, 12); // 1/s from 0
    expect(tree.num("/avg")).toBe(10);
    tree.set("/broken", 1);
    tree.set("/in", 14);
    rules.update(0.5);
    expect(tree.num("/out")).toBe(0);
    expect(tree.num("/spike")).toBeCloseTo(1, 12);
    expect(tree.num("/avg")).toBe(11); // (14 + 10 + 10 + 10) / 4
  });

  it("supports enable conditions and logic", () => {
    const tree = new PropertyTree();
    tree.set("/a", 1);
    const rules = new PropertyRules(
      "t",
      el("PropertyList", [
        el("logic", [el("input", [el("greater-than", [el("property", "/a"), el("value", "0")])]), el("output", "/flag")]),
        el("filter", [el("type", "gain"), el("enable", [el("condition", [el("property", "/flag")])]), el("input", "/a"), el("output", "/b")]),
      ]),
      tree,
    );
    rules.update(0.1);
    expect(tree.bool("/flag")).toBe(true);
    expect(tree.num("/b")).toBe(1);
  });
});
