/**
 * Thermals, ported from FlightGear's FGAIThermal (src/AIModel/AIThermal.cxx, David Culp and
 * Patrice Poly, GPL-2.0+) and the nearest-thermal rule of FGAIManager::processThermal:
 *  - 30-minute life cycle: forming (0–5 min), formed (–20), dying (–25), dead (–30), reborn
 *  - vertical profile get_strength_fac(altitude / thermal top)
 *  - the column leans downwind (slice centre moves with height)
 *  - updraft core (cosine), sink ring around it, -1 ft/s global sink outside
 * FlightGear's rand() calls use a seeded generator here, so a seed reproduces the sky.
 */
import { distanceM, mulberry32 } from "./util.ts";

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

  constructor(
    readonly spec: ThermalSpec,
    private readonly rand: () => number,
    /** Ground [m] at a position, if known; with a cloud base [m] the top follows the ground. */
    private readonly ground?: { at: (latDeg: number, lonDeg: number) => number | undefined; cloudBaseM: number },
  ) {
    this.cycleTimer = 60 * Math.floor(rand() * 31);
    this.sliceLatDeg = spec.latDeg;
    this.sliceLonDeg = spec.lonDeg;
  }

  /** FGAIThermal::Run */
  run(dt: number, user: UserState, wind: WindProfile): number {
    this.cycleTimer += dt;
    // FGAIThermal: ground elevation under the thermal, every 10 s.
    this.groundTimer += dt;
    if (this.ground && this.groundTimer >= 10) {
      const g = this.ground.at(this.spec.latDeg, this.spec.lonDeg);
      if (g !== undefined) {
        this.groundTimer = 0;
        this.spec.groundElevFt = g / FT_TO_M;
        this.spec.heightMslFt = Math.max(this.ground.cloudBaseM, g + 600) / FT_TO_M;
      }
    }
    const tmin1 = 5, tmin2 = 20, tmin3 = 25, tmin4 = 30;
    const alive = tmin3 * 60;
    const t1 = tmin1 / tmin3, t2 = tmin2 / tmin3, t3 = 1, t4 = tmin4 / tmin3;
    const time = this.cycleTimer / alive;
    if (time >= t4) this.cycleTimer = 60 * Math.floor(this.rand() * 31);

    const s = this.spec;
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

    // Drift of the column with height: lean by tan(2° per kt of wind) × height above the user.
    const groundFrom = Math.PI / 2 - (Math.PI * wind.groundFromDeg) / 180;
    const aloftFrom = Math.PI / 2 - (Math.PI * wind.aloftFromDeg) / 180;
    const windHeading = Math.PI + 0.5 * (groundFrom + aloftFrom);
    const windKt = wind.groundKt + userAlt * ((wind.aloftKt - wind.groundKt) / 9000);
    const dCenter = -Math.tan(0.034906 * windKt) * (altitudeAglFt - userAgl);
    const latRad = (s.latDeg * Math.PI) / 180;
    const ftPerDegLat = 366468.96 - 3717.12 * Math.cos(latRad);
    const ftPerDegLon = 365228.16 * Math.cos(latRad);
    this.sliceLonDeg = s.lonDeg + (dCenter * Math.cos(windHeading)) / ftPerDegLon;
    this.sliceLatDeg = s.latDeg + (dCenter * Math.sin(windHeading)) / ftPerDegLat;
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
          o.groundAt ? { at: o.groundAt, cloudBaseM: base } : undefined,
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
