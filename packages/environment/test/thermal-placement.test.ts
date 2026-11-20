import { describe, expect, it } from "vitest";
import { allenRadius, allenUpdraft, allenMeanUpdraft, CALIBRATION_CIRCLE_M, estimateWeather, soaringFrom, Thermal, thermalUpdraft, ThermalSky, triggerScore, UPDRAFT_GAIN } from "../src/index.ts";

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
    const foot = (t: (typeof ts)[number]) => t.footLatLon[0];
    const south = ts.filter((t) => foot(t) < 45.7 - 300 / M_LAT && foot(t) > 45.7 - 2000 / M_LAT).length;
    const north = ts.filter((t) => foot(t) > 45.7 + 300 / M_LAT && foot(t) < 45.7 + 2000 / M_LAT).length;
    expect(south).toBeGreaterThan(north);
  });

  it("stands each thermal on its trigger and carries its top, where the cloud is, downwind", () => {
    // The estimate's wind: from the west, 7 kt at the ground to 14 kt at 1,500 m.
    const sky = new ThermalSky({ seed: 1, weather: W, groundAt: () => 530 });
    const ts = sky.thermalsAround(45.7, 25.5, 15_000);
    expect(ts.length).toBeGreaterThan(10);
    const mLon = 111_320 * Math.cos((45.7 * Math.PI) / 180);
    for (const t of ts) {
      const [lat, lon] = t.footLatLon;
      const east = (t.spec.lonDeg - lon) * mLon, north = (t.spec.latDeg - lat) * M_LAT;
      const depth = t.spec.heightMslFt * 0.3048 - 530, w = t.spec.strengthFps * 0.3048;
      // Between the surface and the 1,500 m wind, over the depth at the thermal's rise speed.
      expect(east).toBeGreaterThan((depth * 7 * 0.5144) / w);
      expect(east).toBeLessThan((depth * 14 * 0.5144) / w);
      expect(Math.abs(north)).toBeLessThan(0.15 * east);
    }
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

  it("gives thermals a skewed spread of widths, the wider ones stronger", () => {
    const sky = new ThermalSky({ seed: 3, weather: W, groundAt: () => 530 });
    const ts = sky.thermalsAround(45.7, 25.5, 40_000);
    expect(ts.length).toBeGreaterThan(100);
    const d = ts.map((t) => t.spec.diameterFt).sort((a, b) => a - b);
    const mean = d.reduce((a, b) => a + b, 0) / d.length, median = d[Math.floor(d.length / 2)]!;
    // Many narrow, a few wide: the median below the mean, the widest well over twice the median.
    expect(median).toBeLessThan(mean);
    expect(d[d.length - 1]! / median).toBeGreaterThan(2);
    // Wider thermals are stronger on average: ~1.15 over thousands of thermals (1.15-1.17 across
    // seeds at 80 km); a 40 km sample scatters about ±0.01 round that.
    const by = (lo: number, hi: number) => ts.filter((t) => t.spec.diameterFt >= d[Math.floor(lo * d.length)]! && t.spec.diameterFt <= d[Math.floor(hi * (d.length - 1))]!);
    const avg = (xs: typeof ts) => xs.reduce((a, t) => a + t.spec.strengthFps, 0) / xs.length;
    expect(avg(by(0.75, 1))).toBeGreaterThan(avg(by(0, 0.25)) * 1.1);
  });

  describe("as the weather changes through the flight (setWeather)", () => {
    const calm = { groundFromDeg: 0, groundKt: 0, aloftFromDeg: 0, aloftKt: 0 };
    const at = { latDeg: 45.7, lonDeg: 25.5, altFt: 4000 };
    const hour = (h: number) => estimateWeather(45.7, 25.53, new Date(`2026-07-15T${String(h).padStart(2, "0")}:00:00Z`), 530);
    it("adds forming thermals where the morning had none", () => {
      const sky = new ThermalSky({ seed: 3, weather: hour(3), groundAt: () => 530 });
      sky.update(1, at, calm);
      expect(sky.thermals).toEqual([]);
      sky.setWeather(hour(10));
      const ts = sky.thermals;
      expect(ts.length).toBeGreaterThan(20);
      // They start at the beginning of their life (no cloud yet), not mid-cycle.
      expect(ts.every((t) => t.cycleTimer === 0)).toBe(true);
    });
    it("keeps each thermal in place and in its cycle, with the new strength", () => {
      const sky = new ThermalSky({ seed: 3, weather: hour(8), groundAt: () => 530 });
      sky.update(1, at, calm);
      const before = new Map(sky.thermals.map((t) => [t.id, { foot: t.footLatLon, cycle: t.cycleTimer, s: t.spec.strengthFps }]));
      sky.setWeather(hour(11));
      const kept = sky.thermals.filter((t) => before.has(t.id));
      expect(kept.length).toBeGreaterThan(10);
      for (const t of kept) {
        const b = before.get(t.id)!;
        // (Within a metre: the flat-earth offsets there and back don't cancel exactly.)
        expect(Math.abs(t.footLatLon[0] - b.foot[0]) * 111_132).toBeLessThan(1);
        expect(Math.abs(t.footLatLon[1] - b.foot[1]) * 77_800).toBeLessThan(1);
        if (!t.retiring) expect(t.cycleTimer).toBe(b.cycle);
      }
      // The sun higher: stronger.
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(mean(kept.map((t) => t.spec.strengthFps))).toBeGreaterThan(mean(kept.map((t) => before.get(t.id)!.s)));
    });
    it("lets them die out at night and drops them", () => {
      const sky = new ThermalSky({ seed: 3, weather: hour(11), groundAt: () => 530 });
      sky.update(1, at, calm);
      expect(sky.thermals.length).toBeGreaterThan(20);
      sky.setWeather(hour(23));
      expect(sky.thermals.every((t) => t.retiring)).toBe(true);
      // At most 10 more minutes of dying, then dead: dropped.
      for (let i = 0; i < 12 * 60; i++) sky.update(1, at, calm);
      expect(sky.thermals).toEqual([]);
    });
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


describe("NASA's updraft model (Allen 2006)", () => {
  it("reproduces the paper's check case: w* 2.56 m/s, zi 1,401 m, z 280 m", () => {
    const zi = 1401, zr = 280 / zi, r2 = allenRadius(zr) * zi, wt = allenMeanUpdraft(zr) * 2.56;
    expect(r2).toBeCloseTo(79.4, 1); // "yielded 79.4 m"
    expect(allenUpdraft(0, r2, wt, wt, zr)).toBeCloseTo(2.74, 2); // the peak of Figure 12
    // Closed off near the outer radius; beyond it, the sink between thermals.
    const sink = allenUpdraft(1e6, r2, wt, wt, zr);
    expect(sink).toBeLessThan(0);
    expect(allenUpdraft(1.2 * r2, r2, wt, wt, zr)).toBeCloseTo(sink, 9);
    // Mean updraft: at most 0.45 w*, near z/zi = 0.25, and none from 0.9 up.
    expect(allenMeanUpdraft(0.25)).toBeCloseTo(0.457, 3); // "maximum vertical velocity of 0.45 w*"
    expect(allenMeanUpdraft(0.91)).toBeLessThan(0);
  });

  it("is calibrated so a glider circling an average thermal at mid-height meets w* (RASP's rule)", () => {
    expect(UPDRAFT_GAIN).toBeGreaterThan(1.3);
    expect(UPDRAFT_GAIN).toBeLessThan(1.6);
    const zi = 1401, radius = (0.25 * zi) / 2;
    expect(thermalUpdraft(CALIBRATION_CIRCLE_M, 0.5, radius, { wStarMs: 2.56, gain: 1, cumulus: false })).toBeCloseTo(2.56, 9);
  });

  it("fades towards a blue top, holds up to a cumulus base, and stops there", () => {
    const at = (zr: number, cumulus: boolean) => thermalUpdraft(CALIBRATION_CIRCLE_M, zr, 200, { wStarMs: 2.4, gain: 1, cumulus });
    expect(at(0.85, false)).toBeLessThan(0.3 * at(0.4, false));
    expect(at(0.95, true)).toBeGreaterThan(0.9 * at(0.4, true));
    expect(at(1, true)).toBe(0);
    expect(at(1.05, false)).toBe(0);
    // Narrower low down: at 20 % of the height the lift 150 m out is a fraction of mid-height's.
    expect(thermalUpdraft(150, 0.2, 200, { wStarMs: 2.4, gain: 1, cumulus: false })).toBeLessThan(0.5 * thermalUpdraft(150, 0.5, 200, { wStarMs: 2.4, gain: 1, cumulus: false }));
  });

  it("keeps FG's life cycle: a bubble rising while forming, the bottom lifting off while dying", () => {
    const spec = { latDeg: 45.7, lonDeg: 25.5, heightMslFt: 2000 / 0.3048, strengthFps: 10, diameterFt: 400 / 0.3048, groundElevFt: 500 / 0.3048 };
    const th = new Thermal(spec, () => 0, undefined, undefined, { wStarMs: 2.4, gain: 1, cumulus: true });
    const wind = { groundFromDeg: 0, groundKt: 0, aloftFromDeg: 0, aloftKt: 0 };
    const lift = (cycleS: number, aglM: number) => ((th.cycleTimer = cycleS), th.run(0, { latDeg: 45.7, lonDeg: 25.5, altFt: (500 + aglM) / 0.3048 }, wind) * 0.3048);
    const between = thermalUpdraft(1e9, 0.3, 200, { wStarMs: 2.4, gain: 1, cumulus: true });
    expect(lift(10 * 60, 450)).toBeGreaterThan(2); // formed, 30 % up
    expect(lift(2.5 * 60, 450)).toBeGreaterThan(0.5); // half formed: the bubble is 750 m up
    expect(lift(2.5 * 60, 1200)).toBeCloseTo(thermalUpdraft(1e9, 0.8, 200, { wStarMs: 2.4, gain: 1, cumulus: true }), 9); // above it
    expect(lift(22.5 * 60, 450)).toBeCloseTo(between, 9); // dying: the bottom half gone
    expect(lift(22.5 * 60, 1200)).toBeGreaterThan(2);
    expect(lift(27 * 60, 1200)).toBeLessThanOrEqual(0); // dead
    expect(th.phase).toBe("dead");
  });
});
