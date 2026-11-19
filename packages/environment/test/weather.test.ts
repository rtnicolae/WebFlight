import { describe, expect, it } from "vitest";
import { estimateWeather, openMeteoUrl, parseWhen, parseOpenMeteo, soaringFrom, surfaceLayerFactor, weatherFor, windAt, windLevels, zoneOffsetH, type Weather } from "../src/index.ts";

// Shape of an Open-Meteo /v1/forecast response with timezone=auto&timeformat=unixtime.
const fixture = {
  latitude: 45.7,
  longitude: 25.53,
  elevation: 533,
  utc_offset_seconds: 10800,
  timezone: "Europe/Bucharest",
  hourly: {
    // 12:00, 13:00, 14:00 local (UTC+3)
    time: [Date.UTC(2026, 6, 15, 9) / 1000, Date.UTC(2026, 6, 15, 10) / 1000, Date.UTC(2026, 6, 15, 11) / 1000],
    temperature_2m: [26.1, 27.4, 28.0],
    dew_point_2m: [12.0, 12.2, 12.5],
    wind_speed_10m: [6.0, 7.2, 8.1],
    wind_direction_10m: [300, 310, 315],
    wind_gusts_10m: [12, 14, 15],
    wind_speed_850hPa: [10, 11, 12],
    wind_direction_850hPa: [290, 295, 300],
    geopotential_height_850hPa: [1530, 1532, 1533],
    wind_speed_700hPa: [18, 19, 20],
    wind_direction_700hPa: [280, 280, 285],
    geopotential_height_700hPa: [3150, 3152, 3153],
    cloud_cover_low: [10, 20, 30],
    shortwave_radiation: [820, 800, 760],
    boundary_layer_height: [1700, 1900, null],
  },
};

describe("weather", () => {
  it("picks the hour nearest the requested time, in UTC", () => {
    // 10:20 UTC = 13:20 local → the 13:00 row.
    const w = parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T10:20:00Z"));
    expect(w.source).toBe("forecast");
    expect(w.timeUtc).toBe("2026-07-15T10:00:00.000Z");
    expect(w.utcOffsetH).toBe(3);
    expect(w.tempC).toBe(27.4);
    expect(w.windFromDeg).toBe(310);
    expect(w.aloft).toEqual([
      { altM: 1532, fromDeg: 295, kt: 11 },
      { altM: 3152, fromDeg: 280, kt: 19 },
    ]);
    expect(w.lowCloud).toBeCloseTo(0.2);
    expect(w.boundaryLayerM).toBe(1900);
  });

  it("fills a missing value from the estimate", () => {
    const w = parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T11:00:00Z"));
    expect(w.boundaryLayerM).toBeGreaterThan(1500); // estimated from 760 W/m²
  });

  it("derives a summer soaring day", () => {
    const w = parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T10:00:00Z"));
    const s = soaringFrom(w);
    // Spread 15.2 K → base ≈ 1900 m above ground; zi 1900 m → cumulus.
    expect(s.cloudBaseAglM).toBeCloseTo(1900, -1);
    expect(s.cumulus).toBe(true);
    expect(s.wStarMs).toBeGreaterThan(1.8);
    expect(s.wStarMs).toBeLessThan(3);
  });

  it("has no thermals at night and blue thermals on a dry day", () => {
    const night = estimateWeather(45.7, 25.53, new Date("2026-07-15T23:00:00Z"));
    expect(soaringFrom(night).wStarMs).toBe(0);
    const dry: Weather = { ...parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T10:00:00Z")), dewPointC: 0 };
    const s = soaringFrom(dry);
    expect(s.cumulus).toBe(false);
    expect(s.thermalTopAglM).toBe(1900);
  });

  it("interpolates the wind vector with height", () => {
    const w = parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T10:00:00Z"));
    expect(windAt(w, 0)).toEqual({ fromDeg: 310, kt: 7.2 });
    const mid = windAt(w, (543 + 1532) / 2);
    expect(mid.fromDeg).toBeGreaterThan(295);
    expect(mid.fromDeg).toBeLessThan(310);
    expect(windAt(w, 9000).kt).toBe(19);
  });

  it("layers the wind as FlightGear does: near-ground levels follow the ground, pressure levels stay put", () => {
    const w = {
      ...parseOpenMeteo(fixture, 45.7, 25.53, new Date("2026-07-15T10:00:00Z")),
      boundary: [{ aglM: 80, fromDeg: 310, kt: 9 }, { aglM: 180, fromDeg: 305, kt: 10 }],
    };
    // Over the model's ground: 10 m, 80 m, 180 m above it, then 850 and 700 hPa.
    expect(windLevels(w, 533).map((l) => l.altM)).toEqual([543, 613, 713, 1532, 3152]);
    // Over a 1,450 m ridge the boundary levels rise with the ground and 850 hPa (1,532 m) is
    // within FG's 500 ft transition, so it is left out.
    expect(windLevels(w, 1450).map((l) => l.altM)).toEqual([1460, 1530, 1630, 3152]);
    expect(windAt(w, 1630, 1450)).toEqual({ fromDeg: 305, kt: 10 });
    expect(windAt(w, 1630).kt).toBeGreaterThan(10); // over the valley it is 850 hPa air
  });

  it("slows the 10 m wind towards the ground as the logarithmic surface layer", () => {
    expect(surfaceLayerFactor(10)).toBe(1);
    expect(surfaceLayerFactor(300)).toBe(1);
    expect(surfaceLayerFactor(2)).toBeCloseTo(Math.log(2 / 0.03) / Math.log(10 / 0.03), 9); // 0.72
    expect(surfaceLayerFactor(1)).toBeCloseTo(0.6, 2);
    expect(surfaceLayerFactor(0)).toBe(surfaceLayerFactor(0.5));
  });

  it("asks Open-Meteo for knots, local time and the levels it parses", () => {
    const u = openMeteoUrl(45.7, 25.53, "2026-07-14", "2026-07-16");
    expect(u).toContain("start_date=2026-07-14&end_date=2026-07-16");
    expect(u).toContain("wind_speed_unit=kn");
    expect(u).toContain("timezone=auto");
    expect(u).toContain("timeformat=unixtime");
    expect(u).toContain("boundary_layer_height");
    for (const k of ["wind_speed_80m", "wind_direction_180m", "wind_speed_925hPa", "geopotential_height_600hPa"]) expect(u).toContain(k);
  });
});

describe("when", () => {
  it("reads now, today's local time and a local date-time", () => {
    expect(parseWhen(null)).toEqual({ kind: "now" });
    expect(parseWhen("14:30")).toEqual({ kind: "local", hm: "14:30" });
    expect(parseWhen("2026-07-15T14:30")).toEqual({ kind: "local", date: "2026-07-15", hm: "14:30" });
    expect(parseWhen("afternoon")).toEqual({ kind: "now" });
  });
});

describe("historical weather", () => {
  it("builds winds aloft from the 100 m wind when there are no pressure levels", () => {
    const { wind_speed_850hPa: _a, wind_direction_850hPa: _b, geopotential_height_850hPa: _c, wind_speed_700hPa: _d, wind_direction_700hPa: _e, geopotential_height_700hPa: _f, ...surface } = fixture.hourly;
    const json = { ...fixture, hourly: { ...surface, wind_speed_100m: [9, 10, 11], wind_direction_100m: [300, 305, 310] } };
    const w = parseOpenMeteo(json, 45.7, 25.53, new Date("2026-07-15T10:00:00Z"), "archive");
    expect(w.source).toBe("archive");
    expect(w.boundary).toEqual([{ aglM: 100, fromDeg: 305, kt: 10 }]);
    expect(w.aloft).toHaveLength(1);
    expect(w.aloft[0]!.altM).toBe(2033);
    expect(w.aloft[0]!.kt).toBeCloseTo(10 * 15 ** (1 / 7), 5);
  });

  it("takes a past day from the archive when the forecast has lost its surface fields", async () => {
    // The forecast still has the hours (and the pressure levels) but no surface values.
    const blank = { ...fixture, hourly: { ...fixture.hourly, temperature_2m: [null, null, null], wind_speed_10m: [null, null, null], shortwave_radiation: [null, null, null] } };
    const archived = { ...fixture, hourly: { ...fixture.hourly, wind_speed_10m: [2, 3, 4] } };
    const urls: string[] = [];
    const fetchJson = async (u: string) => (urls.push(u), u.includes("archive-api") ? archived : blank);
    const r = await weatherFor(45.7, 25.53, parseWhen("2026-07-15T13:00"), 530, new Date("2026-09-20T08:00:00Z"), { fetchJson });
    expect(urls).toHaveLength(2);
    expect(r.weather.source).toBe("archive");
    expect(r.weather.windKt).toBe(3);
    expect(r.weather.tempC).toBe(27.4);
    // A day the forecast still has: one request.
    urls.length = 0;
    const f = await weatherFor(45.7, 25.53, parseWhen("2026-07-15T13:00"), 530, new Date("2026-07-20T08:00:00Z"), { fetchJson: async (u: string) => (urls.push(u), fixture) });
    expect(urls).toHaveLength(1);
    expect(f.weather.source).toBe("forecast");
  });

  it("asks the archive for days older than the forecast's past range", () => {
    const u = openMeteoUrl(45.7, 25.53, "2017-07-14", "2017-07-16", true);
    expect(u.startsWith("https://archive-api.open-meteo.com/v1/archive?")).toBe(true);
    expect(u).toContain("wind_speed_100m");
    expect(u).not.toContain("hPa");
  });
});

describe("local time", () => {
  it("knows summer time from the zone's name", () => {
    expect(zoneOffsetH("Europe/Bucharest", new Date("2024-07-10T12:00:00Z"))).toBe(3);
    expect(zoneOffsetH("Europe/Bucharest", new Date("2024-01-10T12:00:00Z"))).toBe(2);
    expect(zoneOffsetH("Not/AZone", new Date())).toBeUndefined();
  });

  it("turns a July local time into UTC with summer time, though Open-Meteo answers in November", async () => {
    // Open-Meteo gives the zone's offset today (winter, +2), not on the day asked.
    const json = { ...fixture, utc_offset_seconds: 7200, hourly: { ...fixture.hourly, time: [Date.UTC(2024, 6, 10, 16) / 1000, Date.UTC(2024, 6, 10, 17) / 1000, Date.UTC(2024, 6, 10, 18) / 1000] } };
    const r = await weatherFor(45.7, 25.53, parseWhen("2024-07-10T20:30"), 530, new Date("2026-11-17T08:00:00Z"), { fetchJson: async () => json });
    expect(r.time.toISOString()).toBe("2024-07-10T17:30:00.000Z");
    expect(r.weather.utcOffsetH).toBe(3);
  });

  it("keeps winter time in winter", async () => {
    const json = { ...fixture, utc_offset_seconds: 7200, hourly: { ...fixture.hourly, time: [Date.UTC(2024, 0, 10, 10) / 1000] } };
    const r = await weatherFor(45.7, 25.53, parseWhen("2024-01-10T12:00"), 530, new Date("2026-11-17T08:00:00Z"), { fetchJson: async () => json });
    expect(r.time.toISOString()).toBe("2024-01-10T10:00:00.000Z");
  });
});
