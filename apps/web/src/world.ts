/**
 * Everything about a flight that comes from data rather than code: the airfield
 * (OurAirports), its runway (OpenStreetMap), the weather at the chosen time (Open-Meteo, or
 * the estimate), and from those the wind, lift and the runway direction in use (into wind).
 */
import {
  fetchOpenMeteo,
  OPEN_METEO_ARCHIVE,
  airColumnOf,
  airfieldAt,
  airfieldsAround,
  describeWeather,
  distanceM,
  GridFollower,
  HOME_AIRFIELD,
  parseWhen,
  resolveRunway,
  weatherFor,
  type AirfieldData,
  type EnvironmentConfig,
  type Runway,
  type Weather,
  type WeatherGrid,
  type WhenSpec,
} from "@webflight/environment";
import { fetchRunwayLines } from "@webflight/scenery";
import { openFreeMapTiles } from "./osm-source.ts";

export interface Flight {
  /** The airfield (the nearest one for a start in the air; undefined if none within 50 km). */
  field: AirfieldData | undefined;
  /** The runway in use, `headingDeg` = take-off/landing direction (into wind). */
  runway: Runway | undefined;
  /** Where the weather is taken: the field, or the start point. */
  latDeg: number;
  lonDeg: number;
  weather: Weather;
  /** The weather's hours round the flight (interpolated as it goes on), when fetched. */
  series?: Weather[];
  /** The weather by place round the start (its hours on a grid), when fetched. */
  grid?: WeatherGrid;
  /** That grid moving with the glider (main.ts asks it every few seconds). */
  gridFollower?: GridFollower;
  time: Date;
  when: WhenSpec;
  environment: EnvironmentConfig;
  /** For the HUD and menu. */
  name: string;
  weatherText: string;
}

/**
 * Open-Meteo through a small localStorage cache: the menu and the sim ask for the same hour,
 * and the free API limits requests per day. Historical days never change (kept); forecasts
 * are reused for an hour. At most 30 responses (~15 kB each), oldest dropped first.
 */
/**
 * Model columns on the model's ground (a grid's 25, ~1 MB: too big for localStorage; or the few
 * it asks for as it moves) in the Cache Storage: archive days kept, forecasts for an hour, as
 * the small answers.
 */
async function cachedGrid(url: string): Promise<unknown> {
  const fresh = (u: string, at: number) => u.startsWith(OPEN_METEO_ARCHIVE) || Date.now() - at < 3600_000;
  let cache: Cache | undefined;
  try {
    cache = await caches.open("webflight-wx");
    const hit = await cache.match(url);
    if (hit && fresh(url, Number(hit.headers.get("x-at")))) return await hit.json();
  } catch {}
  const json = await fetchOpenMeteo(url);
  if (cache) {
    const c = cache;
    void (async () => {
      for (const k of await c.keys()) {
        const r = await c.match(k);
        if (!r || !fresh(k.url, Number(r.headers.get("x-at")))) await c.delete(k);
      }
      await c.put(url, new Response(JSON.stringify(json), { headers: { "content-type": "application/json", "x-at": String(Date.now()) } }));
    })().catch(() => {});
  }
  return json;
}

async function cachedOpenMeteo(url: string): Promise<unknown> {
  if (url.includes("elevation=nan")) return cachedGrid(url);
  const KEY = "webflight.wx";
  type Entry = { url: string; at: number; json: unknown };
  let store: Entry[] = [];
  try {
    store = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Entry[];
  } catch {}
  const hit = store.find((e) => e.url === url);
  const fresh = (e: Entry) => e.url.startsWith(OPEN_METEO_ARCHIVE) || Date.now() - e.at < 3600_000;
  if (hit && fresh(hit)) return hit.json;
  const json = await fetchOpenMeteo(url);
  store = [{ url, at: Date.now(), json }, ...store.filter((e) => e.url !== url && fresh(e))].slice(0, 30);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {}
  return json;
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/**
 * ?field=IDENT&at=lat,lon (the position selects the airfield data tile), or a start in the
 * air (?lat=&lon=: the nearest field), else home.
 */
export async function resolveField(params: URLSearchParams): Promise<AirfieldData | undefined> {
  const id = params.get("field");
  const at = (params.get("at") ?? "").split(",").map(Number);
  if (id && at.length === 2 && at.every(Number.isFinite)) return airfieldAt(id, at[0]!, at[1]!);
  if (params.has("lat") && params.has("lon")) {
    const lat = Number(params.get("lat")), lon = Number(params.get("lon"));
    const near = await airfieldsAround(lat, lon, 50_000);
    return near.sort((a, b) => distanceM(lat, lon, a.latDeg, a.lonDeg) - distanceM(lat, lon, b.latDeg, b.lonDeg))[0];
  }
  return airfieldAt(HOME_AIRFIELD.ident, HOME_AIRFIELD.latDeg, HOME_AIRFIELD.lonDeg);
}

export async function resolveFlight(params: URLSearchParams): Promise<Flight> {
  const field = await resolveField(params);
  const when = parseWhen(params.get("time"));
  const air = params.has("lat") && params.has("lon");
  const lat = air ? Number(params.get("lat")) : field?.latDeg ?? HOME_AIRFIELD.latDeg;
  const lon = air ? Number(params.get("lon")) : field?.lonDeg ?? HOME_AIRFIELD.lonDeg;
  // The weather by place too (a grid round the start; ?wxgrid=0: the start's everywhere).
  const [{ weather, time, series, grid, gridError }, osmLines] = await Promise.all([
    weatherFor(lat, lon, when, field?.elevM ?? 0, new Date(), { fetchJson: cachedOpenMeteo, grid: params.get("wxgrid") !== "0" }),
    field ? withTimeout(openFreeMapTiles().then((u) => (u ? fetchRunwayLines(u, field.latDeg, field.lonDeg) : [])), 8000, []) : Promise.resolve([]),
  ]);
  // Wind: the weather's, or ?wind=from@kt for every level.
  const m = /^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)$/.exec(params.get("wind") ?? "");
  const windOf = (x: Weather): Weather =>
    m ? { ...x, windFromDeg: Number(m[1]), windKt: Number(m[2]), gustKt: Number(m[2]), aloft: x.aloft.map((l) => ({ ...l, fromDeg: Number(m[1]), kt: Number(m[2]) })), ...(x.boundary ? { boundary: x.boundary.map((l) => ({ ...l, fromDeg: Number(m[1]), kt: Number(m[2]) })) } : {}) } : x;
  const w: Weather = windOf(weather);
  if (gridError) console.warn(`${gridError}: the weather at the start everywhere`);
  const wgrid = grid ? { ...grid, nodes: grid.nodes.map((n) => n.map(windOf)) } : undefined;
  let runway: Runway | undefined;
  if (field) {
    const rws = field.runways.map((r) => resolveRunway(field, r, osmLines));
    const pick = params.get("rwy");
    runway = rws.find((r) => pick && r.name.split("/").includes(pick)) ?? rws.reduce((a, b) => (b.lengthM * (b.paved ? 1 : 1.05) > a.lengthM * (a.paved ? 1 : 1.05) ? b : a));
    // Into wind: flip to the other end if the wind blows from behind the le direction.
    const head = Math.cos(((w.windFromDeg - runway.headingDeg) * Math.PI) / 180);
    if (w.windKt >= 2 && head < 0) runway = { ...runway, headingDeg: (runway.headingDeg + 180) % 360, name: runway.name.split("/").reverse().join("/") };
  }
  const aloft = w.aloft[0];
  const thermals = params.get("thermals") !== "0";
  const environment: EnvironmentConfig = {
    windFromDeg: w.windFromDeg,
    windKt: w.windKt,
    ...(aloft ? { aloftFromDeg: aloft.fromDeg, aloftKt: aloft.kt } : {}),
    profile: { elevationM: w.elevationM, windFromDeg: w.windFromDeg, windKt: w.windKt, aloft: w.aloft, ...(w.boundary ? { boundary: w.boundary } : {}) },
    air: airColumnOf(w),
    ridgeLift: true,
    thermalSky: thermals ? { seed: Number(params.get("seed") ?? 1), weather: w, ...(wgrid ? { grid: wgrid } : {}) } : false,
  };
  return {
    field,
    runway,
    latDeg: lat,
    lonDeg: lon,
    weather: w,
    time,
    when,
    environment,
    ...(series?.length ? { series: series.map(windOf) } : {}),
    ...(wgrid ? { grid: wgrid, gridFollower: new GridFollower(wgrid, cachedOpenMeteo, windOf) } : {}),
    name: air ? `free flight${field ? ` near ${field.name}` : ""}` : field && runway ? `${field.name} · ${runway.name.split("/")[0]}` : "?",
    weatherText: describeWeather(w),
  };
}
