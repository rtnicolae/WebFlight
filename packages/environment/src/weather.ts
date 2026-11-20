/**
 * The day's weather at a place and time, and what it means for soaring.
 *
 * Live: Open-Meteo's forecast API (free, no key; hourly model data, past days included):
 * 2 m temperature and dew point, wind at 10, 80, 120 and 180 m and gusts, wind at the pressure
 * levels from 925 to 600 hPa, low and high cloud cover, global shortwave radiation and the
 * boundary-layer height. Without a connection the same quantities are estimated from the sun's
 * height (clear sky, light westerly).
 *
 * Soaring from those (standard convective boundary-layer rules of thumb):
 *  - cumulus base = lifting condensation level of the mixed-layer parcel (mixedLayerLcl), else
 *    ≈ 125 m × (T − Td) above ground from the 2 m values
 *  - thermals reach the top of the boundary layer zi (or cloud base, if lower); if the
 *    condensation level is above zi the thermals are blue (no cumulus)
 *  - convective velocity scale w* = (g/T · Q · zi)^(1/3), Q the surface kinematic heat flux,
 *    taken as ~35 % of the shortwave radiation (sensible share over land) / (ρ·cp)
 *  - thermal spacing ≈ 1.5 zi, diameter ≈ 0.25 zi
 * A Weather value is plain data, so a recorded day replays exactly (gym, bug reports).
 */
import { sunPosition } from "./sun.ts";
import type { SoundingLevel } from "./waves.ts";

export interface WindLevel {
  /** Height above mean sea level [m]. */
  altM: number;
  fromDeg: number;
  kt: number;
  /** Pressure [hPa] and temperature [°C] of a pressure level (for its stability: mountain waves). */
  hPa?: number;
  tempC?: number;
  /** Dew point [°C] of a pressure level (for the mixed-layer parcel: cloud base). */
  dewPointC?: number;
}

/** A wind level at a height above the ground (FlightGear's "boundary" layers). */
export interface BoundaryWind {
  /** Height above the ground [m]. */
  aglM: number;
  fromDeg: number;
  kt: number;
}

export interface Weather {
  /**
   * "forecast": Open-Meteo forecast models (the last 92 days to 16 days ahead), "archive":
   * Open-Meteo historical reanalysis (ERA5 / ECMWF IFS, any day since 1940), "estimated":
   * sun-based, offline.
   */
  source: "forecast" | "archive" | "estimated";
  /** Valid time (ISO, UTC). */
  timeUtc: string;
  /** Local time offset from UTC [h] at the place. */
  utcOffsetH: number;
  /** Ground height of the model grid point [m] (Open-Meteo `elevation`). */
  elevationM: number;
  tempC: number;
  dewPointC: number;
  /** 10 m wind. */
  windFromDeg: number;
  windKt: number;
  gustKt: number;
  /** Winds aloft at pressure levels (925 to 600 hPa), by height above sea level. */
  aloft: WindLevel[];
  /** Winds near the ground above the 10 m one (80, 120, 180 m; 100 m in the reanalysis). */
  boundary?: BoundaryWind[];
  /** Low cloud cover [0–1]. */
  lowCloud: number;
  /** High cloud cover [0–1] (cirrus; only drawn, the simulation doesn't use it). */
  highCloud?: number;
  /** Global shortwave radiation at the ground [W/m²]. */
  shortwaveWm2: number;
  /** Convective boundary-layer depth above ground [m]. */
  boundaryLayerM: number;
  /** Surface pressure [hPa] at the model's ground (with the levels' dew points: the mixed-layer parcel). */
  surfacePressureHpa?: number;
  /** Visibility [m] (the forecast's; the reanalysis has none). Only drawn: the haze. */
  visibilityM?: number;
  /** Why the estimate was used (e.g. "Open-Meteo: daily request limit reached"). */
  note?: string;
}

export interface Soaring {
  /** Cumulus base above ground [m] (the condensation level). */
  cloudBaseAglM: number;
  /** Thermal tops above ground [m]: the lower of cloud base and boundary layer. */
  thermalTopAglM: number;
  /** Cumulus mark the thermals (else blue thermals). */
  cumulus: boolean;
  /** Convective velocity scale w* [m/s]; 0 when there is no convection. */
  wStarMs: number;
  /** Mean distance between thermals [m]. */
  spacingM: number;
  /** Typical thermal diameter [m]. */
  diameterM: number;
}

const G = 9.81;
const RHO_CP = 1.2 * 1005;

/**
 * Lifting condensation level [m above the model's ground] of the mixed-layer parcel, as severe-
 * weather and soaring forecasts lift it in the afternoon (the US Storm Prediction Center's
 * "ML" parcel): potential temperature and mixing ratio averaged over the lowest 100 hPa (the
 * 2 m values and the pressure levels in it, by pressure), lifted dry-adiabatically until it
 * saturates; the temperature there from Bolton (1980, eq. 15). The 2 m air alone is moister than
 * the mixed layer and puts the base too low (12 Nov 2026 at Ghimbav: 150 m against 560 m).
 * Undefined without the levels' dew points and the surface pressure (the reanalysis).
 */
export function mixedLayerLcl(w: Pick<Weather, "tempC" | "dewPointC" | "surfacePressureHpa" | "aloft">): number | undefined {
  const ps = w.surfacePressureHpa;
  if (ps === undefined) return undefined;
  const es = (t: number) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  const mix = (td: number, p: number) => (0.622 * es(td)) / (p - es(td));
  const pts = [{ p: ps, th: (w.tempC + 273.15) * (1000 / ps) ** 0.286, r: mix(w.dewPointC, ps) }];
  for (const l of [...w.aloft].sort((a, b) => (b.hPa ?? 0) - (a.hPa ?? 0)))
    if (l.hPa !== undefined && l.tempC !== undefined && l.dewPointC !== undefined && l.hPa < ps) pts.push({ p: l.hPa, th: (l.tempC + 273.15) * (1000 / l.hPa) ** 0.286, r: mix(l.dewPointC, l.hPa) });
  if (pts.length < 2 || pts[1]!.p < ps - 100) return undefined;
  // Trapezoids in pressure from the surface to 100 hPa above it.
  const top = ps - 100;
  let th = 0, r = 0;
  for (let i = 0; i + 1 < pts.length && pts[i]!.p > top; i++) {
    const a = pts[i]!, b = pts[i + 1]!, pb = Math.max(b.p, top), f = (a.p - pb) / (a.p - b.p);
    const thb = a.th + (b.th - a.th) * f, rb = a.r + (b.r - a.r) * f;
    th += ((a.th + thb) / 2) * (a.p - pb);
    r += ((a.r + rb) / 2) * (a.p - pb);
  }
  const depth = ps - Math.max(top, pts[pts.length - 1]!.p);
  th /= depth;
  r /= depth;
  // The parcel at the surface: temperature and dew point (from its vapour pressure).
  const T = th * (ps / 1000) ** 0.286, e = (r * ps) / (0.622 + r), lnE = Math.log(e / 6.112);
  const Td = 273.15 + (243.5 * lnE) / (17.67 - lnE);
  const Tlcl = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56; // Bolton (1980), eq. 15
  return Math.max(0, (T - Tlcl) / 0.00976); // dry adiabat: 9.76 K per km
}

export function soaringFrom(w: Weather): Soaring {
  const spread = Math.max(0, w.tempC - w.dewPointC);
  const lcl = mixedLayerLcl(w) ?? Math.max(150, 125 * spread);
  const zi = Math.max(0, w.boundaryLayerM);
  const q = (0.35 * Math.max(0, w.shortwaveWm2)) / RHO_CP;
  const wStar = zi > 200 && q > 0.01 ? Math.cbrt((G / (w.tempC + 273.15)) * q * zi) : 0;
  const top = Math.min(lcl, zi);
  return {
    cloudBaseAglM: lcl,
    thermalTopAglM: top,
    cumulus: lcl <= zi + 100 && wStar > 0.5,
    wStarMs: wStar,
    spacingM: Math.max(1500, 1.5 * Math.max(zi, 800)),
    diameterM: Math.min(700, Math.max(180, 0.25 * top)),
  };
}

/**
 * The levels of the wind profile over a ground height [m], layered as FlightGear does
 * (environment_ctrl.cxx): the surface wind (10 m) and the boundary levels above that ground, the
 * pressure levels at their heights above sea level. Pressure levels less than FG's 500 ft
 * boundary transition above the top boundary level are left out, so the wind blends from the one
 * to the other over at least that height.
 *
 * The ground is the weather model's own (its grid's mean terrain, `elevationM`), the default of
 * windAt: its near-ground winds belong to that height. Over terrain far above it they are not
 * the air there: 150 m above a 2,000 m crest near Brașov (model ground 620 m) on 12 Nov 2026 they
 * gave the valley's 9 kt, where the free air at that height blew 25–40 kt.
 */
export function windLevels(w: Pick<Weather, "windFromDeg" | "windKt" | "aloft" | "boundary">, groundM: number): WindLevel[] {
  const near: WindLevel[] = [{ altM: groundM + 10, fromDeg: w.windFromDeg, kt: w.windKt }, ...(w.boundary ?? []).filter((l) => l.aglM > 10).map((l) => ({ altM: groundM + l.aglM, fromDeg: l.fromDeg, kt: l.kt }))].sort((a, b) => a.altM - b.altM);
  const top = near[near.length - 1]!.altM + 500 * 0.3048;
  return [...near, ...w.aloft.filter((l) => l.altM >= top).sort((a, b) => a.altM - b.altM)];
}

/**
 * Wind at a height [m MSL] (over the weather model's ground unless another is given): the
 * vector linear in height between the levels of windLevels, the end levels' wind beyond them.
 */
export function windAt(w: Pick<Weather, "elevationM" | "windFromDeg" | "windKt" | "aloft" | "boundary">, altM: number, groundM = w.elevationM): { fromDeg: number; kt: number } {
  const levels = windLevels(w, groundM);
  if (altM <= levels[0]!.altM) return { fromDeg: levels[0]!.fromDeg, kt: levels[0]!.kt };
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1]!, b = levels[i]!;
    if (altM <= b.altM) {
      const f = (altM - a.altM) / (b.altM - a.altM);
      // Interpolate the wind vector, not the angle.
      const D = Math.PI / 180;
      const x = (1 - f) * a.kt * Math.sin(a.fromDeg * D) + f * b.kt * Math.sin(b.fromDeg * D);
      const y = (1 - f) * a.kt * Math.cos(a.fromDeg * D) + f * b.kt * Math.cos(b.fromDeg * D);
      return { fromDeg: ((Math.atan2(x, y) / D) + 360) % 360, kt: Math.hypot(x, y) };
    }
  }
  const top = levels[levels.length - 1]!;
  return { fromDeg: top.fromDeg, kt: top.kt };
}

/** The pressure levels with a temperature (what mountain waves are computed from); empty for the reanalysis. */
export function sounding(w: Pick<Weather, "aloft">): SoundingLevel[] {
  return w.aloft.flatMap((l) => (l.hPa !== undefined && l.tempC !== undefined ? [{ altM: l.altM, hPa: l.hPa, tempC: l.tempC, fromDeg: l.fromDeg, kt: l.kt }] : []));
}

/**
 * Roughness length of open, level ground with low grass [m]: WMO's standard exposure for
 * wind measured at 10 m (WMO-No. 8, Davenport class "open", z0 = 0.03 m).
 */
export const OPEN_TERRAIN_Z0_M = 0.03;

/**
 * Wind below 10 m relative to the 10 m wind: the logarithmic surface-layer profile
 * u(z) = u10 · ln(z/z0) / ln(10/z0) (neutral; taken no lower than 0.5 m). 1 at 10 m and above.
 */
export function surfaceLayerFactor(aglM: number, z0 = OPEN_TERRAIN_Z0_M): number {
  if (aglM >= 10) return 1;
  return Math.log(Math.max(0.5, aglM) / z0) / Math.log(10 / z0);
}

export const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
/** Historical weather (reanalysis): surface and 100 m only, no pressure levels. */
export const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const ARCHIVE_HOURLY = ["temperature_2m", "dew_point_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "wind_speed_100m", "wind_direction_100m", "cloud_cover_low", "cloud_cover_high", "shortwave_radiation", "boundary_layer_height"];
/** The forecast API serves up to 92 past days; older days come from the archive. */
export const FORECAST_PAST_DAYS = 90;
/** Pressure levels asked for winds and temperatures aloft (≈ 0.8, 1, 1.5, 2, 3, 4.2, 5.6 and 7.2 km). */
const LEVELS_HPA = [925, 900, 850, 800, 700, 600, 500, 400];
/** Model wind heights near the ground [m] (the forecast's; the reanalysis has 100 m). */
const BOUNDARY_M = [80, 120, 180];
const HOURLY = [
  "temperature_2m",
  "dew_point_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  ...BOUNDARY_M.flatMap((m) => [`wind_speed_${m}m`, `wind_direction_${m}m`]),
  ...LEVELS_HPA.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`, `temperature_${p}hPa`, `dew_point_${p}hPa`]),
  "surface_pressure",
  "visibility",
  "cloud_cover_low",
  "cloud_cover_high",
  "shortwave_radiation",
  "boundary_layer_height",
];

/** Hourly data for local days `from`..`to` (yyyy-mm-dd; forecast range, ~3 months back to 16 days ahead). */
export function openMeteoUrl(latDeg: number, lonDeg: number, from: string, to: string, archive = false): string {
  return `${archive ? OPEN_METEO_ARCHIVE : OPEN_METEO}?latitude=${latDeg.toFixed(4)}&longitude=${lonDeg.toFixed(4)}&hourly=${(archive ? ARCHIVE_HOURLY : HOURLY).join(",")}&wind_speed_unit=kn&timezone=auto&timeformat=unixtime&start_date=${from}&end_date=${to}`;
}

interface OpenMeteoResponse {
  elevation?: number;
  /** The zone's offset now, not on the dates asked (2026-11: 7200 for Bucharest in July). */
  utc_offset_seconds?: number;
  /** IANA name with timezone=auto, e.g. "Europe/Bucharest". */
  timezone?: string;
  /** With timeformat=unixtime, `time` is UTC seconds (docs: local ISO times ignore DST changes). */
  hourly?: Record<string, (number | null)[] | undefined> & { time?: number[] };
}

/**
 * The hour of an Open-Meteo forecast response nearest `when`. Missing values fall back to
 * the sun-based estimate for that quantity.
 */
export function parseOpenMeteo(json: OpenMeteoResponse, latDeg: number, lonDeg: number, when: Date, source: "forecast" | "archive" = "forecast"): Weather {
  const times = json.hourly?.time;
  if (!json.hourly || !times?.length) throw new Error("open-meteo: no hourly data");
  let best = 0, bestDt = Infinity;
  for (let i = 0; i < times.length; i++) {
    const dt = Math.abs(times[i]! * 1000 - when.getTime());
    if (dt < bestDt) { bestDt = dt; best = i; }
  }
  return parseHour(json, best, latDeg, lonDeg, when, source);
}

/** Every hour of an Open-Meteo response, in time order: the series weatherAt() interpolates. */
export function parseOpenMeteoHours(json: OpenMeteoResponse, latDeg: number, lonDeg: number, source: "forecast" | "archive" = "forecast"): Weather[] {
  const times = json.hourly?.time;
  if (!json.hourly || !times?.length) throw new Error("open-meteo: no hourly data");
  return times.map((t, i) => parseHour(json, i, latDeg, lonDeg, new Date(t * 1000), source)).sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
}

/** Hour `best` of a response; missing values from the estimate for `when`. */
function parseHour(json: OpenMeteoResponse, best: number, latDeg: number, lonDeg: number, when: Date, source: "forecast" | "archive"): Weather {
  const h = json.hourly!;
  const times = h.time!;
  const offset = json.utc_offset_seconds ?? 0;
  const est = estimateWeather(latDeg, lonDeg, when, json.elevation ?? 0);
  const v = (k: string): number | undefined => {
    const a = h[k];
    const x = a?.[best];
    return typeof x === "number" && Number.isFinite(x) ? x : undefined;
  };
  const g = json.elevation ?? 0;
  const aloft: WindLevel[] = [];
  for (const p of LEVELS_HPA) {
    const kt = v(`wind_speed_${p}hPa`), dir = v(`wind_direction_${p}hPa`), z = v(`geopotential_height_${p}hPa`) ?? (p === 850 ? 1500 : p === 700 ? 3000 : undefined);
    // (A level below the model's ground is extrapolated: not air anyone flies in.)
    const t = v(`temperature_${p}hPa`), td = v(`dew_point_${p}hPa`);
    if (kt !== undefined && dir !== undefined && z !== undefined && z > g + 10) aloft.push({ altM: z, fromDeg: dir, kt, hPa: p, ...(t !== undefined ? { tempC: t } : {}), ...(td !== undefined ? { dewPointC: td } : {}) });
  }
  aloft.sort((a, b) => a.altM - b.altM);
  const boundary: BoundaryWind[] = [];
  for (const m of [...BOUNDARY_M, 100]) {
    const kt = v(`wind_speed_${m}m`), dir = v(`wind_direction_${m}m`);
    if (kt !== undefined && dir !== undefined) boundary.push({ aglM: m, fromDeg: dir, kt });
  }
  boundary.sort((a, b) => a.aglM - b.aglM);
  // Reanalysis without pressure levels: the 100 m wind, and a power-law profile (exponent 1/7,
  // the neutral-boundary-layer standard) to 1500 m above ground.
  const kt100 = v("wind_speed_100m"), dir100 = v("wind_direction_100m");
  if (!aloft.length && kt100 !== undefined && dir100 !== undefined) aloft.push({ altM: g + 1500, fromDeg: dir100, kt: kt100 * Math.pow(15, 1 / 7) });
  const t = v("temperature_2m") ?? est.tempC;
  const sw = v("shortwave_radiation") ?? est.shortwaveWm2;
  return {
    source,
    timeUtc: new Date(times[best]! * 1000).toISOString(),
    utcOffsetH: offset / 3600,
    elevationM: json.elevation ?? 0,
    tempC: t,
    dewPointC: v("dew_point_2m") ?? est.dewPointC,
    windFromDeg: v("wind_direction_10m") ?? est.windFromDeg,
    windKt: v("wind_speed_10m") ?? est.windKt,
    gustKt: v("wind_gusts_10m") ?? v("wind_speed_10m") ?? est.gustKt,
    aloft: aloft.length ? aloft : est.aloft,
    ...(boundary.length ? { boundary } : {}),
    lowCloud: (v("cloud_cover_low") ?? est.lowCloud * 100) / 100,
    ...(v("cloud_cover_high") !== undefined ? { highCloud: v("cloud_cover_high")! / 100 } : {}),
    shortwaveWm2: sw,
    boundaryLayerM: v("boundary_layer_height") ?? estimateBoundaryLayer(sw),
    ...(v("surface_pressure") !== undefined ? { surfacePressureHpa: v("surface_pressure")! } : {}),
    ...(v("visibility") !== undefined ? { visibilityM: v("visibility")! } : {}),
  };
}

const toUV = (fromDeg: number, kt: number): [number, number] => {
  const r = (fromDeg * Math.PI) / 180;
  return [-kt * Math.sin(r), -kt * Math.cos(r)];
};
const fromUV = (u: number, v: number): { fromDeg: number; kt: number } => ({ fromDeg: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360, kt: Math.hypot(u, v) });
/** A wind between two: as vectors (through north the short way; a turn weakens it on the way). */
function lerpWind(a: { fromDeg: number; kt: number }, b: { fromDeg: number; kt: number }, f: number): { fromDeg: number; kt: number } {
  const [ua, va] = toUV(a.fromDeg, a.kt), [ub, vb] = toUV(b.fromDeg, b.kt);
  return fromUV(ua + f * (ub - ua), va + f * (vb - va));
}

/**
 * The weather at a moment between the hours of a series (parseOpenMeteoHours), linearly in
 * time as the model's hourly output is meant (winds as vectors; visibility in extinction,
 * 1/V). Open-Meteo's shortwave radiation is the preceding hour's mean, so its values are
 * placed half an hour earlier. Levels and boundary winds pair up by pressure and height; one
 * only one hour has comes from the nearer hour. Before the first hour or after the last, the
 * end hour. timeUtc is the moment asked.
 */
export function weatherAt(series: readonly Weather[], when: Date): Weather {
  if (!series.length) throw new Error("weatherAt: no hours");
  const t = when.getTime();
  const at = (shiftMs: number): [Weather, Weather, number] => {
    const T = (w: Weather) => Date.parse(w.timeUtc) + shiftMs;
    if (t <= T(series[0]!)) return [series[0]!, series[0]!, 0];
    for (let i = 0; i + 1 < series.length; i++) {
      const a = series[i]!, b = series[i + 1]!, ta = T(a), tb = T(b);
      if (t <= tb) return [a, b, tb > ta ? (t - ta) / (tb - ta) : 0];
    }
    const last = series[series.length - 1]!;
    return [last, last, 0];
  };
  const [a, b, f] = at(0);
  const L = (x: number, y: number) => x + f * (y - x);
  const near = f < 0.5 ? a : b;
  const opt = (x: number | undefined, y: number | undefined) => (x !== undefined && y !== undefined ? L(x, y) : f < 0.5 ? x : y);
  const pairLevel = (la: WindLevel, lb: WindLevel): WindLevel => {
    const w = lerpWind(la, lb, f);
    const tc = opt(la.tempC, lb.tempC), td = opt(la.dewPointC, lb.dewPointC);
    return { ...la, altM: L(la.altM, lb.altM), fromDeg: w.fromDeg, kt: w.kt, ...(tc !== undefined ? { tempC: tc } : {}), ...(td !== undefined ? { dewPointC: td } : {}) };
  };
  const aloft: WindLevel[] = [];
  const key = (l: WindLevel, i: number) => (l.hPa !== undefined ? `p${l.hPa}` : `i${i}`);
  const bByKey = new Map(b.aloft.map((l, i) => [key(l, i), l]));
  const aKeys = new Set(a.aloft.map((l, i) => key(l, i)));
  a.aloft.forEach((la, i) => {
    const lb = bByKey.get(key(la, i));
    if (lb) aloft.push(pairLevel(la, lb));
    else if (f < 0.5) aloft.push(la);
  });
  b.aloft.forEach((lb, i) => {
    if (!aKeys.has(key(lb, i)) && f >= 0.5) aloft.push(lb);
  });
  aloft.sort((x, y) => x.altM - y.altM);
  let boundary: BoundaryWind[] | undefined;
  if (a.boundary || b.boundary) {
    const byH = new Map((b.boundary ?? []).map((x) => [x.aglM, x]));
    boundary = (a.boundary ?? []).flatMap((x) => {
      const y = byH.get(x.aglM);
      return y ? [{ aglM: x.aglM, ...lerpWind(x, y, f) }] : f < 0.5 ? [x] : [];
    });
    if (f >= 0.5) for (const y of b.boundary ?? []) if (!(a.boundary ?? []).some((x) => x.aglM === y.aglM)) boundary.push(y);
    boundary.sort((x, y) => x.aglM - y.aglM);
  }
  const surf = lerpWind({ fromDeg: a.windFromDeg, kt: a.windKt }, { fromDeg: b.windFromDeg, kt: b.windKt }, f);
  const [sa, sb, sf] = at(-1800_000);
  const vis = a.visibilityM !== undefined && b.visibilityM !== undefined ? 1 / L(1 / a.visibilityM, 1 / b.visibilityM) : near.visibilityM;
  const high = opt(a.highCloud, b.highCloud), ps = opt(a.surfacePressureHpa, b.surfacePressureHpa);
  const { highCloud: _h, surfacePressureHpa: _p, visibilityM: _v, boundary: _b, ...rest } = near;
  return {
    ...rest,
    timeUtc: new Date(t).toISOString(),
    tempC: L(a.tempC, b.tempC),
    dewPointC: L(a.dewPointC, b.dewPointC),
    windFromDeg: surf.fromDeg,
    windKt: surf.kt,
    gustKt: L(a.gustKt, b.gustKt),
    aloft,
    ...(boundary ? { boundary } : {}),
    lowCloud: L(a.lowCloud, b.lowCloud),
    ...(high !== undefined ? { highCloud: high } : {}),
    shortwaveWm2: sa.shortwaveWm2 + sf * (sb.shortwaveWm2 - sa.shortwaveWm2),
    boundaryLayerM: L(a.boundaryLayerM, b.boundaryLayerM),
    ...(ps !== undefined ? { surfacePressureHpa: ps } : {}),
    ...(vis !== undefined ? { visibilityM: vis } : {}),
  };
}

/** A daytime convective boundary layer grows with the heating; a few hundred metres at night. */
export function estimateBoundaryLayer(shortwaveWm2: number): number {
  return Math.min(2600, 300 + 2.4 * Math.max(0, shortwaveWm2));
}

/**
 * Offline estimate: clear sky, light westerly, a dew-point spread that opens up with the
 * sun. Deterministic in place and time.
 */
export function estimateWeather(latDeg: number, lonDeg: number, when: Date, elevationM = 0): Weather {
  const sun = sunPosition(when, latDeg, lonDeg);
  const s = Math.max(0, Math.sin((sun.elevationDeg * Math.PI) / 180));
  const sw = 1000 * s * 0.75;
  const temp = 8 + 18 * s - elevationM * 0.0065;
  return {
    source: "estimated",
    timeUtc: when.toISOString(),
    utcOffsetH: Math.round(lonDeg / 15),
    elevationM,
    tempC: temp,
    dewPointC: temp - (3 + 11 * s),
    windFromDeg: 270,
    windKt: 7,
    gustKt: 10,
    aloft: [
      { altM: 1500, fromDeg: 275, kt: 14 },
      { altM: 3000, fromDeg: 280, kt: 22 },
    ],
    lowCloud: 0.2 * s,
    shortwaveWm2: sw,
    boundaryLayerM: estimateBoundaryLayer(sw),
  };
}

/** When to fly: now, or a local date and time at the place (live forecast or recent past). */
export type WhenSpec = { kind: "now" } | { kind: "local"; date?: string; hm: string };

/** "now" | "HH:MM" (today) | "YYYY-MM-DDTHH:MM" (local time at the place). */
export function parseWhen(s: string | null | undefined): WhenSpec {
  const m = /^(?:(\d{4}-\d{2}-\d{2})T)?(\d{1,2}:\d{2})$/.exec(s ?? "");
  if (!m) return { kind: "now" };
  return m[1] ? { kind: "local", date: m[1], hm: m[2]! } : { kind: "local", hm: m[2]! };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** UTC offset [h] of an IANA time zone at an instant, summer time included; undefined if unknown. */
export function zoneOffsetH(timeZone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    const h = (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 3600_000;
    return Number.isFinite(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The weather and the sim time for a place and a WhenSpec: Open-Meteo for the local day
 * asked (the response's UTC offset turns local time into UTC), else the sun-based estimate.
 */
export async function weatherFor(
  latDeg: number,
  lonDeg: number,
  when: WhenSpec,
  elevationM = 0,
  now = new Date(),
  /** fetchJson: replace the fetch (e.g. with a cache); it should throw with a reason on failure. */
  opts: { fetchJson?: (url: string) => Promise<unknown> } = {},
): Promise<{ weather: Weather; time: Date; series?: Weather[] }> {
  // The local date isn't known before the offset is: ask for the day either side as well.
  const guessH = Math.round(lonDeg / 15);
  const localDay = when.kind === "local" && when.date ? when.date : ymd(new Date(now.getTime() + guessH * 3600_000));
  const d0 = new Date(`${localDay}T00:00:00Z`);
  const archive = now.getTime() - d0.getTime() > FORECAST_PAST_DAYS * 86400_000;
  const url = openMeteoUrl(latDeg, lonDeg, ymd(new Date(d0.getTime() - 86400_000)), ymd(new Date(d0.getTime() + 86400_000)), archive);
  let json: OpenMeteoResponse | undefined;
  let note = "";
  try {
    json = (await (opts.fetchJson ?? fetchOpenMeteo)(url)) as OpenMeteoResponse;
  } catch (e) {
    note = `Open-Meteo: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Open-Meteo's offset is the zone's offset today; on the day asked it can differ by the
  // summer hour, so it is worked out from the zone's name for the time asked.
  let offsetH = json?.utc_offset_seconds !== undefined ? json.utc_offset_seconds / 3600 : guessH;
  const zone = json?.timezone;
  let time = now;
  if (when.kind === "local") {
    const [h, m] = when.hm.split(":").map(Number) as [number, number];
    const wall = d0.getTime() + (h * 60 + m) * 60_000;
    time = new Date(wall - offsetH * 3600_000);
    for (let i = 0; zone && i < 2; i++) {
      const z = zoneOffsetH(zone, time);
      if (z === undefined || z === offsetH) break;
      offsetH = z;
      time = new Date(wall - offsetH * 3600_000);
    }
  } else if (zone) offsetH = zoneOffsetH(zone, time) ?? offsetH;
  // The forecast API keeps its surface fields for fewer past days than it keeps hours (2026-11:
  // ~70 of 92; the pressure levels go back further): without them the day would be mostly the
  // estimate, so it comes from the reanalysis instead.
  let source: "forecast" | "archive" = archive ? "archive" : "forecast";
  if (json && !archive && time.getTime() < now.getTime() - 86400_000 && !hasSurface(json, time)) {
    try {
      json = (await (opts.fetchJson ?? fetchOpenMeteo)(openMeteoUrl(latDeg, lonDeg, ymd(new Date(d0.getTime() - 86400_000)), ymd(new Date(d0.getTime() + 86400_000)), true))) as OpenMeteoResponse;
      source = "archive";
    } catch (e) {
      note = `Open-Meteo archive: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (json) {
    try {
      const fix = (w: Weather): Weather => ({ ...w, utcOffsetH: offsetH, ...(note ? { note } : {}) });
      // The three days asked for, hour by hour: the weather as the flight goes on (weatherAt).
      const series = parseOpenMeteoHours(json, latDeg, lonDeg, source).map(fix);
      // The weather at the start itself (between its hours), as the flight goes on from it.
      return { weather: weatherAt(series, time), time, series };
    } catch (e) {
      note = `Open-Meteo: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { weather: { ...estimateWeather(latDeg, lonDeg, time, elevationM), utcOffsetH: offsetH, note }, time };
}

/** Does the response have the surface temperature and wind for the hour nearest `when`? */
function hasSurface(json: OpenMeteoResponse, when: Date): boolean {
  const h = json.hourly, times = h?.time;
  if (!h || !times?.length) return false;
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! * 1000 - when.getTime()) < Math.abs(times[best]! * 1000 - when.getTime())) best = i;
  return ["temperature_2m", "wind_speed_10m", "shortwave_radiation"].every((k) => typeof h[k]?.[best] === "number");
}

/**
 * GET an Open-Meteo URL: up to 3 tries 1 s / 3 s apart on rate limits (429) and server
 * errors; throws with Open-Meteo's `reason` (e.g. "Daily API request limit exceeded").
 */
export async function fetchOpenMeteo(url: string): Promise<unknown> {
  let last = "unreachable";
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise<void>((r) => setTimeout(r, i === 1 ? 1000 : 3000));
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      const body = (await r.json().catch(() => ({}))) as { reason?: string };
      if (r.ok) return body;
      last = body.reason ?? `HTTP ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = e instanceof Error && e.name === "AbortError" ? "timed out" : "unreachable";
    }
  }
  throw new Error(last);
}

/** One line for the HUD / menu: source, wind, cloud base or blue, thermal strength. */
export function describeWeather(w: Weather): string {
  const s = soaringFrom(w);
  const wind = w.windKt < 1 ? "calm" : `${String(Math.round(w.windFromDeg / 10) * 10).padStart(3, "0")}° ${Math.round(w.windKt)} kt`;
  const sky = s.wStarMs < 0.5 ? "no thermals" : `${s.cumulus ? `Cu base ${Math.round((w.elevationM + s.cloudBaseAglM) / 50) * 50} m` : `blue to ${Math.round((w.elevationM + s.thermalTopAglM) / 50) * 50} m`} · w* ${s.wStarMs.toFixed(1)} m/s`;
  const src = { forecast: "Forecast", archive: "Historical", estimated: `Estimated${w.note ? ` (${w.note})` : ""}` }[w.source];
  const day = new Date(Date.parse(w.timeUtc) + w.utcOffsetH * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  return `${src} ${day}: ${wind} · ${Math.round(w.tempC)}°C · ${sky}`;
}
