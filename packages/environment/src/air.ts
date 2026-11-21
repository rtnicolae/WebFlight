/**
 * The day's air by height for the flight model: temperature, humidity and pressure, as
 * FlightGear hands them to JSBSim (FGJSBsim::copy_to_JSBsim: the temperature and dew point at
 * the aircraft's height, and the sea-level pressure). JSBSim otherwise flies in the standard
 * atmosphere: 15 °C and 1013.25 hPa at sea level, dry, whatever the day.
 *
 * From the weather's own column (no lapse rates of ours where it has data):
 *  - temperature and dew point: the 2 m values over the model's ground, then the pressure
 *    levels' (925 to 600 hPa) at their heights, linear in height between them; above the top
 *    level and below the ground, the standard lapse (6.5 K/km) from the nearest, the dew point
 *    keeping its spread;
 *  - pressure: the surface pressure at the model's ground, then the levels' pressures at their
 *    heights, its logarithm linear in height between them (exact for a layer of uniform
 *    temperature); beyond them, hydrostatic with the column's temperature.
 * Without levels (the reanalysis has none) the standard lapse from the 2 m temperature: FG's
 * own fallback from a station report. Without any pressure (the offline estimate), the
 * standard 1013.25 hPa at sea level under the day's temperatures.
 *
 * JSBSim's standard atmosphere (FGStandardAtmosphere) takes a temperature bias, uniform in
 * height, and a sea-level pressure; its pressure aloft is hydrostatic through the biased
 * temperatures. So for the aircraft's height the bias is set to give the column's temperature
 * there, and the sea-level pressure to give the column's pressure there (the local static
 * pressure, which the airspeed indicator, altimeter and variometer read), as FG resets the
 * temperature for the aircraft's altitude every frame. Checked against the build: a probe and
 * apps/headless/test/air.test.ts.
 */
import type { Weather } from "./weather.ts";

/** The parts of the weather the air is made from. */
export type AirColumn = Pick<Weather, "elevationM" | "tempC" | "dewPointC" | "surfacePressureHpa" | "aloft">;

/** A weather's air column (only those parts: it goes to the flight model's worker). */
export const airColumnOf = (w: AirColumn): AirColumn => ({
  elevationM: w.elevationM,
  tempC: w.tempC,
  dewPointC: w.dewPointC,
  aloft: w.aloft,
  ...(w.surfacePressureHpa !== undefined ? { surfacePressureHpa: w.surfacePressureHpa } : {}),
});

export interface Air {
  tempC: number;
  dewPointC: number;
  /** Static pressure [hPa]. */
  hPa: number;
  /** The pressure is the estimate: standard at sea level (the weather had none). */
  pressureEstimated?: boolean;
}

/** What JSBSim is given for the air at one height. */
export interface JsbsimAir extends Air {
  /** atmosphere/delta-T [°R]: the temperature bias. */
  deltaTR: number;
  /** atmosphere/dew-point-R [°R]. */
  dewPointR: number;
  /** atmosphere/P-sl-psf. */
  pSlPsf: number;
}

const ISA_LAPSE = 0.0065; // K/m
const G = 9.80665;
const RD = 287.053; // J/(kg K), dry air
const K = 273.15;

interface Pt {
  z: number;
  v: number;
}

/** Linear in z through sorted points; outside, `beyond(end, dz)`. */
function profile(pts: Pt[], z: number, beyond: (end: Pt, dz: number) => number): number {
  const first = pts[0]!, last = pts[pts.length - 1]!;
  if (z <= first.z) return beyond(first, z - first.z);
  if (z >= last.z) return beyond(last, z - last.z);
  let i = 1;
  while (pts[i]!.z < z) i++;
  const a = pts[i - 1]!, b = pts[i]!;
  return a.v + ((z - a.z) / (b.z - a.z)) * (b.v - a.v);
}

/** Temperature, dew point and pressure at a height [m above sea level]. */
export function airAt(c: AirColumn, altM: number): Air {
  const groundZ = c.elevationM + 2;
  const above = c.aloft.filter((l) => l.altM > groundZ + 1).sort((a, b) => a.altM - b.altM);
  const tPts: Pt[] = [{ z: groundZ, v: c.tempC }, ...above.filter((l) => l.tempC !== undefined).map((l) => ({ z: l.altM, v: l.tempC! }))];
  const lapse = (end: Pt, dz: number) => end.v - ISA_LAPSE * dz;
  const tempC = profile(tPts, altM, lapse);
  // The dew point: its own points, and beyond them the same spread below the temperature.
  const dPts: Pt[] = [{ z: groundZ, v: c.dewPointC }, ...above.filter((l) => l.tempC !== undefined && l.dewPointC !== undefined).map((l) => ({ z: l.altM, v: l.dewPointC! }))];
  const spreadEnd = (end: Pt) => profile(tPts, end.z, lapse) - end.v;
  const dewPointC = Math.min(tempC, profile(dPts, altM, (end) => tempC - spreadEnd(end)));
  // Pressure: ln p through the surface and the levels, hydrostatic beyond them; with none, from
  // the standard sea-level pressure.
  const pPts: Pt[] = [
    ...(c.surfacePressureHpa !== undefined ? [{ z: c.elevationM, v: Math.log(c.surfacePressureHpa) }] : []),
    ...c.aloft.filter((l) => l.hPa !== undefined && l.altM > c.elevationM + 1).sort((a, b) => a.altM - b.altM).map((l) => ({ z: l.altM, v: Math.log(l.hPa!) })),
  ];
  const estimated = !pPts.length;
  if (estimated) pPts.push({ z: 0, v: Math.log(1013.25) });
  const hPa = Math.exp(
    profile(pPts, altM, (end, dz) => {
      const tMean = (profile(tPts, end.z, lapse) + tempC) / 2 + K;
      return end.v - (G * dz) / (RD * tMean);
    }),
  );
  return { tempC, dewPointC, hPa, ...(estimated ? { pressureEstimated: true } : {}) };
}

// JSBSim's standard atmosphere (FGStandardAtmosphere, FGJSBBase): English units, geopotential
// heights on the 1976 standard's earth radius, the troposphere's lapse.
const FT = 0.3048;
const T0_R = 518.67;
const LAPSE_R_FT = 0.00356616;
const R_EARTH_FT = 6356766 / FT;
const G0_FT = G / FT;
const RENG = (8.31432 / 0.0289644) * (1 / (FT * FT)) * (1 / 1.8); // ft²/(s² R)
const N = G0_FT / (RENG * LAPSE_R_FT);
const PSF_PER_HPA = 100 / 47.880259;
/** The troposphere's top [ft geopotential]: the lapse holds below it. */
const TROPOPAUSE_FT = 36089.24;

const geopotentialFt = (hFt: number) => (hFt * R_EARTH_FT) / (R_EARTH_FT + hFt);

/** JSBSim's inputs that give the column's air at a height [m above sea level]. */
export function jsbsimAir(c: AirColumn, altM: number): JsbsimAir {
  const a = airAt(c, altM);
  const z = Math.min(geopotentialFt(altM / FT), TROPOPAUSE_FT);
  const deltaTR = (a.tempC + K) * 1.8 - (T0_R - LAPSE_R_FT * z);
  // JSBSim's pressure at z for a sea-level pressure p0: p0 ((T0 + b − L z) / (T0 + b))^N.
  const pSlPsf = (a.hPa * PSF_PER_HPA) / Math.pow((T0_R + deltaTR - LAPSE_R_FT * z) / (T0_R + deltaTR), N);
  return { ...a, deltaTR, dewPointR: (a.dewPointC + K) * 1.8, pSlPsf };
}

/** ISA pressure altitude [m] of a pressure [hPa] (the altimeter's scale). */
const pressureAltitudeM = (hPa: number) => (288.15 / ISA_LAPSE) * (1 - Math.pow(hPa / 1013.25, 1 / 5.255876));

/**
 * QNH [hPa] at a ground height [m]: the altimeter setting that makes it read that height there
 * (the ground's pressure brought to sea level through the standard atmosphere), as a pilot sets
 * it before take-off.
 */
export function qnhHpa(c: AirColumn, groundM: number): number {
  const p = airAt(c, groundM).hPa;
  return 1013.25 * Math.pow(1 - (ISA_LAPSE * (pressureAltitudeM(p) - groundM)) / 288.15, 5.255876);
}
