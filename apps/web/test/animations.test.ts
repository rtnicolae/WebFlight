import { describe, expect, it } from "vitest";
import { AnimationRig, evaluateValue, rotationAbout, testCondition, type AnimationEntry } from "../src/animations.ts";

const apply = (m: Float64Array, v: number[]) => [0, 1, 2].map((r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]!);
const round = (v: number[]) => v.map((x) => Math.round(x * 1e9) / 1e9 + 0);

describe("animation values", () => {
  it("applies factor, offset and clamps; tables ignore factor", () => {
    const get = () => 0.5;
    expect(evaluateValue({ property: "/p", start: 0, factor: -24, offset: 2 }, get)).toBe(-10);
    expect(evaluateValue({ property: "/p", start: 0, factor: 100, offset: 0, max: 30 }, get)).toBe(30);
    expect(evaluateValue({ property: "/p", start: 0, factor: 100, offset: 0, table: [[0, 0], [1, 10]] }, get)).toBe(5);
    expect(evaluateValue({ start: 7, factor: 2, offset: 0 }, get)).toBe(14);
  });

  it("evaluates SimGear conditions", () => {
    const props: Record<string, number | string> = { "/sim/model/variant": 0, "/w": 5 };
    const get = (p: string) => props[p];
    expect(testCondition({ op: "eq", a: { prop: "/sim/model/variant" }, b: { value: 1 } }, get)).toBe(false);
    expect(testCondition({ op: "ne", a: { prop: "/sim/model/variant" }, b: { value: 1 } }, get)).toBe(true);
    expect(testCondition({ op: "and", args: [{ op: "gt", a: { prop: "/w" }, b: { value: 4.4 } }, { op: "prop", prop: "/missing" }] }, get)).toBe(false);
    expect(testCondition({ op: "or", args: [{ op: "prop", prop: "/missing" }, { op: "not", arg: { op: "prop", prop: "/missing" } }] }, get)).toBe(true);
  });
});

describe("AnimationRig", () => {
  it("rotates right-handed about an axis through a centre", () => {
    const m = rotationAbout([1, 0, 0], [0, 0, 1], 90);
    expect(round(apply(m, [2, 0, 0]))).toEqual([1, 1, 0]);
  });

  it("composes animations on a node in declaration order and ANDs selects", () => {
    const anims: AnimationEntry[] = [
      { type: "translate", nodes: ["a"], value: { property: "/t", start: 0, factor: 1, offset: 0 }, axis: [1, 0, 0] },
      { type: "rotate", nodes: ["a"], value: { property: "/r", start: 0, factor: 1, offset: 0 }, center: [0, 0, 0], axis: [0, 0, 1] },
      { type: "select", nodes: ["a"], condition: { op: "prop", prop: "/s" } },
    ];
    const rig = new AnimationRig(anims);
    const props: Record<string, number> = { "/t": 10, "/r": 90, "/s": 1 };
    rig.update((p) => props[p], 0.016);
    const st = rig.state.get("a")!;
    // First (translate) is outermost: v' = T(R(v)).
    expect(round(apply(st.matrix, [1, 0, 0]))).toEqual([10, 1, 0]);
    expect(st.show).toBe(true);
    props["/s"] = 0;
    rig.update((p) => props[p], 0.016);
    expect(rig.state.get("a")!.show).toBe(false);
  });

  it("holds the last value while a condition is false, and spins from rpm", () => {
    const anims: AnimationEntry[] = [
      { type: "rotate", nodes: ["a"], value: { property: "/r", start: 0, factor: 1, offset: 0 }, center: [0, 0, 0], axis: [0, 0, 1], condition: { op: "prop", prop: "/on" } },
      { type: "spin", nodes: ["b"], value: { property: "/rpm", start: 0, factor: 1, offset: 0 }, center: [0, 0, 0], axis: [0, 0, 1] },
    ];
    const rig = new AnimationRig(anims);
    const props: Record<string, number> = { "/r": 90, "/on": 1, "/rpm": 10 };
    rig.update((p) => props[p], 1); // spin: 10 rpm = 60 deg/s
    props["/r"] = 0;
    props["/on"] = 0;
    rig.update((p) => props[p], 0.5);
    expect(round(apply(rig.state.get("a")!.matrix, [1, 0, 0]))).toEqual([0, 1, 0]);
    const b = apply(rig.state.get("b")!.matrix, [1, 0, 0]);
    expect(Math.atan2(b[1]!, b[0]!) * (180 / Math.PI)).toBeCloseTo(90, 6);
  });
});
