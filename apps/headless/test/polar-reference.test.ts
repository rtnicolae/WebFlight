import { beforeAll, describe, expect, it } from "vitest";
import { Fdm, LBS_PER_KG, P } from "@webflight/fdm-core";
import { loadJsbsimFiles } from "@webflight/converter";
import { ASK21, ensureAircraft } from "../src/gliders.ts";
import { trimmedPolar, type PolarPoint } from "../src/glide.ts";

/** Sink at speed v from a 1 km/h trimmed polar (linear between the two speeds round it). */
const sinkAt = (pts: PolarPoint[], v: number) => {
  const i = pts.findIndex((p) => p.easKmh >= v);
  const a = pts[i - 1]!, b = pts[i]!;
  return a.sinkMs + ((v - a.easKmh) / (b.easKmh - a.easKmh)) * (b.sinkMs - a.sinkMs);
};

describe("ASK21 speed polar against the measured one", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await ensureAircraft(ASK21);
  }, 300_000);

  it("loads with its corrections applied", () => {
    const set = loadJsbsimFiles(dir, ASK21.setFile);
    expect(set.warnings.filter((w) => w.includes("correction"))).toEqual([]);
    expect(set.files["Systems/ask21-aero.xml"]).toContain("0.0222");
  });

  // The reference at 468 kg was used to fit the drag; 563 kg (front 103, rear 100: the flight
  // manual's heavier chart) was not: polars scale with sqrt(mass) in speed and sink.
  for (const [name, front, rear] of [["468 kg (fitted)", 107.85, 0], ["563 kg (held out)", 103, 100]] as const) {
    it(`sinks as measured at ${name}, within 0.04 m/s`, async () => {
      const ref = ASK21.reference!;
      const fdm = await Fdm.create();
      try {
        const set = loadJsbsimFiles(dir, ASK21.setFile);
        fdm.load({ aircraft: set.aircraft, model: set.model, files: set.files, hostProperties: set.hostProperties });
        fdm.set(P.pointmassWeightLbs(0), front * LBS_PER_KG);
        fdm.set(P.pointmassWeightLbs(1), rear * LBS_PER_KG);
        fdm.set(P.pointmassWeightLbs(2), 0);
        fdm.runIc();
        const k = Math.sqrt(fdm.get(P.weightLbs) / LBS_PER_KG / ref.massKg);
        const pts = trimmedPolar(fdm, { stepKmh: 1, maxKmh: 200 });
        for (const [v, w] of ref.points) expect(Math.abs(sinkAt(pts, v * k) - w * k)).toBeLessThan(0.04);
        const best = pts.reduce((m, p) => (p.glideRatio > m.glideRatio ? p : m));
        // Schleicher: 34 at 90 km/h; a flight test found 31.
        expect(best.glideRatio).toBeGreaterThan(31);
        expect(best.glideRatio).toBeLessThan(35);
      } finally {
        fdm.destroy();
      }
    }, 60_000);
  }
});
