/**
 * Thermals, ported from FlightGear's FGAIThermal (src/AIModel/AIThermal.cxx, David Culp and
 * Patrice Poly, GPL-2.0+) and the nearest-thermal rule of FGAIManager::processThermal:
 *  - 30-minute life cycle: forming (0–5 min), formed (–20), dying (–25), dead (–30), reborn
 *  - vertical profile get_strength_fac(altitude / thermal top)
 *  - the column leans downwind (slice centre moves with height)
 *  - updraft core (cosine), sink ring around it, -1 ft/s global sink outside
 * FlightGear's rand() calls use a seeded generator here, so a seed reproduces the sky.
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

  constructor(
    readonly spec: ThermalSpec,
    private readonly rand: () => number,
    /** Ground [m] at a position, if known, and the thermal top [m MSL] over a ground height. */
    private readonly ground?: { at: (latDeg: number, lonDeg: number) => number | undefined; topM: (groundM: number) => number },
    /** The day's wind by height: the column leans as its air is carried (else FG's lean). */
    private readonly windAt?: WindAtFn,
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

    if (this.windAt) {
      // The column at the user's height, from its top: back along the drift above the user.
      const [et, nt] = this.driftAt(altitudeAglFt * FT_TO_M), [eu, nu] = this.driftAt(userAgl * FT_TO_M);
      [this.sliceLatDeg, this.sliceLonDeg] = offsetDeg(s.latDeg, s.lonDeg, eu - et, nu - nt);
    } else {
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

export class ThermalSky {
  private readonly cells = new Map<string, Thermal[]>();
  /** FGAIManager: lift of the nearest thermal [ft/s]. */
  strengthFps = 0;
  private readonly o: Required<Omit<ThermalSkyOptions, "groundAt" | "weather">> & Pick<ThermalSkyOptions, "groundAt" | "weather">;

  constructor(o: ThermalSkyOptions) {
    this.o = { cellM: 6000, perCellSpread: 3, radiusCells: 3, cloudBaseM: 1800, strengthMs: [1.0, 3.0], diameterM: [300, 700], ...o };
  }

  private soaring: Soaring | undefined;
  private sun: { azimuthDeg: number; elevationDeg: number } | undefined;

  /** Weather-driven thermals of a cell, or undefined while its terrain is still loading. */
  private weatherCell(cx: number, cy: number, w: Weather, rand: () => number): Thermal[] | undefined {
    const o = this.o, ground = o.groundAt;
    const s = (this.soaring ??= soaringFrom(w));
    if (s.wStarMs < 0.5) return [];
    const cLat = ((cy + 0.5) * o.cellM) / SKY_M_LAT, cLon = ((cx + 0.5) * o.cellM) / SKY_M_LON;
    this.sun ??= sunPosition(new Date(w.timeUtc), cLat, cLon);
    // Expected count from the spacing, ±40 %.
    const n = Math.round(((o.cellM * o.cellM) / (s.spacingM * s.spacingM)) * (0.6 + 0.8 * rand()));
    // Candidates scored by terrain and sun; the best of each group of four become thermals.
    const cand: { lat: number; lon: number; score: number; g: number }[] = [];
    for (let k = 0; k < n * 4; k++) {
      const lat = ((cy + rand()) * o.cellM) / SKY_M_LAT, lon = ((cx + rand()) * o.cellM) / SKY_M_LON;
      const jitter = rand();
      if (!ground) {
        cand.push({ lat, lon, score: 1, g: 0 });
        continue;
      }
      const score = triggerScore(ground, lat, lon, this.sun);
      const g = ground(lat, lon);
      if (score === undefined || g === undefined) return undefined;
      cand.push({ lat, lon, score: score * (0.5 + jitter), g });
    }
    const baseMsl = w.elevationM + s.thermalTopAglM;
    const topM = (g: number) => Math.max(baseMsl, g + 0.6 * s.thermalTopAglM, g + 300);
    const wind: WindAtFn = (alt, g) => windAt(w, alt, g);
    const out: Thermal[] = [];
    for (let k = 0; k < n; k++) {
      const group = cand.slice(4 * k, 4 * k + 4).sort((a, b) => b.score - a.score);
      const c = group[0]!;
      if (c.score < 0.35) continue; // shaded slopes don't go
      const { widthK, strengthK } = thermalSize(rand);
      const strengthMs = s.wStarMs * 1.25 * strengthK * Math.min(1.4, Math.max(0.7, c.score));
      const t = new Thermal(
        {
          latDeg: c.lat,
          lonDeg: c.lon,
          heightMslFt: topM(c.g) / FT_TO_M,
          strengthFps: strengthMs / FT_TO_M,
          diameterFt: (s.diameterM * widthK) / FT_TO_M,
          groundElevFt: c.g / FT_TO_M,
        },
        rand,
        ground ? { at: ground, topM } : undefined,
        wind,
      );
      // The sun and terrain trigger the foot; the wind carries the column (and its cloud) on.
      t.standOn(c.lat, c.lon);
      t.id = `${cx}:${cy}:${k}`;
      out.push(t);
    }
    return out;
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
    const o = this.o;
    if (o.weather) {
      const h = (Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x165667b1) ^ Math.imul(o.seed | 0, 0x9e3779b9)) >>> 0;
      return this.weatherCell(cx, cy, o.weather, mulberry32(h));
    }
    const h = (Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x165667b1) ^ Math.imul(o.seed | 0, 0x9e3779b9)) >>> 0;
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
    return out;
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
    return [...this.cells.values()].flat();
  }

  update(dt: number, user: UserState, wind: WindProfile): number {
    const o = this.o, c = o.cellM, r = o.radiusCells;
    const cx = Math.floor((user.lonDeg * SKY_M_LON) / c), cy = Math.floor((user.latDeg * SKY_M_LAT) / c);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const key = `${cx + dx}:${cy + dy}`;
        if (!this.cells.has(key)) {
          const ts = this.cellThermals(cx + dx, cy + dy);
          if (ts) this.cells.set(key, ts); // else: terrain still loading, retry next update
        }
      }
    for (const key of this.cells.keys()) {
      const [x, y] = key.split(":").map(Number) as [number, number];
      if (Math.abs(x - cx) > r + 2 || Math.abs(y - cy) > r + 2) this.cells.delete(key);
    }
    let nearest = Infinity, strength = 0;
    for (const ts of this.cells.values())
      for (const t of ts) {
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
