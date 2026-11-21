import { describe, expect, it } from "vitest";
import { airAt, blendWeather, estimateWeather, GridFollower, gridAround, openMeteoGridUrl, parseWeatherGrid, soaringFrom, ThermalSky, WeatherClock, weatherOnGrid, type Weather, type WeatherGrid } from "../src/index.ts";

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

  // Open-Meteo's answer for columns asked for (a stand-in): the layer deepens eastwards, ~420 m a node.
  const layerAt = (lon: number) => 1000 + 2000 * (lon - 25);
  const answer = (lat: number, lon: number) => ({
    latitude: lat,
    longitude: lon,
    elevation: 530,
    utc_offset_seconds: 10800,
    timezone: "Europe/Bucharest",
    hourly: {
      time: [NOON.getTime() / 1000, NOON.getTime() / 1000 + 3600],
      temperature_2m: [28, 29],
      dew_point_2m: [14, 14],
      wind_speed_10m: [5, 6],
      wind_direction_10m: [300, 300],
      wind_gusts_10m: [8, 9],
      cloud_cover_low: [10, 10],
      shortwave_radiation: [800, 800],
      boundary_layer_height: [layerAt(lon), layerAt(lon) + 100],
    },
  });
  const openMeteo = (urls: string[], fail = () => false) => async (url: string): Promise<unknown> => {
    urls.push(url);
    if (fail()) throw new Error("HTTP 429");
    const q = new URL(url).searchParams, la = q.get("latitude")!.split(",").map(Number), lo = q.get("longitude")!.split(",").map(Number);
    const list = la.map((x, k) => answer(x, lo[k]!));
    return list.length === 1 ? list[0] : list;
  };
  const firstGrid = async (): Promise<WeatherGrid> => {
    const g = gridAround(45.65, 25.5);
    return { ...parseWeatherGrid(await openMeteo([])(openMeteoGridUrl(g, "2026-07-14", "2026-07-16")), g, "forecast", 3), request: { from: "2026-07-14", to: "2026-07-16", source: "forecast", utcOffsetH: 3 } };
  };

  describe("moving with the flight", () => {
    it("stays while the aircraft is a spacing inside, then moves on its lattice asking only for the new column", async () => {
      const urls: string[] = [];
      const first = await firstGrid(), f = new GridFollower(first, openMeteo(urls));
      const { dLat, dLon } = first, mid = (k: number) => 25.5 + k * dLon;
      expect(await f.follow(45.65 + 0.9 * dLat, mid(0.95))).toBeUndefined();
      expect(urls).toHaveLength(0);
      // 1.2 spacings east of the middle, 0.8 from the edge: the grid moves a column east.
      const lat = 45.65 + 0.3 * dLat, lon = mid(1.2);
      const before = weatherOnGrid(first, NOON)(lat, lon);
      const g = (await f.follow(lat, lon))!;
      expect(urls).toHaveLength(1);
      const q = new URL(urls[0]!).searchParams;
      expect(q.get("latitude")!.split(",")).toHaveLength(5);
      expect(q.get("longitude")!.split(",").map(Number).every((x) => Math.abs(x - mid(3)) < 1e-4)).toBe(true);
      expect(q.get("start_date")).toBe("2026-07-14");
      expect(g.lat0).toBeCloseTo(first.lat0, 12);
      expect(g.lon0).toBeCloseTo(first.lon0 + dLon, 12);
      // The same columns where the grids overlap: the weather where the aircraft is doesn't jump.
      for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) expect(g.nodes[i * 5 + j]).toBe(first.nodes[i * 5 + j + 1]);
      const after = weatherOnGrid(g, NOON)(lat, lon);
      expect(after.boundaryLayerM).toBeCloseTo(before.boundaryLayerM, 6);
      expect(after.tempC).toBeCloseTo(before.tempC, 6);
      // And the new column is the place's own, not the old edge's.
      expect(weatherOnGrid(g, NOON)(45.65, mid(3)).boundaryLayerM).toBeCloseTo(layerAt(mid(3)), 0);
      expect(weatherOnGrid(first, NOON)(45.65, mid(3)).boundaryLayerM).toBeCloseTo(layerAt(mid(2)), 0);
      expect(await f.follow(lat, lon)).toBeUndefined();
    });

    it("asks for nothing to go back: flying back, or a reset to the start", async () => {
      const urls: string[] = [];
      const first = await firstGrid(), f = new GridFollower(first, openMeteo(urls));
      const { dLat, dLon } = first;
      await f.follow(45.65 + 1.3 * dLat, 25.5 + 1.4 * dLon); // north-east: a row and a column (9)
      expect(new URL(urls[0]!).searchParams.get("latitude")!.split(",")).toHaveLength(9);
      expect(f.grid.lat0).toBeCloseTo(first.lat0 + dLat, 12);
      // A reset to the start: at once, from the columns had.
      const back = f.moveNow(45.65, 25.5)!;
      expect(back.lat0).toBeCloseTo(first.lat0, 12);
      expect(back.lon0).toBeCloseTo(first.lon0, 12);
      expect(back.nodes.every((n, k) => n === first.nodes[k])).toBe(true);
      // Out again, the same way: nothing asked for.
      expect(await f.follow(45.65 + 1.3 * dLat, 25.5 + 1.4 * dLon)).toBeDefined();
      expect(urls).toHaveLength(1);
      // Somewhere new can't be had at once.
      expect(f.moveNow(45.65, 25.5 + 6 * dLon)).toBeUndefined();
    });

    it("keeps its grid when the request fails, and asks again a minute later", async () => {
      const urls: string[] = [];
      let down = true;
      const first = await firstGrid(), f = new GridFollower(first, openMeteo(urls, () => down));
      const east = 25.5 + 1.5 * first.dLon;
      await expect(f.follow(45.65, east, 0)).rejects.toThrow(/429/);
      expect(f.grid).toBe(first);
      expect(await f.follow(45.65, east, 30_000)).toBeUndefined();
      expect(urls).toHaveLength(1);
      down = false;
      expect((await f.follow(45.65, east, 61_000))!.lon0).toBeCloseTo(first.lon0 + first.dLon, 12);
    });

    it("drops an answer that comes after a later move, and passes new columns through the map", async () => {
      let release: () => void = () => {};
      const urls: string[] = [];
      const first = await firstGrid();
      const slow = async (url: string) => {
        await new Promise<void>((r) => (release = r));
        return openMeteo(urls)(url);
      };
      const f = new GridFollower(first, slow, (w) => ({ ...w, windKt: 33 }));
      const out = f.follow(45.65, 25.5 + 1.5 * first.dLon);
      // A reset while it is out (the grid already round the start: no move); the answer, for
      // where the glider was, is not applied.
      expect(f.moveNow(45.65, 25.5)).toBeUndefined();
      release();
      expect(await out).toBeUndefined();
      expect(f.grid).toBe(first);
      // Its columns are kept, mapped: the next check moves at once.
      const g = (await f.follow(45.65, 25.5 + 1.5 * first.dLon))!;
      expect(urls).toHaveLength(1);
      expect(g.nodes[4]![0]!.windKt).toBe(33);
      expect(g.nodes[3]![0]!.windKt).toBe(first.nodes[4]![0]!.windKt);
    });

    it("leaves the thermals the grids share as they were", async () => {
      const first = await firstGrid(), f = new GridFollower(first, openMeteo([]));
      const w = weatherOnGrid(first, NOON)(45.65, 25.5 + 0.5 * first.dLon);
      const sky = new ThermalSky({ seed: 3, weather: w, grid: first, groundAt: () => 530 });
      const at = (s: ThermalSky) => s.thermalsAround(45.65, 25.5 + 0.5 * first.dLon, 4000).map((t) => ({ id: t.id, top: t.spec.heightMslFt, fps: t.spec.strengthFps }));
      const before = at(sky);
      expect(before.length).toBeGreaterThan(0);
      sky.setGrid((await f.follow(45.65, 25.5 + 1.5 * first.dLon))!);
      const after = at(sky);
      expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
      after.forEach((t, k) => {
        expect(t.top).toBeCloseTo(before[k]!.top, 6);
        expect(t.fps).toBeCloseTo(before[k]!.fps, 6);
      });
    });
  });
});
