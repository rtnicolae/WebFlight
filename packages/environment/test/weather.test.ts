import { describe, expect, it } from "vitest";
import { estimateWeather, openMeteoUrl, parseWhen, parseOpenMeteo, soaringFrom, windAt, type Weather } from "../src/index.ts";

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
    expect(w.source).toBe("live");
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

  it("asks Open-Meteo for knots, local time and the levels it parses", () => {
    const u = openMeteoUrl(45.7, 25.53, "2026-07-14", "2026-07-16");
    expect(u).toContain("start_date=2026-07-14&end_date=2026-07-16");
    expect(u).toContain("wind_speed_unit=kn");
    expect(u).toContain("timezone=auto");
    expect(u).toContain("timeformat=unixtime");
    expect(u).toContain("boundary_layer_height");
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
