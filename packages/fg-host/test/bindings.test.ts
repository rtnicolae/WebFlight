import { describe, expect, it } from "vitest";
import { runAction } from "../src/bindings.ts";
import type { PNode } from "../src/plist.ts";
import { PropertyTree } from "../src/props.ts";

const el = (n: string, body?: string | PNode[], i = 0): PNode => (typeof body === "string" ? { n, i, v: body } : { n, i, ...(body ? { c: body } : {}) });
const binding = (...c: PNode[]) => el("binding", c);

describe("bindings", () => {
  const tree = new PropertyTree();
  const host = { ctx: { tree, warn: () => {} }, runNasal: (s: string) => s.startsWith("ported."), interpolate: () => {} };

  it("toggles, assigns, adjusts with clamping and knob offset, cycles, and honours conditions", () => {
    const action = el("action", [
      binding(el("command", "property-toggle"), el("property", "/sw")),
      binding(el("command", "property-assign"), el("property", "/a"), el("value", "3")),
      binding(el("command", "property-adjust"), el("property", "/k"), el("factor", "0.05"), el("min", "0"), el("max", "0.1")),
      binding(el("condition", [el("property", "/never")]), el("command", "property-assign"), el("property", "/b"), el("value", "1")),
      binding(el("command", "property-cycle"), el("property", "/c"), el("value", "0", 0), el("value", "1", 1), el("value", "2", 2)),
    ]);
    expect(runAction(action, host, "down", { offset: 1 })).toEqual([]);
    runAction(action, host, "down", { offset: 1 });
    runAction(action, host, "down", { offset: 1 });
    expect(tree.bool("/sw")).toBe(true); // toggled 3 times
    expect(tree.num("/a")).toBe(3);
    expect(tree.num("/k")).toBeCloseTo(0.1, 12); // clamped at max
    expect(tree.get("/b")).toBeUndefined();
    expect(tree.num("/c")).toBe(2); // unset → first value "0", then 1, then 2
  });

  it("reports Nasal bindings without a TS port", () => {
    const a = el("action", [binding(el("command", "nasal"), el("script", "unknown.thing();"))]);
    expect(runAction(a, host, "down")[0]).toMatch(/Nasal not ported/);
  });
});
