import { describe, expect, it } from "vitest";
import { airAt, jsbsimAir, qnhHpa, type AirColumn } from "../src/air.ts";

// A summer afternoon over the Brașov basin (Open-Meteo's ground 533 m): 2 m values and three
// pressure levels.
const column: AirColumn = {
  elevationM: 533,
  tempC: 27.4,
  dewPointC: 12.2,
  surfacePressureHpa: 950.2,
  aloft: [
    { altM: 790, fromDeg: 300, kt: 8, hPa: 925, tempC: 22.0, dewPointC: 10.0 },
    { altM: 1532, fromDeg: 295, kt: 11, hPa: 850, tempC: 16.0, dewPointC: 6.0 },
    { altM: 3152, fromDeg: 280, kt: 19, hPa: 700, tempC: 4.0, dewPointC: -6.0 },
  ],
};
const ISA_SL_PSF = 2116.22;

describe("the day's air by height", () => {
  it("is the weather's own column at its points, linear between them", () => {
    expect(airAt(column, 535).tempC).toBeCloseTo(27.4, 6);
    expect(airAt(column, 535).dewPointC).toBeCloseTo(12.2, 6);
    expect(airAt(column, 1532).tempC).toBeCloseTo(16.0, 6);
    expect(airAt(column, (790 + 1532) / 2).tempC).toBeCloseTo(19.0, 6);
    expect(airAt(column, (790 + 1532) / 2).dewPointC).toBeCloseTo(8.0, 6);
    // Pressure: the surface's at the model's ground, the levels' at theirs, log-linear between.
    expect(airAt(column, 533).hPa).toBeCloseTo(950.2, 6);
    expect(airAt(column, 1532).hPa).toBeCloseTo(850, 6);
    expect(airAt(column, (790 + 1532) / 2).hPa).toBeCloseTo(Math.sqrt(925 * 850), 6);
  });

  it("goes on with the standard lapse and hydrostatic pressure beyond its points", () => {
    const a = airAt(column, 4152);
    expect(a.tempC).toBeCloseTo(4.0 - 6.5, 6);
    expect(a.dewPointC).toBeCloseTo(-6.0 - 6.5, 6); // the top level's 10 K spread kept
    const tMean = (4.0 + a.tempC) / 2 + 273.15;
    expect(a.hPa).toBeCloseTo(700 * Math.exp((-9.80665 * 1000) / (287.053 * tMean)), 6);
    // A valley below the model's ground: warmer, higher pressure.
    const v = airAt(column, 400);
    expect(v.tempC).toBeGreaterThan(27.4);
    expect(v.hPa).toBeGreaterThan(950.2);
  });

  it("without levels or pressure: the standard lapse from 2 m, the standard sea-level pressure", () => {
    const bare: AirColumn = { elevationM: 533, tempC: 20, dewPointC: 5, aloft: [] };
    expect(airAt(bare, 1535).tempC).toBeCloseTo(20 - 6.5, 6);
    expect(airAt(bare, 0).hPa).toBeCloseTo(1013.25, 6);
    expect(airAt(bare, 1535).pressureEstimated).toBe(true);
    expect(airAt(column, 1535).pressureEstimated).toBeUndefined();
    // JSBSim's sea-level pressure: standard, within its uniform bias's difference from the lapse.
    expect(jsbsimAir(bare, 1535).pSlPsf).toBeCloseTo(ISA_SL_PSF, -1);
  });

  it("gives JSBSim no change on a standard day", () => {
    const isa: AirColumn = { elevationM: 0, tempC: 15 - 0.0065 * 2, dewPointC: -40, surfacePressureHpa: 1013.25, aloft: [] };
    for (const h of [0, 1000, 3000]) {
      const j = jsbsimAir(isa, h);
      expect(Math.abs(j.deltaTR)).toBeLessThan(0.05); // within 0.03 K: geometric vs geopotential
      expect(j.pSlPsf!).toBeCloseTo(ISA_SL_PSF, 0);
    }
  });

  it("sets the altimeter to QNH: it reads the ground's height there", () => {
    // The standard atmosphere's pressure at 533 m: QNH 1013.25.
    const isaP = 1013.25 * Math.pow(1 - (0.0065 * 533) / 288.15, 5.255876);
    expect(qnhHpa({ ...column, surfacePressureHpa: isaP }, 533)).toBeCloseTo(1013.25, 2);
    // 950.2 hPa at 533 m, 0.8 below the standard's there: QNH 0.85 lower (8 m of reading per hPa).
    expect(qnhHpa(column, 533)).toBeCloseTo(1012.4, 0);
    // Without a surface pressure the levels' pressures give one. With neither, 1013.25 at sea
    // level under air 8.5 K warmer than standard leaves more at 533 m: QNH ~1.8 hPa higher.
    expect(qnhHpa({ ...column, surfacePressureHpa: undefined }, 533)).toBeGreaterThan(1000);
    const q = qnhHpa({ elevationM: 533, tempC: 20, dewPointC: 5, aloft: [] }, 533);
    expect(q).toBeGreaterThan(1014.5);
    expect(q).toBeLessThan(1015.5);
  });
});
