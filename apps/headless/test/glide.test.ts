import { beforeAll, describe, expect, it } from "vitest";
import { ASK21, ensureAircraft } from "../src/gliders.ts";
import { glideExperiment } from "../src/experiment.ts";

describe("ASK21 headless glide (Milestone 1)", () => {
  // Download into the FGAddon cache on first run; not part of the timed glide.
  beforeAll(async () => {
    await ensureAircraft(ASK21);
  }, 300_000);

  it("glides 120 s from 1000 m AGL in under 5 s and reports best L/D and min sink", async () => {
    const t0 = performance.now();
    const r = await glideExperiment({ loadout: "solo", durationS: 120 });
    const wallMs = performance.now() - t0;

    console.log(
      `ASK21 solo ${r.massKg.toFixed(0)} kg: best L/D ${r.polar.bestGlide.glideRatio.toFixed(1)} @ ${r.polar.bestGlide.easKmh.toFixed(0)} km/h, ` +
        `min sink ${r.polar.minSink.sinkMs.toFixed(2)} m/s @ ${r.polar.minSink.easKmh.toFixed(0)} km/h; glide ratio over 120 s ${r.summary.glideRatio.toFixed(1)}; ${wallMs.toFixed(0)} ms`,
    );

    expect(wallMs).toBeLessThan(5000);
    expect(r.massKg).toBeCloseTo(440, 0);
    expect(r.glide.trim.converged).toBe(true);
    expect(r.summary.durationS).toBeCloseTo(120, 1);

    // Reported figures exist and are physically sensible for a two-seat trainer.
    expect(r.polar.bestGlide.glideRatio).toBeGreaterThan(20);
    expect(r.polar.bestGlide.glideRatio).toBeLessThan(50);
    expect(r.polar.minSink.sinkMs).toBeGreaterThan(0.3);
    expect(r.polar.minSink.sinkMs).toBeLessThan(1.2);
    expect(r.polar.minSink.easKmh).toBeLessThan(r.polar.bestGlide.easKmh);

    // Neutral controls after trim hold speed; the 120 s average L/D stays near best glide.
    expect(Math.abs(r.summary.meanEasKmh - r.polar.bestGlide.easKmh)).toBeLessThan(2);
    expect(Math.abs(r.summary.glideRatio - r.polar.bestGlide.glideRatio)).toBeLessThan(2);
    expect(r.csv.split("\n")[0]).toBe("t_s,h_agl_m,ias_kmh,eas_kmh,tas_kmh,sink_ms,glide_ratio,pitch_deg,alpha_deg,gamma_deg,bank_deg,heading_deg");
  }, 30_000);
});
