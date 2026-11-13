import { beforeAll, describe, expect, it } from "vitest";
import { advance, applyEnvironment, Environment } from "@webflight/environment";
import { ASK21, createGlider, ensureAircraft } from "../src/gliders.ts";
import { runLanding } from "../src/landing.ts";
import { GRENCHEN, JURA_CREST } from "../src/sites.ts";
import { ASK21_AIRBRAKE, SoaringSim } from "../src/soaring.ts";
import { nodeTerrain } from "../src/terrain.ts";

// Real terrain (AWS Terrarium tiles, cached under .cache/terrain).
const terrain = nodeTerrain();

describe("ASK21 over real terrain", () => {
  beforeAll(async () => {
    await ensureAircraft(ASK21);
    await terrain.load(JURA_CREST.latDeg, JURA_CREST.lonDeg, 8000);
    await terrain.load(GRENCHEN.latDeg, GRENCHEN.lonDeg, 6000);
  }, 300_000);

  it("ridge lift on the Jura's windward face: climbs in a 20 kt SE wind, sinks in still air", async () => {
    // 700 m down the SE face from the crest, flying along it at 250 m AGL.
    const [lat, lon] = advance(JURA_CREST.latDeg, JURA_CREST.lonDeg, 150, 700);
    const run = async (windKt: number) => {
      const sim = await SoaringSim.create({ latDeg: lat, lonDeg: lon, headingDeg: 70, aglM: 250, easKmh: 85 }, { windFromDeg: 150, windKt, thermals: false }, { terrain });
      try {
        const a0 = sim.altM;
        let lift = 0, n = 0, minAgl = Infinity;
        sim.run(60, { headingDeg: 70, easKmh: 85 }, 4, (s) => {
          lift += s.last!.ridgeLiftFps * 0.3048;
          n++;
          minAgl = Math.min(minAgl, s.aglM);
        });
        return { climb: sim.altM - a0, lift: lift / n, minAgl };
      } finally {
        sim.fdm.destroy();
      }
    };
    const still = await run(0), windy = await run(20);
    expect(still.lift).toBe(0);
    expect(still.climb).toBeLessThan(-30); // ~0.75 m/s sink
    expect(windy.lift).toBeGreaterThan(1.5);
    expect(windy.climb).toBeGreaterThan(50);
    expect(windy.minAgl).toBeGreaterThan(20);
  }, 60_000);

  it("circling in a formed thermal gains height; the same thermal dead does not", async () => {
    const centre = { lat: 47.15, lon: 7.3 };
    // Start one turn radius (≈60 m at 40° bank, 80 km/h) west, heading north, turning right.
    const [lat, lon] = advance(centre.lat, centre.lon, 270, 60);
    const run = async (cycleS: number) => {
      const sim = await SoaringSim.create(
        { latDeg: lat, lonDeg: lon, headingDeg: 0, aglM: 600, easKmh: 80 },
        { windFromDeg: 0, windKt: 0, ridgeLift: false, thermals: { seed: 1, centerLatDeg: centre.lat, centerLonDeg: centre.lon, count: 1, radiusM: 1, strengthMs: [3, 3], diameterM: [600, 600], cloudBaseM: 1800 } },
        { terrain },
      );
      try {
        sim.env.thermals!.thermals[0]!.cycleTimer = cycleS;
        const a0 = sim.altM;
        sim.run(120, { bankDeg: 40, easKmh: 80 });
        return sim.altM - a0;
      } finally {
        sim.fdm.destroy();
      }
    };
    expect(await run(6 * 60)).toBeGreaterThan(30); // formed
    expect(await run(26 * 60)).toBeLessThan(-100); // dead
  }, 60_000);

  it("lands on Grenchen's runway: touches down on the real ground height and stops", async () => {
    const { fdm } = await createGlider(ASK21, "solo");
    try {
      const env = new Environment({ windFromDeg: 0, windKt: 0, ridgeLift: false }, terrain);
      const [lat, lon] = advance(GRENCHEN.latDeg, GRENCHEN.lonDeg, GRENCHEN.headingDeg + 180, 600);
      const ground = (await terrain.heightAtAsync(lat, lon)) / 0.3048;
      fdm.set("position/terrain-elevation-asl-ft", ground);
      const r = runLanding(fdm, ASK21_AIRBRAKE, {
        base: { "ic/lat-geod-deg": lat, "ic/long-gc-deg": lon, "ic/psi-true-deg": GRENCHEN.headingDeg, "ic/terrain-elevation-ft": ground },
        afterStep: (f) => applyEnvironment(env, f, f.dt),
      });
      expect(r.touchdown).toBeDefined();
      expect(r.airborneAfterTouchdownS).toBeLessThan(0.1);
      expect(r.stoppedAtS).toBeDefined();
      // At rest the glider sits on Terrarium's ground (≈ 426 m) with the CG ~0.9 m up.
      const groundM = terrain.heightAt(fdm.get("position/lat-geod-deg"), fdm.get("position/long-gc-deg"))!;
      expect(groundM).toBeGreaterThan(420);
      expect(groundM).toBeLessThan(432);
      expect(fdm.get("position/geod-alt-ft") * 0.3048 - groundM).toBeCloseTo(r.restCgAglM, 1);
    } finally {
      fdm.destroy();
    }
  }, 60_000);
});
