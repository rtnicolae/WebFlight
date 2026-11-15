/**
 * The day's weather at a place and time, and what it means for soaring.
 *
 * Live: Open-Meteo's forecast API (free, no key; hourly model data, past days included):
 * 2 m temperature and dew point, 10 m wind and gusts, wind at 850 and 700 hPa, low cloud
 * cover, global shortwave radiation and the boundary-layer height. Without a connection the
 * same quantities are estimated from the sun's height (clear sky, light westerly).
 *
 * Soaring from those (standard convective boundary-layer rules of thumb):
 *  - cumulus base = lifting condensation level ≈ 125 m × (T − Td) above ground
 *  - thermals reach the top of the boundary layer zi (or cloud base, if lower); if the
 *    condensation level is above zi the thermals are blue (no cumulus)
 *  - convective velocity scale w* = (g/T · Q · zi)^(1/3), Q the surface kinematic heat flux,
 *    taken as ~35 % of the shortwave radiation (sensible share over land) / (ρ·cp)
 *  - thermal spacing ≈ 1.5 zi, diameter ≈ 0.25 zi
 * A Weather value is plain data, so a recorded day replays exactly (gym, bug reports).
 */
import { sunPosition } from "./sun.ts";

export interface WindLevel {
  /** Height above mean sea level [m]. */
  altM: number;
  fromDeg: number;
  kt: number;
}

export interface Weather {
  /** "live" (Open-Meteo), or "estimated" (sun-based, offline). */
  source: "live" | "estimated";
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
  /** Winds aloft, by height (850 hPa, 700 hPa, …). */
  aloft: WindLevel[];
  /** Low cloud cover [0–1]. */
  lowCloud: number;
  /** Global shortwave radiation at the ground [W/m²]. */
  shortwaveWm2: number;
  /** Convective boundary-layer depth above ground [m]. */
  boundaryLayerM: number;
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

export function soaringFrom(w: Weather): Soaring {
  const spread = Math.max(0, w.tempC - w.dewPointC);
  const lcl = Math.max(150, 125 * spread);
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

/** Wind at a height [m MSL]: linear between the surface (10 m) and the aloft levels. */
export function windAt(w: Weather, altM: number): { fromDeg: number; kt: number } {
  const levels: WindLevel[] = [{ altM: w.elevationM + 10, fromDeg: w.windFromDeg, kt: w.windKt }, ...w.aloft].sort((a, b) => a.altM - b.altM);
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

export const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const HOURLY = [
  "temperature_2m",
  "dew_point_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "wind_speed_850hPa",
  "wind_direction_850hPa",
  "geopotential_height_850hPa",
  "wind_speed_700hPa",
  "wind_direction_700hPa",
  "geopotential_height_700hPa",
  "cloud_cover_low",
  "shortwave_radiation",
  "boundary_layer_height",
];

export function openMeteoUrl(latDeg: number, lonDeg: number): string {
  return `${OPEN_METEO}?latitude=${latDeg.toFixed(4)}&longitude=${lonDeg.toFixed(4)}&hourly=${HOURLY.join(",")}&wind_speed_unit=kn&timezone=auto&timeformat=unixtime&past_days=2&forecast_days=3`;
}

interface OpenMeteoResponse {
  elevation?: number;
  utc_offset_seconds?: number;
  /** With timeformat=unixtime, `time` is UTC seconds (docs: local ISO times ignore DST changes). */
  hourly?: Record<string, (number | null)[] | undefined> & { time?: number[] };
}

/**
 * The hour of an Open-Meteo forecast response nearest `when`. Missing values fall back to
 * the sun-based estimate for that quantity.
 */
export function parseOpenMeteo(json: OpenMeteoResponse, latDeg: number, lonDeg: number, when: Date): Weather {
  const h = json.hourly;
  const times = h?.time;
  if (!h || !times?.length) throw new Error("open-meteo: no hourly data");
  const offset = json.utc_offset_seconds ?? 0;
  let best = 0, bestDt = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]! * 1000;
    const dt = Math.abs(t - when.getTime());
    if (dt < bestDt) { bestDt = dt; best = i; }
  }
  const est = estimateWeather(latDeg, lonDeg, when, json.elevation ?? 0);
  const v = (k: string): number | undefined => {
    const a = h[k];
    const x = a?.[best];
    return typeof x === "number" && Number.isFinite(x) ? x : undefined;
  };
  const aloft: WindLevel[] = [];
  for (const p of ["850hPa", "700hPa"]) {
    const kt = v(`wind_speed_${p}`), dir = v(`wind_direction_${p}`), z = v(`geopotential_height_${p}`);
    if (kt !== undefined && dir !== undefined) aloft.push({ altM: z ?? (p === "850hPa" ? 1500 : 3000), fromDeg: dir, kt });
  }
  const t = v("temperature_2m") ?? est.tempC;
  const sw = v("shortwave_radiation") ?? est.shortwaveWm2;
  return {
    source: "live",
    timeUtc: new Date(times[best]! * 1000).toISOString(),
    utcOffsetH: offset / 3600,
    elevationM: json.elevation ?? 0,
    tempC: t,
    dewPointC: v("dew_point_2m") ?? est.dewPointC,
    windFromDeg: v("wind_direction_10m") ?? est.windFromDeg,
    windKt: v("wind_speed_10m") ?? est.windKt,
    gustKt: v("wind_gusts_10m") ?? v("wind_speed_10m") ?? est.gustKt,
    aloft: aloft.length ? aloft : est.aloft,
    lowCloud: (v("cloud_cover_low") ?? est.lowCloud * 100) / 100,
    shortwaveWm2: sw,
    boundaryLayerM: v("boundary_layer_height") ?? estimateBoundaryLayer(sw),
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

/** Live weather nearest a time, or the estimate if Open-Meteo can't be reached. */
export async function fetchWeather(latDeg: number, lonDeg: number, when: Date): Promise<Weather> {
  return (await weatherFor(latDeg, lonDeg, { kind: "now" }, 0, when)).weather;
}

/**
 * When to fly: now (live), a local time today (live forecast), or a typical summer day
 * (the deterministic estimate on 15 July at that local time).
 */
export type WhenSpec = { kind: "now" } | { kind: "today"; hm: string } | { kind: "summer"; hm: string };

export function parseWhen(s: string | null | undefined): WhenSpec {
  const presets: Record<string, string> = { morning: "10:00", noon: "13:00", afternoon: "15:30", evening: "19:00" };
  if (!s || s === "now") return { kind: "now" };
  const [kind, v = "afternoon"] = s.includes(":") && !/^\d/.test(s) ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)] : ["today", s];
  const hm = presets[v] ?? (/^\d{1,2}:\d{2}$/.test(v) ? v : "15:30");
  return kind === "summer" ? { kind: "summer", hm } : { kind: "today", hm };
}

const atLocal = (y: number, mo: number, d: number, hm: string, offsetH: number) => {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, d, h, m) - offsetH * 3600_000);
};

/** The weather and the sim time for a place and a WhenSpec. */
export async function weatherFor(latDeg: number, lonDeg: number, when: WhenSpec, elevationM = 0, now = new Date()): Promise<{ weather: Weather; time: Date }> {
  if (when.kind === "summer") {
    const time = atLocal(now.getUTCFullYear(), 6, 15, when.hm, Math.round(lonDeg / 15) + 1);
    return { weather: estimateWeather(latDeg, lonDeg, time, elevationM), time };
  }
  let json: OpenMeteoResponse | undefined;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(openMeteoUrl(latDeg, lonDeg), { signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) json = (await r.json()) as OpenMeteoResponse;
  } catch {}
  const offsetH = json?.utc_offset_seconds !== undefined ? json.utc_offset_seconds / 3600 : Math.round(lonDeg / 15);
  let time = now;
  if (when.kind === "today") {
    const local = new Date(now.getTime() + offsetH * 3600_000);
    time = atLocal(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), when.hm, offsetH);
  }
  if (json) {
    try {
      return { weather: parseOpenMeteo(json, latDeg, lonDeg, time), time };
    } catch {}
  }
  return { weather: { ...estimateWeather(latDeg, lonDeg, time, elevationM), utcOffsetH: offsetH }, time };
}

/** One line for the HUD / menu: source, wind, cloud base or blue, thermal strength. */
export function describeWeather(w: Weather): string {
  const s = soaringFrom(w);
  const wind = w.windKt < 1 ? "calm" : `${String(Math.round(w.windFromDeg / 10) * 10).padStart(3, "0")}° ${Math.round(w.windKt)} kt`;
  const sky = s.wStarMs < 0.5 ? "no thermals" : `${s.cumulus ? `Cu base ${Math.round((w.elevationM + s.cloudBaseAglM) / 50) * 50} m` : `blue to ${Math.round((w.elevationM + s.thermalTopAglM) / 50) * 50} m`} · w* ${s.wStarMs.toFixed(1)} m/s`;
  return `${w.source === "live" ? "Live" : "Estimated"}: ${wind} · ${Math.round(w.tempC)}°C · ${sky}`;
}
