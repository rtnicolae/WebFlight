/**
 * Thermals, ported from FlightGear's FGAIThermal (src/AIModel/AIThermal.cxx, David Culp and
 * Patrice Poly, GPL-2.0+) and the nearest-thermal rule of FGAIManager::processThermal:
 *  - 30-minute life cycle: forming (0–5 min), formed (–20), dying (–25), dead (–30), reborn
 *  - vertical profile get_strength_fac(altitude / thermal top)
 *  - the column leans downwind (slice centre moves with height)
 *  - updraft core (cosine), sink ring around it, -1 ft/s global sink outside
 * FlightGear's rand() calls use a seeded generator here, so a seed reproduces the sky.
 *
 * Lift of the day's thermals (ThermalSky with weather). FG's cosine core and its profile, weakest
 * low down and strongest at cloud base, are a game's shapes: in JSBSim an ASK21 circling an
 * average one on a w* 2.4 m/s day sank below a third of the height and climbed under 0.5 m/s
 * above it. The weather's thermals use NASA's updraft model instead (Allen 2006, below), from
 * measured thermals: strongest from a tenth to half the height, narrower low down, the bell
 * shapes of measured profiles, a ring of sink round the upper half, sink between thermals from
 * conservation of mass. Its strength is calibrated once to the soaring-forecast rule a glider
 * climbs at w* less its sink (UPDRAFT_GAIN). FG's life cycle, lean and nearest-thermal rule stay.
 *
 * Lean. FG tilts the column by a fixed 2° per knot of a wind it blends linearly from the surface
 * to 9,000 ft. With the day's wind profile the column here leans as its air is carried instead:
 * the air rises at the thermal's core speed w and moves with the wind at each height, so at a
 * height h above the foot the column is ∫₀ʰ u(z) dz / w downwind of it (in 10 kt and 3 m/s,
 * about 60° from the vertical, where FG gives 20°). A glider circling in it climbs slower than
 * the air, so it still drifts out downwind and has to move upwind as it climbs, as in a real
 * thermal, at u·(sink/w) rather than at the full wind speed. As in FG the thermal's position is
 * its top (where the cumulus sits); the foot, where the sun and terrain trigger it, is upwind.
 */
import { sunPosition } from "./sun.ts";
import { advance, distanceM, mulberry32 } from "./util.ts";
import { soaringFrom, windAt, type Soaring, type Weather } from "./weather.ts";

/** Wind at a height [m MSL] over a ground height [m]. */
export type WindAtFn = (altM: number, groundM: number) => { fromDeg: number; kt: number };

const KT_TO_MS = 1852 / 3600;

/**
 * Where a thermal's air has been carried by the time it reaches each height: east and north
 * offsets [m] from the foot at heights 0, dz, 2dz, … above it, for air rising at `riseMs`.
 */
export function columnDrift(wind: WindAtFn, groundM: number, heightM: number, riseMs: number): { dz: number; east: Float64Array; north: Float64Array } {
  const steps = 40, dz = heightM / steps;
  const east = new Float64Array(steps + 1), north = new Float64Array(steps + 1);
  for (let k = 1; k <= steps; k++) {
    const v = wind(groundM + (k - 0.5) * dz, groundM);
    const to = ((v.fromDeg + 180) * Math.PI) / 180, run = (v.kt * KT_TO_MS * dz) / riseMs;
    east[k] = east[k - 1]! + Math.sin(to) * run;
    north[k] = north[k - 1]! + Math.cos(to) * run;
  }
  return { dz, east, north };
}

/** A point moved east and north [m] (small offsets). */
function offsetDeg(latDeg: number, lonDeg: number, eastM: number, northM: number): [number, number] {
  return [latDeg + northM / 111_132, lonDeg + eastM / (111_320 * Math.cos((latDeg * Math.PI) / 180))];
}

/*
 * NASA's updraft model: M. J. Allen, "Updraft Model for Development of Autonomous Soaring
 * Uninhabited Air Vehicles", AIAA 2006-1510 (NASA Dryden), ported from its Appendix B code
 * (run_model2_3.m). Built on measurements: the mean updraft and its radius through the
 * convective layer from Lenschow & Stephens (1980), the radial profiles of Konovalov (1970) as a
 * family of bell shapes, the ring of sinking air round a thermal's upper part (Bradbury), and the
 * sink between thermals from conservation of mass. (Where the paper's Table 3 and the code
 * differ, the code's fourth shape constant, which closes the updraft off near its outer radius,
 * is used: it is what made the paper's figures.)
 */

/** r1/r2 of the seven bell shapes and their constants k1–k4 (Allen, Appendix B). */
const SHAPE_R1R2 = [0.14, 0.25, 0.36, 0.47, 0.58, 0.69, 0.8];
const SHAPE_K: readonly (readonly [number, number, number, number])[] = [
  [1.5352, 2.5826, -0.0113, -0.195],
  [1.5265, 3.6054, -0.0176, -0.1265],
  [1.4866, 4.8356, -0.032, -0.0818],
  [1.2042, 7.7904, 0.0848, -0.0445],
  [0.8816, 13.972, 0.3404, -0.0216],
  [0.7067, 23.994, 0.5689, -0.0099],
  [0.6189, 42.7965, 0.7157, -0.0033],
];

/** Mean updraft over a thermal's area / w* at a height ratio z/zi (Allen eq. 11, from Lenschow). */
export function allenMeanUpdraft(zr: number): number {
  return zr <= 0 ? 0 : Math.cbrt(zr) * (1 - 1.1 * zr);
}

/** A thermal's outer radius / zi at a height ratio z/zi (Allen eq. 12, from Lenschow). */
export function allenRadius(zr: number): number {
  return zr <= 0 ? 0 : 0.102 * Math.cbrt(zr) * (1 - 0.25 * zr);
}

/**
 * Allen's updraft (run_model2_3): vertical air velocity [m/s] at `r` [m] from the centre of an
 * updraft of outer radius `r2` [m] whose mean updraft is `wt` [m/s], at height ratio `zr` (no
 * updraft core at or above zi), `wtbar` the mean updraft of the layer's average thermal there
 * (it sets the sink between thermals).
 */
export function allenUpdraft(r: number, r2In: number, wt: number, wtbar: number, zr: number): number {
  const r2 = Math.max(10, r2In);
  const r1r2 = r2 < 600 ? 0.0011 * r2 + 0.14 : 0.8;
  const r1 = r1r2 * r2;
  // Peak of the revolved trapezoid with this mean (eq. 15).
  const wc = (3 * wt * (r2 ** 3 - r2 ** 2 * r1)) / (r2 ** 3 - r1 ** 3);
  const rr2 = r / r2;
  let ws = 0;
  if (zr < 1) {
    let i = 0;
    while (i < SHAPE_R1R2.length - 1 && r1r2 >= 0.5 * (SHAPE_R1R2[i]! + SHAPE_R1R2[i + 1]!)) i++;
    const [ka, kb, kc, kd] = SHAPE_K[i]!;
    ws = Math.max(0, 1 / (1 + (ka * Math.abs(rr2 + kc)) ** kb) + kd * rr2);
  }
  // The ring of sinking air round the upper half of the layer (eqs. 17, 18).
  const w1 = r > r1 && rr2 < 2 ? (Math.PI / 6) * Math.sin(Math.PI * rr2) : 0;
  const swd = zr > 0.5 && zr <= 0.9 ? 2.5 * (zr - 0.5) : 0;
  const wd = Math.min(0, swd * w1);
  const w2 = ws * wc + wd * wt;
  // Sink between thermals: their upward mass flux balanced over the rest of the area, with
  // Allen's thermal count N = 0.6·X·Y/(zi·r2) (eqs. 20, 21): area fraction 0.6π·r2/zi.
  const f = 0.6 * Math.PI * allenRadius(Math.min(zr, 1));
  const we = Math.min(0, -(f * wtbar * (1 - swd)) / (1 - f));
  // Stretched to meet the sink at the edge (eq. 23).
  if (r <= r1 || Math.abs(wc) < 1e-9) return w2 + (r <= r1 ? 0 : we);
  return w2 * (1 - we / wc) + we;
}

/** The radius at which the calibration circles (a two-seat trainer at 40–45° bank, 80–85 km/h). */
export const CALIBRATION_CIRCLE_M = 65;

/**
 * How much stronger the thermals a glider uses are than Allen's average updraft: chosen so that
 * on the median day of Allen's data (w* 2.56 m/s, zi 1,401 m) a glider circling an average
 * thermal at mid-height, 65 m from its centre, meets air rising at w*, so that its vario reads w*
 * minus its own sink: the rule of RASP's soaring forecasts ("W*: average dry thermal updraft
 * strength near mid-BL height. Subtract glider descent rate to get average vario reading for
 * cloudless thermals", Glendening). Allen's thermals are every updraft Lenschow measured;
 * ours are the few a pilot centres in, one per 1.5 zi. About 1.46.
 */
export const UPDRAFT_GAIN = (() => {
  const zi = 1401, topRadius = Math.min(700, Math.max(180, 0.25 * zi)) / 2; // soaringFrom's width
  const r2 = (topRadius * allenRadius(0.5)) / allenRadius(1);
  const wt = allenMeanUpdraft(0.5);
  return 1 / allenUpdraft(CALIBRATION_CIRCLE_M, r2, wt, wt, 0.5);
})();

/** A weather thermal's updraft: the day's w*, this thermal's strength relative to the day's, cumulus or blue. */
export interface Updraft {
  wStarMs: number;
  gain: number;
  cumulus: boolean;
}

/**
 * The vertical air velocity [m/s] at `r` [m] from a thermal's centre at height ratio `zr` above
 * its foot (1 = its top: cloud base, or the top of the convective layer when blue), `topRadiusM`
 * its outer radius at the top (it narrows below as Allen's radius does). Under cumulus the
 * updraft keeps its strength from a quarter of the height up to the cloud base instead of
 * slowing into the top of the layer as dry thermals do (RASP: thermals are stronger than the dry
 * figure under cumulus, "cloudsuck"); nothing in or above the cloud, nor above a blue top.
 */
export function thermalUpdraft(r: number, zr: number, topRadiusM: number, u: Updraft): number {
  if (zr <= 0 || zr >= 1) return 0;
  const shape = u.cumulus ? allenMeanUpdraft(Math.min(zr, 0.25)) : allenMeanUpdraft(zr);
  const wtbar = UPDRAFT_GAIN * u.wStarMs * shape;
  const r2 = (topRadiusM * allenRadius(zr)) / allenRadius(1);
  return allenUpdraft(r, r2, wtbar * u.gain, wtbar, zr);
}

const FT_TO_M = 0.3048;
const NM_TO_FT = 6076.11549;

export interface ThermalSpec {
  latDeg: number;
  lonDeg: number;
  /** Thermal top (cloud base) [ft MSL]. FG scenario: height-msl. */
  heightMslFt: number;
  /** Maximum updraft [ft/s]. FG: strength-fps. */
  strengthFps: number;
  /** Diameter [ft]. FG: diameter-ft. */
  diameterFt: number;
  /** Ground elevation at the thermal's foot [ft]; re-sampled every 10 s as in FG when known. */
  groundElevFt: number;
}

export interface WindProfile {
  groundFromDeg: number;
  groundKt: number;
  aloftFromDeg: number;
  aloftKt: number;
}

export interface UserState {
  latDeg: number;
  lonDeg: number;
  /** Aircraft altitude [ft MSL]. */
  altFt: number;
}

/** get_strength_fac */
export function strengthFactor(altFrac: number): number {
  if (altFrac <= 0) return 0;
  if (altFrac <= 0.1) return 0.1 * Math.pow(10 * altFrac, 10);
  if (altFrac <= 1) return 0.4175 - 0.5825 * Math.cos(Math.PI * (1 - Math.sqrt(altFrac)) + Math.PI);
  if (altFrac < 1.1) return 0.5 * (1 + Math.cos(Math.PI * (-2 * altFrac * 5)));
  return 0;
}

export class Thermal {
  cycleTimer: number;
  /** Last computed lift for the user [ft/s] and distance to the slice centre [nm]. */
  strength = 0;
  range = Infinity;
  phase: "forming" | "formed" | "dying" | "dead" = "forming";
  /** Slice centre at the user's altitude (for display). */
  sliceLatDeg: number;
  sliceLonDeg: number;
  private readonly rUpFrac = 0.9;
  private groundTimer = Infinity;
  /** Stable identifier (e.g. for the cloud drawn over it). */
  id = "";
  /** The day no longer has room for it: it dies through its cycle and isn't reborn. */
  retiring = false;
  /** Retired and dead: its sky drops it. */
  gone = false;

  constructor(
    readonly spec: ThermalSpec,
    private readonly rand: () => number,
    /** Ground [m] at a position, if known, and the thermal top [m MSL] over a ground height. */
    private ground?: { at: (latDeg: number, lonDeg: number) => number | undefined; topM: (groundM: number) => number },
    /** The day's wind by height: the column leans as its air is carried (else FG's lean). */
    private windAt?: WindAtFn,
    /** The day's convection: Allen's updraft in place of FG's cosine core and sink ring. */
    public updraft?: Updraft,
  ) {
    this.cycleTimer = 60 * Math.floor(rand() * 31);
    this.sliceLatDeg = spec.latDeg;
    this.sliceLonDeg = spec.lonDeg;
  }

  private drift: { key: string; dz: number; east: Float64Array; north: Float64Array } | undefined;

  /** The column's offset [east, north m] from its foot at a height above the foot [m]. */
  private driftAt(hM: number): [number, number] {
    const s = this.spec, g = s.groundElevFt * FT_TO_M, top = Math.max(100, s.heightMslFt * FT_TO_M - g), w = Math.max(0.5, s.strengthFps * FT_TO_M);
    const key = `${g}|${top}|${w}`;
    // To 1.1 × the top: FG's thermal reaches that far above it.
    if (this.drift?.key !== key) this.drift = { key, ...columnDrift(this.windAt!, g, 1.1 * top + 50, w) };
    const d = this.drift, x = Math.max(0, Math.min(hM / d.dz, d.east.length - 1));
    const i = Math.floor(x), j = Math.min(i + 1, d.east.length - 1), f = x - i;
    return [d.east[i]! + f * (d.east[j]! - d.east[i]!), d.north[i]! + f * (d.north[j]! - d.north[i]!)];
  }

  /** Where the column starts on the ground (upwind of its top with the day's wind). */
  get footLatLon(): [number, number] {
    const s = this.spec;
    if (!this.windAt) return [s.latDeg, s.lonDeg];
    const [e, n] = this.driftAt(s.heightMslFt * FT_TO_M - s.groundElevFt * FT_TO_M);
    return offsetDeg(s.latDeg, s.lonDeg, -e, -n);
  }

  /**
   * The weather moved on (weather over time): this thermal's strength, width, top and lean from
   * it; its foot and its place in its life cycle stay.
   */
  retune(o: { strengthFps: number; diameterFt: number; updraft?: Updraft; topM: (groundM: number) => number; windAt?: WindAtFn }): void {
    const [lat, lon] = this.footLatLon;
    this.spec.strengthFps = o.strengthFps;
    this.spec.diameterFt = o.diameterFt;
    if (o.updraft) this.updraft = o.updraft;
    if (this.ground) this.ground = { at: this.ground.at, topM: o.topM };
    this.spec.heightMslFt = o.topM(this.spec.groundElevFt * FT_TO_M) / FT_TO_M;
    if (o.windAt) this.windAt = o.windAt;
    this.drift = undefined;
    this.standOn(lat, lon);
  }

  /** No longer wanted: straight into its dying phase (unless already there), not reborn. */
  retire(): void {
    if (this.retiring) return;
    this.retiring = true;
    this.cycleTimer = Math.max(this.cycleTimer, 20 * 60);
  }

  /** Stand the column on a foot (its top, the thermal's position, follows the wind's drift). */
  standOn(latDeg: number, lonDeg: number): void {
    const s = this.spec;
    const [e, n] = this.windAt ? this.driftAt(s.heightMslFt * FT_TO_M - s.groundElevFt * FT_TO_M) : [0, 0];
    [s.latDeg, s.lonDeg] = offsetDeg(latDeg, lonDeg, e, n);
  }

  /** FGAIThermal::Run */
  run(dt: number, user: UserState, wind: WindProfile): number {
    this.cycleTimer += dt;
    // FGAIThermal: ground elevation under the thermal, every 10 s.
    this.groundTimer += dt;
    if (this.ground && this.groundTimer >= 10) {
      const g = this.ground.at(...this.footLatLon);
      if (g !== undefined) {
        this.groundTimer = 0;
        this.spec.groundElevFt = g / FT_TO_M;
        this.spec.heightMslFt = this.ground.topM(g) / FT_TO_M;
      }
    }
    const tmin1 = 5, tmin2 = 20, tmin3 = 25, tmin4 = 30;
    const alive = tmin3 * 60;
    const t1 = tmin1 / tmin3, t2 = tmin2 / tmin3, t3 = 1, t4 = tmin4 / tmin3;
    const time = this.cycleTimer / alive;
    if (time >= t4) {
      if (this.retiring) this.gone = true;
      else this.cycleTimer = 60 * Math.floor(this.rand() * 31);
    }

    const s = this.spec;
    if (this.updraft) return this.runUpdraft(time, t1, t2, t3, user);
    const maxUp = s.strengthFps, minUp = -s.strengthFps * 0.25;
    const rMax = s.diameterFt / NM_TO_FT / 2; // nm, as FG (diameter-ft / 6076 / 2)
    const shaping = 0.8;
    const altitudeAglFt = s.heightMslFt - s.groundElevFt;
    const userAlt = Math.max(1, user.altFt);
    const userAgl = userAlt - s.groundElevFt;
    const altRel = userAgl / altitudeAglFt;
    const globalSink = -1;

    let avail: number;
    if (time <= t1) {
      const xx = time / t1;
      avail = xx * strengthFactor(altRel / xx);
      this.phase = "forming";
    } else if (time <= t2) {
      avail = strengthFactor(altRel);
      this.phase = "formed";
    } else if (time <= t3) {
      const xx = (time - t2) / (1 - t2);
      avail = strengthFactor(altRel - xx);
      this.phase = "dying";
    } else {
      avail = 0;
      this.phase = "dead";
    }

    let rSink: number;
    if (altRel >= 0 && altRel < 1) rSink = shaping * rMax + ((1 - shaping) * rMax * altRel) / altitudeAglFt; // as in FG
    else if (altRel >= 1 && altRel < 1.1) rSink = (rMax / 2) * (1 + Math.cos(10 * Math.PI * altRel - 2 * Math.PI));
    else rSink = 0;
    const rUp = this.rUpFrac * rSink;
    const vUpMax = avail * maxUp, vUpMin = avail * minUp;

    if (this.windAt) this.lean(altitudeAglFt * FT_TO_M, userAgl * FT_TO_M);
    else {
      // FG: lean by tan(2° per kt of wind) × height above the user. FG averages the two wind
      // directions' angles, which points the lean backwards when they lie either side of north
      // (350° and 010° give 180°); the mean of their directions is taken here instead.
      const groundFrom = Math.PI / 2 - (Math.PI * wind.groundFromDeg) / 180;
      const aloftFrom = Math.PI / 2 - (Math.PI * wind.aloftFromDeg) / 180;
      const windHeading = Math.PI + Math.atan2(Math.sin(groundFrom) + Math.sin(aloftFrom), Math.cos(groundFrom) + Math.cos(aloftFrom));
      const windKt = wind.groundKt + userAlt * ((wind.aloftKt - wind.groundKt) / 9000);
      const dCenter = -Math.tan(0.034906 * windKt) * (altitudeAglFt - userAgl);
      const latRad = (s.latDeg * Math.PI) / 180;
      const ftPerDegLat = 366468.96 - 3717.12 * Math.cos(latRad);
      const ftPerDegLon = 365228.16 * Math.cos(latRad);
      this.sliceLonDeg = s.lonDeg + (dCenter * Math.cos(windHeading)) / ftPerDegLon;
      this.sliceLatDeg = s.latDeg + (dCenter * Math.sin(windHeading)) / ftPerDegLat;
    }
    const dist = distanceM(this.sliceLatDeg, this.sliceLonDeg, user.latDeg, user.lonDeg) / 1852; // nm

    let vUp: number;
    if (dist < rUp) vUp = vUpMax * Math.cos((dist * Math.PI) / (2 * rUp));
    else if (dist <= (rUp + rSink) / 2) vUp = vUpMin * Math.cos(((dist - (rUp + rSink) / 2) * Math.PI) / (2 * ((rUp + rSink) / 2 - rUp)));
    else if (dist <= rSink) vUp = (globalSink + vUpMin) / 2 + ((globalSink - vUpMin) / 2) * Math.cos(((dist - rSink) * Math.PI) / ((rSink - rUp) / 2));
    else vUp = globalSink;
    if (altRel > 1 && altRel < 1.1 && dist > rSink) vUp = globalSink * (11 - 10 * altRel);
    if (altRel >= 1.1) vUp = 0;
    this.strength = vUp;
    this.range = dist;
    return vUp;
  }

  /** The column at a height above the foot [m], from its top: back along the drift above it. */
  private lean(topAglM: number, aglM: number): void {
    const s = this.spec;
    const [et, nt] = this.driftAt(topAglM), [eu, nu] = this.driftAt(aglM);
    [this.sliceLatDeg, this.sliceLonDeg] = offsetDeg(s.latDeg, s.lonDeg, eu - et, nu - nt);
  }

  /**
   * Run with Allen's updraft and FG's life cycle: while forming, the bubble rises from the
   * ground (the profile squeezed under the fraction of the height it has reached, as weak as
   * that fraction, as FG's); formed, the whole column; dying, its bottom lifts off the ground
   * (nothing below the fraction gone); dead, only the sink between thermals.
   */
  private runUpdraft(time: number, t1: number, t2: number, t3: number, user: UserState): number {
    const s = this.spec, u = this.updraft!;
    const topAglM = Math.max(1, (s.heightMslFt - s.groundElevFt) * FT_TO_M);
    const aglM = (Math.max(1, user.altFt) - s.groundElevFt) * FT_TO_M;
    const altRel = aglM / topAglM;
    let zr = altRel, amp = 1;
    if (time <= t1) {
      const xx = time / t1;
      (zr = altRel / Math.max(1e-6, xx)), (amp = xx);
      this.phase = "forming";
    } else if (time <= t2) this.phase = "formed";
    else if (time <= t3) {
      if (altRel < (time - t2) / (1 - t2)) amp = 0;
      this.phase = "dying";
    } else {
      amp = 0;
      this.phase = "dead";
    }
    if (this.windAt) this.lean(topAglM, aglM);
    else [this.sliceLatDeg, this.sliceLonDeg] = [s.latDeg, s.lonDeg];
    const distM = distanceM(this.sliceLatDeg, this.sliceLonDeg, user.latDeg, user.lonDeg);
    const topRadiusM = (s.diameterFt * FT_TO_M) / 2;
    // (Outside the updraft, above a forming bubble and under a dying one: the sink between thermals.)
    const w = amp > 0 && zr < 1 ? thermalUpdraft(distM, zr, topRadiusM, { ...u, gain: u.gain * amp }) : thermalUpdraft(1e9, altRel, topRadiusM, u);
    this.strength = w / FT_TO_M;
    this.range = distM / 1852;
    return this.strength;
  }

  /** Is the thermal producing lift (for drawing a cloud)? */
  get active(): boolean {
    return this.phase === "formed" || this.phase === "forming";
  }
}

export interface ThermalFieldOptions {
  seed: number;
  centerLatDeg: number;
  centerLonDeg: number;
  /** Thermals are placed within this radius [m]. */
  radiusM?: number;
  count?: number;
  /** Cloud base [m MSL]. */
  cloudBaseM?: number;
  /** Updraft range [m/s]. */
  strengthMs?: [number, number];
  /** Diameter range [m]. */
  diameterM?: [number, number];
  /** Ground elevation at a position [m], if known (else 0). */
  groundAt?: (latDeg: number, lonDeg: number) => number | undefined;
}

/** A deterministic set of FG thermals around a centre. */
export class ThermalField {
  readonly thermals: Thermal[] = [];
  /** FGAIManager: lift of the nearest thermal [ft/s]. */
  strengthFps = 0;

  constructor(o: ThermalFieldOptions) {
    const rand = mulberry32(o.seed);
    const radius = o.radiusM ?? 15_000;
    const [smin, smax] = o.strengthMs ?? [1.0, 3.0];
    const [dmin, dmax] = o.diameterM ?? [300, 700];
    const base = o.cloudBaseM ?? 1800;
    for (let i = 0; i < (o.count ?? 25); i++) {
      const r = radius * Math.sqrt(rand()), a = rand() * 2 * Math.PI;
      const lat = o.centerLatDeg + (r * Math.cos(a)) / 111_132;
      const lon = o.centerLonDeg + (r * Math.sin(a)) / (111_320 * Math.cos((o.centerLatDeg * Math.PI) / 180));
      const ground = o.groundAt?.(lat, lon) ?? 0; // until the terrain loads (then re-sampled)
      this.thermals.push(
        new Thermal(
          {
            latDeg: lat,
            lonDeg: lon,
            heightMslFt: Math.max(base, ground + 600) / FT_TO_M,
            strengthFps: (smin + rand() * (smax - smin)) / FT_TO_M,
            diameterFt: (dmin + rand() * (dmax - dmin)) / FT_TO_M,
            groundElevFt: ground / FT_TO_M,
          },
          rand,
          o.groundAt ? { at: o.groundAt, topM: (g) => Math.max(base, g + 600) } : undefined,
        ),
      );
    }
  }

  update(dt: number, user: UserState, wind: WindProfile): number {
    let nearest = Infinity;
    let strength = 0;
    for (const t of this.thermals) {
      t.run(dt, user, wind);
      if (t.range < nearest) {
        nearest = t.range;
        strength = t.strength;
      }
    }
    this.strengthFps = strength;
    return strength;
  }
}

export interface ThermalSkyOptions {
  seed: number;
  /** Cell size [m]: thermals are generated per cell, on demand. */
  cellM?: number;
  /** Thermals per cell: 1 + floor(rand · spread). */
  perCellSpread?: number;
  /** Cells within this many cells of the aircraft are alive (others are dropped). */
  radiusCells?: number;
  cloudBaseM?: number;
  strengthMs?: [number, number];
  diameterM?: [number, number];
  groundAt?: (latDeg: number, lonDeg: number) => number | undefined;
  /**
   * The day's weather: replaces cloudBaseM / strengthMs / diameterM / perCellSpread with
   * numbers, sizes and tops from the convective boundary layer, and places thermals where
   * terrain and sun trigger them (needs groundAt; cells wait until their terrain is loaded).
   */
  weather?: Weather;
}

/** Where thermals start: how well a spot is heated and how well it releases bubbles. */
export function triggerScore(groundAt: (lat: number, lon: number) => number | undefined, latDeg: number, lonDeg: number, sun: { azimuthDeg: number; elevationDeg: number }): number | undefined {
  const h = groundAt(latDeg, lonDeg);
  const D = 150;
  const n = groundAt(...advance(latDeg, lonDeg, 0, D)), e = groundAt(...advance(latDeg, lonDeg, 90, D));
  const sth = groundAt(...advance(latDeg, lonDeg, 180, D)), w = groundAt(...advance(latDeg, lonDeg, 270, D));
  if (h === undefined || n === undefined || e === undefined || sth === undefined || w === undefined) return undefined;
  // Sun on the slope relative to flat ground: south-east faces in the morning, south-west
  // in the afternoon heat most.
  const gx = (e - w) / (2 * D), gy = (n - sth) / (2 * D);
  const len = Math.hypot(gx, gy, 1);
  const r = Math.PI / 180, el = Math.max(5, sun.elevationDeg) * r, az = sun.azimuthDeg * r;
  const sx = Math.sin(az) * Math.cos(el), sy = Math.cos(az) * Math.cos(el), sz = Math.sin(el);
  const incidence = Math.max(0, (-gx * sx - gy * sy + sz) / len) / sz;
  // Hilltops and ridges release the warm air; hollows and valley floors collect it.
  let ring = 0, k = 0;
  for (let b = 0; b < 360; b += 45) {
    const g = groundAt(...advance(latDeg, lonDeg, b, 900));
    if (g !== undefined) { ring += g; k++; }
  }
  const prominence = k ? h - ring / k : 0;
  return incidence * (1 + 0.5 * Math.max(-1, Math.min(1, prominence / 120)));
}

const SKY_M_LAT = 111_132;
const SKY_M_LON = 111_320 * Math.cos((47 * Math.PI) / 180);

/** The sky cell [x, y] of a position (as ThermalSky cuts the sky; ids start with "x:y:"). */
export function skyCellOf(latDeg: number, lonDeg: number, cellM = 6000): [number, number] {
  return [Math.floor((lonDeg * SKY_M_LON) / cellM), Math.floor((latDeg * SKY_M_LAT) / cellM)];
}

/**
 * Thermals everywhere, for cross-country flight: the sky is cut into cells (degrees scaled to
 * metres at a fixed 47° reference), each holding a few FG thermals seeded from (seed, cell),
 * created when the aircraft comes within `radiusCells` and dropped well behind it. The same
 * seed always puts the same thermals in the same places; their life cycles start when their
 * cell first comes alive. As in FGAIManager, the nearest thermal decides the lift.
 */
/**
 * One thermal's width and strength relative to the day's mean. Widths are skewed: many narrow
 * thermals, a few wide ones (lognormal, σ = 0.5, mean 1, kept within 0.35–3); the wider ones
 * are stronger (∝ width^0.4, ±15 %, kept within 0.72–1.28: the old model's range of strength),
 * so the averages stay close to the day's. It was a uniform ±30 % width and a strength unrelated to it, so every
 * thermal, and the cumulus over it, came out about the same size.
 */
export function thermalSize(rand: () => number): { widthK: number; strengthK: number } {
  const SIGMA = 0.5;
  const u1 = Math.max(1e-9, rand()), u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const widthK = Math.min(3, Math.max(0.35, Math.exp(SIGMA * z - (SIGMA * SIGMA) / 2)));
  // Within the old model's range of strength (0.63–2.24 w* with the terrain factor).
  return { widthK, strengthK: Math.min(1.28, Math.max(0.72, widthK ** 0.4 * (0.85 + 0.3 * rand()))) };
}

/** A deterministic 32-bit mix of a cell's seed, an index and a stream tag. */
const mix = (h: number, k: number, tag: number) => (Math.imul(h ^ Math.imul(tag, 0x9e3779b9), 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0;

/** A place in a cell where a thermal may stand, scored by sun and terrain. */
interface Candidate {
  lat: number;
  lon: number;
  score: number;
  g: number;
}

/** One sky cell: its thermals by index; with weather, what they are generated from. */
interface SkyCell {
  thermals: (Thermal | undefined)[];
  /** Weather cells: the cell's seed, its ±40 % count factor, candidates so far, its sun. */
  h?: number;
  nFactor?: number;
  cand?: Candidate[];
  sun?: { azimuthDeg: number; elevationDeg: number };
}

export class ThermalSky {
  private readonly cells = new Map<string, SkyCell>();
  /** FGAIManager: lift of the nearest thermal [ft/s]. */
  strengthFps = 0;
  private readonly o: Required<Omit<ThermalSkyOptions, "groundAt" | "weather">> & Pick<ThermalSkyOptions, "groundAt" | "weather">;

  constructor(o: ThermalSkyOptions) {
    this.o = { cellM: 6000, perCellSpread: 3, radiusCells: 3, cloudBaseM: 1800, strengthMs: [1.0, 3.0], diameterM: [300, 700], ...o };
  }

  private soaring: Soaring | undefined;

  /**
   * The weather now (weather over time, weatherAt): every cell's thermals follow it. Each keeps
   * its place and its life cycle; strength, width, top and lean come from the new weather.
   * Where the day makes room for more (the morning) new ones start forming; where it has room
   * for fewer (a deeper layer spaces them wider, the evening), the spare ones die out through
   * their cycle and aren't reborn.
   */
  setWeather(w: Weather): void {
    if (!this.o.weather) return;
    this.o.weather = w;
    this.soaring = soaringFrom(w);
    for (const [key, cell] of this.cells) {
      const [x, y] = key.split(":").map(Number) as [number, number];
      this.fillCell(cell, x, y, w, false); // terrain missing for new candidates: as it was, next time
    }
  }

  /** Candidate j of a cell (its own random stream), or undefined while its terrain is loading. */
  private candidate(cell: SkyCell, cx: number, cy: number, j: number): Candidate | undefined {
    const o = this.o, ground = o.groundAt;
    const rand = mulberry32(mix(cell.h!, j, 1));
    const lat = ((cy + rand()) * o.cellM) / SKY_M_LAT, lon = ((cx + rand()) * o.cellM) / SKY_M_LON;
    const jitter = rand();
    if (!ground) return { lat, lon, score: 1, g: 0 };
    const score = triggerScore(ground, lat, lon, cell.sun!);
    const g = ground(lat, lon);
    if (score === undefined || g === undefined) return undefined;
    return { lat, lon, score: score * (0.5 + jitter), g };
  }

  /**
   * A weather cell's thermals for the weather `w`: as many as the day's spacing has room for
   * (±40 %, the cell's own factor), each the best of four candidates scored by terrain and sun;
   * kept, retuned, added or retired against what the cell had. False while terrain is missing.
   */
  private fillCell(cell: SkyCell, cx: number, cy: number, w: Weather, fresh: boolean): boolean {
    const o = this.o, ground = o.groundAt;
    const s = (this.soaring ??= soaringFrom(w));
    const n = s.wStarMs < 0.5 ? 0 : Math.round(((o.cellM * o.cellM) / (s.spacingM * s.spacingM)) * cell.nFactor!);
    const cand = cell.cand!;
    for (let j = cand.length; j < 4 * n; j++) {
      const c = this.candidate(cell, cx, cy, j);
      if (!c) return false;
      cand.push(c);
    }
    // The air mass's cloud base (or the convective layer's top on a blue day) is one height
    // above sea level; where the ground reaches it there is no thermal under a cumulus to have.
    const baseMsl = w.elevationM + s.thermalTopAglM;
    const topM = (_g: number) => baseMsl;
    const wind: WindAtFn = (alt) => windAt(w, alt);
    for (let k = 0; k < Math.max(n, cell.thermals.length); k++) {
      const t = cell.thermals[k];
      const c = k < n ? cand.slice(4 * k, 4 * k + 4).sort((a, b) => b.score - a.score)[0]! : undefined;
      // Shaded slopes don't go; nor ground at or above the cloud base.
      if (!c || c.score < 0.35 || c.g >= baseMsl) {
        t?.retire();
        continue;
      }
      // Its own size (widths lognormal, the wider stronger) and life-cycle streams.
      const { widthK, strengthK } = thermalSize(mulberry32(mix(cell.h!, k, 2)));
      const updraft: Updraft = { wStarMs: s.wStarMs, gain: strengthK * Math.min(1.4, Math.max(0.7, c.score)), cumulus: s.cumulus };
      const diameterM = s.diameterM * widthK;
      // Its core at mid-height (what the cloud over it and the column's lean go by).
      const strengthFps = thermalUpdraft(0, 0.5, diameterM / 2, updraft) / FT_TO_M, diameterFt = diameterM / FT_TO_M;
      if (t && !t.gone) {
        t.retiring = false;
        t.retune({ strengthFps, diameterFt, updraft, topM, windAt: wind });
        continue;
      }
      const nt = new Thermal(
        { latDeg: c.lat, lonDeg: c.lon, heightMslFt: topM(c.g) / FT_TO_M, strengthFps, diameterFt, groundElevFt: c.g / FT_TO_M },
        mulberry32(mix(cell.h!, k, 3)),
        ground ? { at: ground, topM } : undefined,
        wind,
        updraft,
      );
      // A cell coming alive has its thermals at all stages; one the day adds starts forming.
      if (!fresh) nt.cycleTimer = 0;
      // The sun and terrain trigger the foot; the wind carries the column (and its cloud) on.
      nt.standOn(c.lat, c.lon);
      nt.id = `${cx}:${cy}:${k}`;
      cell.thermals[k] = nt;
    }
    return true;
  }

  /** A new cell (fresh life cycles), or undefined while its terrain is loading. */
  private newCell(cx: number, cy: number): SkyCell | undefined {
    const o = this.o;
    const h = (Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x165667b1) ^ Math.imul(o.seed | 0, 0x9e3779b9)) >>> 0;
    const w = o.weather;
    if (w) {
      const cLat = ((cy + 0.5) * o.cellM) / SKY_M_LAT, cLon = ((cx + 0.5) * o.cellM) / SKY_M_LON;
      // Candidates are scored with the sun of the hour the cell came alive (they stay put).
      const cell: SkyCell = { thermals: [], h, nFactor: 0.6 + 0.8 * mulberry32(h)(), cand: [], sun: sunPosition(new Date(w.timeUtc), cLat, cLon) };
      return this.fillCell(cell, cx, cy, w, true) ? cell : undefined;
    }
    const rand = mulberry32(h);
    const n = 1 + Math.floor(rand() * o.perCellSpread);
    const [smin, smax] = o.strengthMs, [dmin, dmax] = o.diameterM;
    const dMean = (dmin + dmax) / 2, sMean = (smin + smax) / 2;
    const out: Thermal[] = [];
    for (let k = 0; k < n; k++) {
      const lat = ((cy + rand()) * o.cellM) / SKY_M_LAT;
      const lon = ((cx + rand()) * o.cellM) / SKY_M_LON;
      const ground = o.groundAt?.(lat, lon) ?? 0;
      const t = new Thermal(
        {
          latDeg: lat,
          lonDeg: lon,
          heightMslFt: Math.max(o.cloudBaseM, ground + 600) / FT_TO_M,
          ...((size) => ({ strengthFps: (sMean * size.strengthK) / FT_TO_M, diameterFt: (dMean * size.widthK) / FT_TO_M }))(thermalSize(rand)),
          groundElevFt: ground / FT_TO_M,
        },
        rand,
        o.groundAt ? { at: o.groundAt, topM: (g) => Math.max(o.cloudBaseM, g + 600) } : undefined,
      );
      t.id = `${cx}:${cy}:${k}`;
      out.push(t);
    }
    return { thermals: out };
  }

  /** Cloud base [m MSL] of the day, if the weather makes cumulus. */
  get cumulusBaseM(): number | undefined {
    const w = this.o.weather;
    if (!w) return this.o.cloudBaseM;
    const s = (this.soaring ??= soaringFrom(w));
    return s.cumulus ? w.elevationM + s.cloudBaseAglM : undefined;
  }

  /**
   * The thermals of one cell, generated deterministically (fresh life cycles); with weather,
   * undefined until the cell's terrain is loaded.
   */
  cellThermals(cx: number, cy: number): Thermal[] | undefined {
    return this.newCell(cx, cy)?.thermals.filter((t): t is Thermal => !!t);
  }

  /** Fresh thermals of all cells within `radiusM` of a point (e.g. to choose a start). */
  thermalsAround(latDeg: number, lonDeg: number, radiusM: number): Thermal[] {
    const c = this.o.cellM, r = Math.ceil(radiusM / c);
    const cx = Math.floor((lonDeg * SKY_M_LON) / c), cy = Math.floor((latDeg * SKY_M_LAT) / c);
    const out: Thermal[] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(...(this.cellThermals(cx + dx, cy + dy) ?? []));
    return out.filter((t) => distanceM(t.spec.latDeg, t.spec.lonDeg, latDeg, lonDeg) <= radiusM);
  }

  /** Thermals currently alive (around the aircraft). */
  get thermals(): Thermal[] {
    const out: Thermal[] = [];
    for (const c of this.cells.values()) for (const t of c.thermals) if (t) out.push(t);
    return out;
  }

  update(dt: number, user: UserState, wind: WindProfile): number {
    const o = this.o, c = o.cellM, r = o.radiusCells;
    const cx = Math.floor((user.lonDeg * SKY_M_LON) / c), cy = Math.floor((user.latDeg * SKY_M_LAT) / c);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const key = `${cx + dx}:${cy + dy}`;
        if (!this.cells.has(key)) {
          const cell = this.newCell(cx + dx, cy + dy);
          if (cell) this.cells.set(key, cell); // else: terrain still loading, retry next update
        }
      }
    for (const key of this.cells.keys()) {
      const [x, y] = key.split(":").map(Number) as [number, number];
      if (Math.abs(x - cx) > r + 2 || Math.abs(y - cy) > r + 2) this.cells.delete(key);
    }
    let nearest = Infinity, strength = 0;
    for (const cell of this.cells.values())
      cell.thermals.forEach((t, k) => {
        if (!t) return;
        t.run(dt, user, wind);
        if (t.gone) {
          cell.thermals[k] = undefined;
          return;
        }
        if (t.range < nearest) {
          nearest = t.range;
          strength = t.strength;
        }
      });
    this.strengthFps = strength;
    return strength;
  }
}
