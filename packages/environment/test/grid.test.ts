import { describe, expect, it } from "vitest";
import { airAt, blendWeather, estimateWeather, gridAround, openMeteoGridUrl, parseWeatherGrid, soaringFrom, ThermalSky, WeatherClock, weatherOnGrid, type Weather, type WeatherGrid } from "../src/index.ts";

const NOON = new Date("2026-07-15T11:00:00Z");
const base = estimateWeather(45.65, 25.5, NOON, 530);
/** A column: the estimate's, on its own ground, with its 2 m temperature and layer depth. */
const col = (elevationM: number, tempC: number, boundaryLayerM: number, over: Partial<Weather> = {}): Weather => ({ ...base, elevationM, tempC, dewPointC: tempC - 14, boundaryLayerM, aloft: [], ...over });

describe("weather by place (a grid of model columns)", () => {
  it("lays its nodes round the start, 16.5 km apart, and asks for all in one request", () => {
    const g = gridAround(45.65, 25.5);
    expect(g.rows * g.cols).toBe(25);
    expect(g.lat0 + 2 * g.dLat).toBeCloseTo(45.65, 9);
    expect(g.lon0 + 2 * g.dLon).toBeCloseTo(25.5, 9);
    expect(g.dLat * 111_195).toBeCloseTo(16_500, 3);
    expect(g.dLon * 111_195 * Math.cos((45.65 * Math.PI) / 180)).toBeCloseTo(16_500, 3);
    const url = openMeteoGridUrl(g, "2026-07-14", "2026-07-16");
    expect(new URL(url).searchParams.get("latitude")!.split(",").length).toBe(25);
    // On the model's own ground: no downscaling, so neighbouring columns agree.
    expect(new URL(url).searchParams.get("elevation")).toBe(Array(25).fill("nan").join(","));
    expect(() => parseWeatherGrid([{}], g, "forecast", 3)).toThrow(/1 of 25/);
  });

  it("blends columns at the same physical height", () => {
    // A basin column (500 m, 30 °C, layer 2,000 m deep) and a mountain one (1,500 m, 22 °C, 1,800 m).
    const basin = col(500, 30, 2000, { windFromDeg: 270, windKt: 10, surfacePressureHpa: 955 });
    const peak = col(1500, 22, 1800, { windFromDeg: 0, windKt: 10, surfacePressureHpa: 850 });
    const m = blendWeather([
      { w: basin, k: 0.5 },
      { w: peak, k: 0.5 },
    ]);
    expect(m.elevationM).toBeCloseTo(1000, 9);
    // Each column's air at 1,002 m (the standard lapse from its 2 m value): 26.75 and 25.25 °C.
    expect(m.tempC).toBeCloseTo((airAt(basin, 1002).tempC + airAt(peak, 1002).tempC) / 2, 9);
    expect(m.tempC).toBeCloseTo(26.0, 6);
    // The convective layer's top blended above sea level (2,500 and 3,300 m): 1,900 m over 1,000.
    expect(m.boundaryLayerM).toBeCloseTo(1900, 6);
    // Pressure: each column's at 1,000 m, blended in its logarithm.
    expect(m.surfacePressureHpa!).toBeCloseTo(Math.sqrt(airAt(basin, 1000).hPa * airAt(peak, 1000).hPa), 6);
    // West and north winds of 10 kt: from the north-west, weaker.
    expect(m.windFromDeg).toBeCloseTo(315, 6);
    expect(m.windKt).toBeCloseTo(10 / Math.SQRT2, 6);
  });

  // A 3 × 3 grid: the west column of nodes a deep layer, the east a shallow one.
  const grid = (): WeatherGrid => {
    const g = { lat0: 45.5, lon0: 25.3, dLat: 0.15, dLon: 0.2, rows: 3, cols: 3 };
    const nodes: Weather[][] = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const hour = (h: number, bl: number) => col(530, 28, bl, { timeUtc: new Date(NOON.getTime() + h * 3600_000).toISOString() });
        nodes.push([hour(0, [2400, 1800, 1200][j]!), hour(1, [2600, 2000, 1400][j]!)]);
      }
    return { ...g, nodes };
  };

  it("is each node's own weather at its node, bilinear between, the edge's beyond", () => {
    const g = grid(), at = weatherOnGrid(g, new Date(NOON.getTime() + 1800_000));
    expect(at(45.65, 25.5).boundaryLayerM).toBeCloseTo(1900, 6); // the middle node, half an hour on
    expect(at(45.65, 25.4).boundaryLayerM).toBeCloseTo(2200, 6); // between west and middle
    expect(at(45.65, 24.0).boundaryLayerM).toBeCloseTo(2500, 6); // far west: the west edge
    expect(at(45.65, 27.0).boundaryLayerM).toBeCloseTo(1300, 6);
  });

  it("gives a flight's clock the weather where the aircraft is", () => {
    const g = grid(), clock = new WeatherClock(g.nodes[4]!, NOON, 1, 60, g);
    expect(clock.step(0, { latDeg: 45.65, lonDeg: 25.3 })!.boundaryLayerM).toBeCloseTo(2400, 6);
    expect(clock.step(60, { latDeg: 45.65, lonDeg: 25.7 })!.boundaryLayerM).toBeCloseTo(1200 + 200 / 60, 6);
  });

  it("gives each sky cell its own convective layer: higher cloud bases where the layer is deeper", () => {
    const g = grid(), w = weatherOnGrid(g, NOON)(45.65, 25.5);
    const sky = new ThermalSky({ seed: 2, weather: w, grid: g, groundAt: () => 530 });
    const tops = (lon: number) => sky.thermalsAround(45.65, lon, 5000).map((t) => t.spec.heightMslFt * 0.3048);
    const west = tops(25.32), east = tops(25.68);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    // The tops follow each place's layer (cloud base or its top, the lower: soaringFrom).
    const top = (bl: number) => 530 + soaringFrom({ ...w, boundaryLayerM: bl, elevationM: 530 }).thermalTopAglM;
    expect(mean(west)).toBeGreaterThan(mean(east) + 300);
    expect(mean(west)).toBeLessThanOrEqual(top(2400) + 1);
    expect(mean(east)).toBeGreaterThanOrEqual(top(1200) - 1);
  });
});
