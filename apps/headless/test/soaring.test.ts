import { beforeAll, describe, expect, it } from "vitest";
import { advance, applyEnvironment, buildWaveField, Environment, Thermal, thermalUpdraft, waveAt, type TerrariumTerrain } from "@webflight/environment";
import { ASK21, createGlider, ensureAircraft } from "../src/gliders.ts";
import { runLanding } from "../src/landing.ts";
import { GRENCHEN, JURA_CREST } from "@webflight/environment";
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

  it("an average thermal of a w* 2.4 m/s day lifts a circling ASK21 by about w* less its sink (RASP's rule)", async () => {
    // 10 Jul 2024 at Ghimbav, 13:00 (reanalysis): w* 2.44 m/s, cumulus base 1,588 m above the
    // ground; the thermal as ThermalSky makes an average one (gain 1, the day's width).
    const centre = { lat: 47.15, lon: 7.3 };
    const ground = await terrain.heightAtAsync(centre.lat, centre.lon);
    const updraft = { wStarMs: 2.44, gain: 1, cumulus: true }, diameterM = 397;
    const spec = { latDeg: centre.lat, lonDeg: centre.lon, heightMslFt: (ground + 1588) / 0.3048, strengthFps: thermalUpdraft(0, 0.5, diameterM / 2, updraft) / 0.3048, diameterFt: diameterM / 0.3048, groundElevFt: ground / 0.3048 };
    const th = new Thermal(spec, () => 0, undefined, undefined, updraft);
    th.cycleTimer = 6 * 60; // formed
    const [lat, lon] = advance(centre.lat, centre.lon, 270, 60);
    const sim = await SoaringSim.create({ latDeg: lat, lonDeg: lon, headingDeg: 0, aglM: 0.5 * 1588, easKmh: 80 }, { windFromDeg: 0, windKt: 0, ridgeLift: false, thermals: false }, { terrain });
    try {
      // This one thermal as the environment's.
      (sim.env as unknown as { thermals: unknown }).thermals = { thermals: [th], strengthFps: 0, update: (dt: number, u: { latDeg: number; lonDeg: number; altFt: number }, w: never) => th.run(dt, u, w) };
      const a0 = sim.altM;
      sim.run(120, { bankDeg: 40, easKmh: 80 });
      // The plain bank-holding autopilot circles off-centre and ~0.3 m/s worse than a pilot
      // (2026-11 runs: +0.6 m/s; a centring pilot model climbed 1.3–1.7 m/s at every height).
      expect((sim.altM - a0) / 120).toBeGreaterThan(0.3);
    } finally {
      sim.fdm.destroy();
    }
  }, 60_000);

  it("climbs in the lee wave of a ridge, pointed into the wind; the same air without waves sinks", async () => {
    // A north–south ridge, 1,000 m over a 600 m plain; a stable westerly strengthening with height.
    const lat0 = 45.5, lon0 = 25.5, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const ridge = (_la: number, lo: number) => 600 + 1000 * Math.exp(-((((lo - lon0) * mLon) / 4000) ** 2));
    const fake = { load: async () => {}, heightAt: ridge, heightAtAsync: async (la: number, lo: number) => ridge(la, lo) } as unknown as TerrariumTerrain;
    const levels = [
      { altM: 1500, hPa: 850, tempC: 4, fromDeg: 270, kt: 20 },
      { altM: 3000, hPa: 700, tempC: -4, fromDeg: 270, kt: 30 },
      { altM: 5500, hPa: 500, tempC: -22, fromDeg: 270, kt: 40 },
    ];
    const field = buildWaveField({ centerLatDeg: lat0, centerLonDeg: lon0, heightAt: ridge, levels, n: 128, dx: 400 })!;
    // The strongest lift at 2,800 m within 15 km downwind (east) of the crest.
    let best = { e: 0, w: -Infinity };
    for (let e = 2000; e <= 15_000; e += 200) {
      const w = waveAt(field, lat0, lon0 + e / mLon, 2800)!;
      if (w > best.w) best = { e, w };
    }
    expect(best.w).toBeGreaterThan(1.5);
    const fly = async (withWaves: boolean) => {
      const lon = lon0 + best.e / mLon;
      const sim = await SoaringSim.create({ latDeg: lat0, lonDeg: lon, headingDeg: 270, aglM: 2800 - ridge(lat0, lon), easKmh: 80 }, { windFromDeg: 270, windKt: 15, profile: { elevationM: 600, windFromDeg: 270, windKt: 15, aloft: levels }, ridgeLift: true, thermals: false }, { terrain: fake });
      try {
        if (withWaves) sim.env.waves = field;
        // (The start is trimmed in still air: the headwind's arrival zooms it up for ~10 s.)
        sim.run(15, { headingDeg: 270, easKmh: 80 });
        const a0 = sim.altM;
        sim.run(30, { headingDeg: 270, easKmh: 80 });
        return (sim.altM - a0) / 30;
      } finally {
        sim.fdm.destroy();
      }
    };
    expect(await fly(true)).toBeGreaterThan(0.5);
    expect(await fly(false)).toBeLessThan(-0.5);
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
