import { describe, expect, it } from "vitest";
import { geodeticToEcef, modelMatrixEcef, SnapshotLayout, SnapshotReader, SnapshotWriter, snapshotBytes, structuralToBodyFt } from "../src/index.ts";

const deg = Math.PI / 180;
/** Apply a column-major 4x4 to a point. */
const xf = (m: Float64Array, v: number[]) => [0, 1, 2].map((r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]!);
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);

describe("modelMatrixEcef", () => {
  const base = { latGeodRad: 0, lonRad: 0, geodAltFt: 0, phiRad: 0, thetaRad: 0, psiRad: 0, vrpBodyFt: [0, 0, 0] };

  it("level, heading north at 0N 0E: nose → north, AC +y → up, right wing → east", () => {
    const m = modelMatrixEcef(base);
    const o = xf(m, [0, 0, 0]);
    expect(o[0]).toBeCloseTo(6378137, 3);
    // AC axes: x aft, y up, z left.
    expect(sub(xf(m, [-1, 0, 0]), o).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]); // nose: +Z (north)
    expect(sub(xf(m, [0, 1, 0]), o).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0]); // up: +X
    expect(sub(xf(m, [0, 0, -1]), o).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0]); // right: +Y (east)
  });

  it("heading east turns the nose to east; positive pitch raises it; positive roll drops the right wing", () => {
    const o = xf(modelMatrixEcef({ ...base, psiRad: 90 * deg }), [0, 0, 0]);
    expect(sub(xf(modelMatrixEcef({ ...base, psiRad: 90 * deg }), [-1, 0, 0]), o)[1]).toBeCloseTo(1, 9);
    expect(sub(xf(modelMatrixEcef({ ...base, thetaRad: 10 * deg }), [-1, 0, 0]), o)[0]).toBeCloseTo(Math.sin(10 * deg), 9);
    expect(sub(xf(modelMatrixEcef({ ...base, phiRad: 10 * deg }), [0, 0, -1]), o)[0]).toBeCloseTo(-Math.sin(10 * deg), 9);
  });

  it("places the model origin at the VRP, offset from the CG in body axes", () => {
    // VRP 1 ft ahead of the CG (structural x is aft, so VRP x is smaller).
    const vrp = structuralToBodyFt([-12, 0, 0], [0, 0, 0]);
    expect(vrp).toEqual([1, 0, -0]);
    const o = xf(modelMatrixEcef({ ...base, vrpBodyFt: vrp }), [0, 0, 0]);
    expect(o[2]).toBeCloseTo(0.3048, 9); // north of the CG
  });

  it("matches WGS84 reference points (equator radius a, polar radius b)", () => {
    expect(geodeticToEcef(0, 0, 0)).toEqual([6378137, 0, 0]);
    const [x, y, z] = geodeticToEcef(90 * deg, 0, 100);
    expect(Math.hypot(x, y)).toBeLessThan(1e-6);
    expect(z).toBeCloseTo(6356752.314245 + 100, 5);
  });
});

describe("snapshot", () => {
  it("round-trips values through a shared buffer", () => {
    const layout = SnapshotLayout.withExtras(["fcs/elevator-pos-norm"]);
    const buf = new SharedArrayBuffer(snapshotBytes(layout.names.length));
    const w = new SnapshotWriter(buf, layout);
    const r = new SnapshotReader(buf, layout);
    expect(r.read()).toBe(false);
    w.write((n) => (n === "fcs/elevator-pos-norm" ? 0.25 : 1));
    expect(r.read()).toBe(true);
    expect(r.get("fcs/elevator-pos-norm")).toBe(0.25);
    expect(r.get("position/geod-alt-ft")).toBe(1);
    expect(r.read()).toBe(false);
  });
});
