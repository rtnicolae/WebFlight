import { beforeAll, describe, expect, it } from "vitest";
import { Fdm, KMH_PER_KT, LBS_PER_KG, P, trimSteadyGlide } from "@webflight/fdm-core";
import { ASK21_FIT, loadJsbsimFiles } from "@webflight/converter";
import { ASK21, ensureAircraft } from "../src/gliders.ts";
import { START, trimmedPolar, type PolarPoint } from "../src/glide.ts";

/** Sink at speed v from a 1 km/h trimmed polar (linear between the two speeds round it). */
const sinkAt = (pts: PolarPoint[], v: number) => {
  const i = pts.findIndex((p) => p.easKmh >= v);
  const a = pts[i - 1]!, b = pts[i]!;
  return a.sinkMs + ((v - a.easKmh) / (b.easKmh - a.easKmh)) * (b.sinkMs - a.sinkMs);
};

describe("ASK21 against its flight manual and measured polar", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await ensureAircraft(ASK21);
  }, 300_000);

  /** The model loaded (with its corrections) at front/rear seat loads [kg], airbrakes in or out. */
  async function glider(front: number, rear: number, airbrakes = false): Promise<Fdm> {
    const set = loadJsbsimFiles(dir, ASK21.setFile);
    const fdm = await Fdm.create();
    fdm.load({ aircraft: set.aircraft, model: set.model, files: set.files, hostProperties: set.hostProperties });
    fdm.set(P.pointmassWeightLbs(0), front * LBS_PER_KG);
    fdm.set(P.pointmassWeightLbs(1), rear * LBS_PER_KG);
    fdm.set(P.pointmassWeightLbs(2), 0);
    // The ASK21 reads its airbrake lever from the throttle: 1 is closed, 0 fully out.
    fdm.set("/controls/engines/engine/throttle", airbrakes ? 0 : 1);
    fdm.runIc();
    return fdm;
  }

  it("loads with its corrections applied", () => {
    const set = loadJsbsimFiles(dir, ASK21.setFile);
    expect(set.warnings.filter((w) => w.includes("correction"))).toEqual([]);
    expect(set.files["Systems/ask21-aero.xml"]).toContain(ASK21_FIT.inducedK.toFixed(4));
  });

  it("balances where the weight and balance sheet puts it", async () => {
    // Loaded as for the flight manual's stall speeds: 470 kg solo, 600 kg two-up (110/110).
    for (const [front, rear, cgAftMm] of [[90.1, 0, 390], [110, 110, 250]] as const) {
      const fdm = await glider(front, rear);
      const cg = (fdm.get("inertia/cg-x-in") * 0.0254 - ASK21_FIT.datumX) * 1000;
      fdm.destroy();
      expect(Math.abs(cg - cgAftMm)).toBeLessThan(7);
      expect(cg).toBeGreaterThan(234); // certified range, EASA TCDS
      expect(cg).toBeLessThan(469);
    }
  });

  // The reference at 468 kg was used to fit the drag; 563 kg (a two-up loading) was not: polars
  // scale with sqrt(mass) in speed and sink.
  for (const [name, front, rear] of [["468 kg (fitted)", 88.1, 0], ["563 kg (held out)", 92, 91.25]] as const) {
    it(`sinks as measured at ${name}, within 0.04 m/s`, async () => {
      const ref = ASK21.reference!;
      const fdm = await glider(front, rear);
      try {
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

  it("trims hands-off at 150-160 km/h with the trim full forward, one 80 kg pilot (Schleicher TM11)", async () => {
    const fdm = await glider(80, 0);
    try {
      // The fastest speed the trim alone holds (no stick), in 0.5 km/h steps.
      let top = 0, guess: { alphaDeg: number; gammaDeg: number; control: number } | undefined;
      for (let v = 120; v <= 200; v += 0.5) {
        const t = trimSteadyGlide(fdm, { speed: { veKts: v / KMH_PER_KT }, base: START, stickBeyondTrim: false, ...(guess ? { guess } : {}) });
        if (!t.converged) break;
        guess = { alphaDeg: t.alphaDeg, gammaDeg: t.gammaDeg, control: t.control };
        top = v;
      }
      expect(top).toBeGreaterThanOrEqual(150);
      expect(top).toBeLessThanOrEqual(160);
      // Beyond it the trim stays at its stop and the stick holds the rest.
      const fast = trimSteadyGlide(fdm, { speed: { veKts: 180 / KMH_PER_KT }, base: START });
      expect(fast.converged).toBe(true);
      expect(fast.control).toBe(1);
      expect(fast.stick).toBeGreaterThan(0);
    } finally {
      fdm.destroy();
    }
  }, 60_000);

  // The flight manual (p. 34): 65 km/h IAS at 470 kg solo, 74 at 600 kg two-up; 68 and 77 with the
  // airbrakes out. Here the lowest steady (1 g) speed, trimmed down in 0.25 km/h steps. Two-up it
  // is 1.25 km/h above the manual's figure (the elevator at 95% of its published up travel).
  for (const [name, front, rear, brakes, manual, tol] of [
    ["470 kg solo", 90.1, 0, false, 65, 1],
    ["600 kg two-up", 110, 110, false, 74, 1.5],
    ["470 kg solo, airbrakes out", 90.1, 0, true, 68, 1],
    ["600 kg two-up, airbrakes out", 110, 110, true, 77, 2],
  ] as const) {
    it(`stalls near the flight manual's speed, ${name}`, async () => {
      const fdm = await glider(front, rear, brakes);
      try {
        let guess: { alphaDeg: number; gammaDeg: number; control: number } | undefined, vmin = 0;
        for (let v = 90; v >= 50; v -= 0.25) {
          const t = trimSteadyGlide(fdm, { speed: { veKts: v / KMH_PER_KT }, base: START, ...(guess ? { guess } : {}) });
          if (!t.converged) break;
          guess = { alphaDeg: t.alphaDeg, gammaDeg: t.gammaDeg, control: t.control };
          vmin = v;
        }
        expect(Math.abs(vmin - manual)).toBeLessThanOrEqual(tol);
      } finally {
        fdm.destroy();
      }
    }, 60_000);
  }
});
