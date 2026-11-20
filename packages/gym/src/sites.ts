/**
 * Where and in what weather an episode happens, from data: an airfield and runway from
 * OurAirports (runways with surveyed end coordinates, so the geometry is exact without
 * network access) and a recorded weather snapshot (Open-Meteo, forecast or historical; see
 * scripts/record-weather.ts). The runway in use is the end facing into the weather's wind.
 *
 * Without recorded snapshots the sun-based estimate is used for the drawn date and hour,
 * with its wind randomized (0–12 kt, any direction): a synthetic fallback, reported as
 * `weather.source = "estimated"` in the episode info.
 */
import { airfieldTile, AIRFIELD_TILE_ZOOM, estimateSeries, estimateWeather, lonLatToTile, loadAirfieldIndex, resolveRunway, type AirfieldData, type Runway, type Weather } from "@webflight/environment";

export interface GymSite {
  ident: string;
  name: string;
  /** Runway in use (`headingDeg` = into wind). */
  runway: Runway;
  weather: Weather;
  /** The weather's hours round it, when known: episodes follow them with their clock. */
  hours?: Weather[];
}

/** Picks an episode's site from its own seeded generator. */
export type SitePicker = (rand: () => number) => GymSite | Promise<GymSite>;

/** The runway end facing into the wind. */
export function intoWind(rw: Runway, w: Weather): Runway {
  const head = Math.cos(((w.windFromDeg - rw.headingDeg) * Math.PI) / 180);
  return w.windKt >= 2 && head < 0 ? { ...rw, headingDeg: (rw.headingDeg + 180) % 360, name: rw.name.split("/").reverse().join("/") } : rw;
}

/** One fixed airfield and weather (tests, curricula). */
export function fixedSite(field: AirfieldData, weather: Weather, runwayIndex = 0): SitePicker {
  const site: GymSite = { ident: field.ident, name: field.name, runway: intoWind(resolveRunway(field, field.runways[runwayIndex]!), weather), weather };
  return () => site;
}

/** Runways a glider can use and whose geometry is surveyed. */
function usable(field: AirfieldData): number[] {
  return field.runways.flatMap((r, i) => (r.leLatLon && r.heLatLon && (r.lengthM ?? 0) >= 500 && (r.lengthM ?? 0) <= 3500 && r.surface !== "other" ? [i] : []));
}

/** Every airfield in the data with a usable runway (reads each data tile once). */
export async function loadGymAirfields(): Promise<AirfieldData[]> {
  const n = 2 ** AIRFIELD_TILE_ZOOM;
  const tiles = new Set<string>();
  for (const a of await loadAirfieldIndex()) {
    const [x, y] = lonLatToTile(a.lonDeg, a.latDeg, AIRFIELD_TILE_ZOOM);
    tiles.add(`${Math.min(n - 1, Math.floor(x))}/${Math.floor(y)}`);
  }
  const out: AirfieldData[] = [];
  for (const k of tiles) {
    const [x, y] = k.split("/").map(Number) as [number, number];
    for (const f of await airfieldTile(x, y)) if (usable(f).length) out.push(f);
  }
  return out.sort((a, b) => (a.ident < b.ident ? -1 : 1));
}

/**
 * Random airfields from the data with recorded weather: a snapshot recorded for the drawn
 * airfield if any, else any snapshot (its weather moved to that airfield), else the
 * estimate (see the module comment).
 */
export function dataSites(fields: AirfieldData[], snapshots: { ident: string; weather: Weather; hours?: Weather[] }[] = []): SitePicker {
  const byIdent = new Map<string, { weather: Weather; hours?: Weather[] }[]>();
  for (const s of snapshots) byIdent.set(s.ident, [...(byIdent.get(s.ident) ?? []), s]);
  return (rand) => {
    const field = fields[Math.floor(rand() * fields.length)]!;
    const runways = usable(field);
    const rw = resolveRunway(field, field.runways[runways[Math.floor(rand() * runways.length)]!]!);
    let weather: Weather;
    let hours: Weather[] | undefined;
    const own = byIdent.get(field.ident);
    if (own?.length) ({ weather, hours } = own[Math.floor(rand() * own.length)]!);
    else if (snapshots.length) {
      const o = snapshots[Math.floor(rand() * snapshots.length)]!;
      weather = { ...o.weather, elevationM: field.elevM };
      hours = o.hours?.map((h) => ({ ...h, elevationM: field.elevM }));
    } else {
      // A summer day of the last ten years, 10:00–17:00 local (≈ UTC+3 in summer Europe at most).
      const year = 2016 + Math.floor(rand() * 10), doy = 121 + Math.floor(rand() * 123), hour = 10 + rand() * 7;
      const when = new Date(Date.UTC(year, 0, doy, 0, 0) + (hour - Math.round(field.lonDeg / 15) - 1) * 3600_000);
      const fromDeg = rand() * 360, kt = rand() * 12;
      // The estimate's wind is a light westerly: the episode's own, at every height.
      const windy = (w: Weather): Weather => ({ ...w, windFromDeg: fromDeg, windKt: kt, gustKt: kt * 1.4, aloft: w.aloft.map((l) => ({ ...l, fromDeg, kt: kt * 1.5 })) });
      weather = windy(estimateWeather(field.latDeg, field.lonDeg, when, field.elevM));
      // Its hours too (the sun's: the thermals grow and wane through the episode).
      hours = estimateSeries(field.latDeg, field.lonDeg, when, field.elevM, windy);
    }
    return { ident: field.ident, name: field.name, runway: intoWind(rw, weather), weather, ...(hours?.length ? { hours } : {}) };
  };
}
