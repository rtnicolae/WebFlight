import { beforeAll, describe, expect, it } from "vitest";
import { Fdm, FT_PER_M, LBS_PER_KG, P } from "@webflight/fdm-core";
import { loadJsbsimFiles } from "@webflight/converter";
import { airAt, applyAir, applyEnvironment, Environment, type AirColumn } from "@webflight/environment";
import { ASK21, ensureAircraft } from "../src/gliders.ts";

// A hot summer afternoon over the Brașov basin (see packages/environment/test/air.test.ts).
const column: AirColumn = {
  elevationM: 533,
  tempC: 31.0,
  dewPointC: 14.0,
  surfacePressureHpa: 948.0,
  aloft: [
    { altM: 795, fromDeg: 300, kt: 8, hPa: 925, tempC: 25.0, dewPointC: 12.0 },
    { altM: 1545, fromDeg: 295, kt: 11, hPa: 850, tempC: 18.5, dewPointC: 7.0 },
    { altM: 3170, fromDeg: 280, kt: 19, hPa: 700, tempC: 5.5, dewPointC: -6.0 },
  ],
};
const T = (f: Fdm) => f.get("atmosphere/T-R") / 1.8 - 273.15;
const hPa = (f: Fdm) => (f.get("atmosphere/P-psf") * 47.880259) / 100;

describe("the day's air in JSBSim", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await ensureAircraft(ASK21);
  }, 300_000);

  async function glider(): Promise<Fdm> {
    const set = loadJsbsimFiles(dir, ASK21.setFile);
    const fdm = await Fdm.create();
    fdm.load({ aircraft: set.aircraft, model: set.model, files: set.files, hostProperties: set.hostProperties });
    fdm.set(P.pointmassWeightLbs(0), 90 * LBS_PER_KG);
    fdm.set(P.pointmassWeightLbs(1), 0);
    fdm.set(P.pointmassWeightLbs(2), 0);
    fdm.set("/controls/engines/engine/throttle", 1);
    return fdm;
  }
  const start = (fdm: Fdm, altM: number) => {
    fdm.setInitialConditions({ "ic/terrain-elevation-ft": 533 * FT_PER_M, "ic/lat-geod-deg": 45.65, "ic/long-gc-deg": 25.5, "ic/h-sl-ft": altM * FT_PER_M, "ic/vc-kts": 45, "ic/psi-true-deg": 0 });
    fdm.runIc();
  };

  it("has the column's temperature, pressure and dew point where the glider is", async () => {
    const fdm = await glider();
    const env = new Environment({ windFromDeg: 0, windKt: 0, ridgeLift: false, thermals: false, air: column });
    for (const h of [600, 1200, 2000, 3500]) {
      applyAir(env, fdm, h);
      start(fdm, h);
      // JSBSim keeps the moisture as a vapour fraction, fixed with height: the dew point it was
      // given turns into one at the pressure where the glider was. Set again there (as every
      // step batch does in flight).
      applyAir(env, fdm, h);
      const a = airAt(column, h);
      expect(T(fdm)).toBeCloseTo(a.tempC, 2);
      expect(hPa(fdm)).toBeCloseTo(a.hPa, 1);
      expect(fdm.get("atmosphere/dew-point-R") / 1.8 - 273.15).toBeCloseTo(a.dewPointC, 2);
    }
    // And as it flies (applyEnvironment every batch): after a minute's glide, at its new height.
    applyAir(env, fdm, 2000);
    start(fdm, 2000);
    for (let i = 0; i < 60 * 12; i++) {
      applyEnvironment(env, fdm, 1 / 12);
      fdm.step(10);
    }
    const h = fdm.get("position/h-sl-ft") / FT_PER_M;
    expect(h).toBeLessThan(1960);
    expect(T(fdm)).toBeCloseTo(airAt(column, h).tempC, 1);
    expect(hPa(fdm)).toBeCloseTo(airAt(column, h).hPa, 1);
    fdm.destroy();
  }, 120_000);

  it("flies thinner air on a hot day: the same indicated speed is a faster true one", async () => {
    const hot = await glider();
    const std = await glider();
    const env = new Environment({ windFromDeg: 0, windKt: 0, ridgeLift: false, thermals: false, air: column });
    applyAir(env, hot, 1500);
    start(hot, 1500);
    start(std, 1500);
    const ratio = hot.get("velocities/vtrue-kts") / std.get("velocities/vtrue-kts");
    // At 1500 m: 13.6 K warmer than standard (−4.7 % density), 9 hPa higher pressure (+1.0 %),
    // moist (−0.4 %): 4 % thinner, the true airspeed 2 % higher at the same indicated.
    const rho = hot.get("atmosphere/rho-slugs_ft3") / std.get("atmosphere/rho-slugs_ft3");
    expect(rho).toBeGreaterThan(0.95);
    expect(rho).toBeLessThan(0.97);
    expect(ratio).toBeCloseTo(1 / Math.sqrt(rho), 3);
    expect(ratio).toBeGreaterThan(1.015);
    hot.destroy();
    std.destroy();
  }, 120_000);
});
