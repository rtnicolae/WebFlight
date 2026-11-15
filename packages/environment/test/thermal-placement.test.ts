import { describe, expect, it } from "vitest";
import { estimateWeather, soaringFrom, ThermalSky, triggerScore } from "../src/index.ts";

// Summer early afternoon over Brașov; estimated (deterministic) weather.
const NOON = new Date("2026-07-15T11:00:00Z");
const W = estimateWeather(45.7, 25.53, NOON, 530);
const M_LAT = 111_132;
/** An east–west ridge at 45.70°N, 600 m high, 2 km half-width, on a 500 m plain. */
const ridge = (lat: number) => 500 + 600 * Math.max(0, 1 - Math.abs((lat - 45.7) * M_LAT) / 2000);

describe("thermal placement from terrain and sun", () => {
  it("rates a sunlit south face above a shaded north face, and hilltops above hollows", () => {
    const sun = { azimuthDeg: 180, elevationDeg: 60 };
    const g = (lat: number) => ridge(lat);
    const south = triggerScore(g, 45.7 - 1000 / M_LAT, 25.5, sun)!;
    const north = triggerScore(g, 45.7 + 1000 / M_LAT, 25.5, sun)!;
    const flat = triggerScore(() => 500, 45.6, 25.5, sun)!;
    expect(flat).toBeCloseTo(1, 5);
    expect(south).toBeGreaterThan(flat);
    expect(north).toBeLessThan(flat);
    const top = triggerScore(g, 45.7, 25.5, sun)!;
    const hollow = triggerScore((lat) => 1000 - ridge(lat), 45.7, 25.5, sun)!;
    expect(top).toBeGreaterThan(hollow);
  });

  it("puts more thermals on the sunny side of a ridge", () => {
    const sky = new ThermalSky({ seed: 3, weather: W, groundAt: (lat) => ridge(lat) });
    const ts = sky.thermalsAround(45.7, 25.5, 30_000);
    const south = ts.filter((t) => t.spec.latDeg < 45.7 - 300 / M_LAT && t.spec.latDeg > 45.7 - 2000 / M_LAT).length;
    const north = ts.filter((t) => t.spec.latDeg > 45.7 + 300 / M_LAT && t.spec.latDeg < 45.7 + 2000 / M_LAT).length;
    expect(south).toBeGreaterThan(north);
  });

  it("sizes the sky from the weather: count from spacing, strength from w*, tops from the boundary layer", () => {
    const s = soaringFrom(W);
    const sky = new ThermalSky({ seed: 1, weather: W, groundAt: () => 530 });
    const ts = sky.thermalsAround(45.7, 25.5, 20_000);
    const expected = (Math.PI * 20_000 ** 2) / s.spacingM ** 2;
    expect(ts.length).toBeGreaterThan(expected * 0.5);
    expect(ts.length).toBeLessThan(expected * 1.5);
    for (const t of ts) {
      const ms = t.spec.strengthFps * 0.3048;
      expect(ms).toBeGreaterThan(s.wStarMs * 0.6);
      expect(ms).toBeLessThan(s.wStarMs * 2.3);
      expect(t.spec.heightMslFt * 0.3048).toBeCloseTo(530 + s.thermalTopAglM, 0);
    }
  });

  it("has no thermals at night", () => {
    const night = estimateWeather(45.7, 25.53, new Date("2026-07-15T23:00:00Z"));
    expect(new ThermalSky({ seed: 1, weather: night, groundAt: () => 530 }).thermalsAround(45.7, 25.5, 20_000)).toEqual([]);
  });

  it("waits for terrain before placing a cell's thermals, then places the same ones", () => {
    let loaded = false;
    const g = (lat: number) => (loaded ? ridge(lat) : undefined);
    const sky = new ThermalSky({ seed: 2, weather: W, groundAt: g, radiusCells: 1 });
    const wind = { groundFromDeg: 0, groundKt: 0, aloftFromDeg: 0, aloftKt: 0 };
    sky.update(1, { latDeg: 45.7, lonDeg: 25.5, altFt: 4000 }, wind);
    expect(sky.thermals.length).toBe(0);
    loaded = true;
    sky.update(1, { latDeg: 45.7, lonDeg: 25.5, altFt: 4000 }, wind);
    const ids = sky.thermals.map((t) => [t.id, t.spec.latDeg]);
    expect(ids.length).toBeGreaterThan(0);
    const again = new ThermalSky({ seed: 2, weather: W, groundAt: (lat) => ridge(lat), radiusCells: 1 });
    again.update(1, { latDeg: 45.7, lonDeg: 25.5, altFt: 4000 }, wind);
    expect(again.thermals.map((t) => [t.id, t.spec.latDeg])).toEqual(ids);
  });
});

