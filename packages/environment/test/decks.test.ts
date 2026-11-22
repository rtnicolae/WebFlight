import { describe, expect, it } from "vitest";
import { airAt } from "../src/air.ts";
import { clearSkyGhi, cloudDecks, criticalHumidity, deckDepthScale, deckTransmission, MIN_DECK_M, sundqvistFraction } from "../src/decks.ts";
import type { Weather, WindLevel } from "../src/weather.ts";

// Magnus, as decks.ts: the dew point for a relative humidity at a temperature.
const dew = (t: number, rh: number) => {
  const g = Math.log(rh) + (17.67 * t) / (t + 243.5);
  return (243.5 * g) / (17.67 - g);
};
const es = (t: number) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));

/**
 * A column over Ghimbav (ICON-EU's ground 551 m): the pressure levels' heights and relative
 * humidities of 22 Nov 2026 at 10:00 UTC, temperatures typical of the day.
 */
function column(rh: Record<number, number>, o: Partial<Weather> = {}): Weather {
  const lv: [number, number, number][] = [
    [925, 776, 3],
    [900, 997, 2],
    [850, 1455, 0],
    [800, 1936, -2],
    [700, 2973, -7],
    [600, 4143, -14],
    [500, 5495, -22],
    [400, 7091, -32],
  ];
  const aloft: WindLevel[] = lv.map(([p, z, t]) => ({ altM: z, fromDeg: 250, kt: 15, hPa: p, tempC: t, dewPointC: dew(t, rh[p]!) }));
  return {
    source: "forecast",
    timeUtc: "2026-11-22T10:00:00.000Z",
    utcOffsetH: 2,
    elevationM: 551,
    tempC: 5,
    dewPointC: dew(5, rh[0] ?? 0.63),
    windFromDeg: 250,
    windKt: 6,
    gustKt: 10,
    aloft,
    lowCloud: 0.48,
    midCloud: 0.4,
    highCloud: 0,
    shortwaveWm2: 250,
    boundaryLayerM: 580,
    surfacePressureHpa: 951.2,
    visibilityM: 39800,
    ...o,
  };
}
const NOV22 = { 925: 0.58, 900: 0.53, 850: 0.64, 800: 0.9, 700: 0.86, 600: 0.1, 500: 0.06, 400: 0.07 };
const DRY = { 925: 0.5, 900: 0.5, 850: 0.55, 800: 0.66, 700: 0.5, 600: 0.3, 500: 0.2, 400: 0.2 };

describe("cloud decks", () => {
  it("takes Open-Meteo's critical humidity (Sundqvist et al. 1989)", () => {
    expect(criticalHumidity(1000)).toBeCloseTo(0.889, 3);
    expect(criticalHumidity(800)).toBeCloseTo(0.741, 3);
    expect(criticalHumidity(500)).toBeCloseTo(0.7, 3);
    expect(sundqvistFraction(0.7, 0.8)).toBe(0);
    expect(sundqvistFraction(1, 0.8)).toBe(1);
    // Open-Meteo's pressure-level cover for the profile below: 38 % at 800 hPa, 30 % at 700.
    expect(sundqvistFraction(0.9, criticalHumidity(800))).toBeCloseTo(0.38, 1);
    expect(sundqvistFraction(0.86, criticalHumidity(700))).toBeCloseTo(0.3, 1);
  });

  it("puts a deck where the profile is above it, one cloud through 800 hPa", () => {
    const w = column(NOV22);
    const d = cloudDecks(w);
    expect(d).toHaveLength(2);
    const [low, mid] = d as [(typeof d)[0], (typeof d)[0]];
    expect(low).toMatchObject({ band: "low", cover: 0.48, from: "profile" });
    expect(mid).toMatchObject({ band: "mid", cover: 0.4, from: "profile", joined: true });
    // Between 850 hPa (64 %) and 800 (90 %) the humidity crosses the threshold; above 700 (86 %)
    // it dries out to 10 % by 600 hPa.
    expect(low.baseM).toBeGreaterThan(1455);
    expect(low.baseM).toBeLessThan(1936);
    expect(low.topM).toBeCloseTo(mid.baseM, 6);
    expect(airAt(w, low.topM).hPa).toBeCloseTo(800, 0);
    expect(mid.topM).toBeGreaterThan(2973);
    expect(mid.topM).toBeLessThan(3300);
    // The edges are where the humidity is at the threshold.
    const e = (z: number) => {
      const a = airAt(w, z);
      return es(a.dewPointC) / es(a.tempC) - criticalHumidity(a.hPa);
    };
    expect(Math.abs(e(low.baseM))).toBeLessThan(0.01);
    expect(Math.abs(e(mid.topM))).toBeLessThan(0.01);
  });

  it("puts sub-grid cloud at the band's most humid layer", () => {
    const d = cloudDecks(column(DRY, { midCloud: 0 }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ band: "low", from: "humid", cover: 0.48 });
    // 800 hPa (1936 m) is the most humid; the deck is near it, in the low band.
    expect(d[0]!.topM - d[0]!.baseM).toBeGreaterThanOrEqual(MIN_DECK_M - 1e-6);
    expect(d[0]!.topM - d[0]!.baseM).toBeLessThanOrEqual(800);
    expect(d[0]!.baseM).toBeGreaterThan(1500);
    expect(d[0]!.topM).toBeLessThanOrEqual(1937);
  });

  it("leaves sub-grid low cloud on a cumulus day to the cumulus", () => {
    expect(cloudDecks(column(DRY, { midCloud: 0 }), { cumulus: true })).toEqual([]);
    // A saturated layer is still a deck (stratocumulus).
    expect(cloudDecks(column(NOV22), { cumulus: true }).map((x) => x.band)).toEqual(["low", "mid"]);
  });

  it("starts a deck from the ground at the condensation level, or on it in fog", () => {
    const wet = { ...DRY, 0: 0.99, 925: 0.99, 900: 0.99 };
    const d = cloudDecks(column(wet, { midCloud: 0, lowCloud: 1 }));
    expect(d[0]!.fog).toBeUndefined();
    expect(d[0]!.baseM).toBeCloseTo(551 + MIN_DECK_M, 0); // a spread of 0.1 °C: Espy's 13 m, at least 150
    const f = cloudDecks(column(wet, { midCloud: 0, lowCloud: 1, visibilityM: 600 }));
    expect(f[0]).toMatchObject({ fog: true, baseM: 551 });
    expect(f[0]!.topM).toBeGreaterThan(776);
  });

  it("estimates heights without pressure levels, and draws nothing for the offline estimate", () => {
    const w = column(NOV22, { source: "archive", tempC: 8, dewPointC: 4, boundaryLayerM: 900 });
    const arch = { ...w, aloft: [{ altM: 2051, fromDeg: 250, kt: 20 }] };
    delete (arch as Partial<Weather>).surfacePressureHpa;
    const d = cloudDecks(arch);
    expect(d.map((x) => x.from)).toEqual(["estimate", "estimate"]);
    expect(d[0]).toMatchObject({ band: "low", baseM: 551 + 500, topM: 551 + 900 });
    expect(cloudDecks(arch, { cumulus: true }).map((x) => x.band)).toEqual(["mid"]);
    expect(cloudDecks({ ...w, source: "estimated" })).toEqual([]);
    expect(cloudDecks(column(NOV22, { lowCloud: 0.01, midCloud: 0.02 }))).toEqual([]);
  });
});

describe("the decks' depth from the radiation", () => {
  it("passes the weather's share of the clear-sky light", () => {
    // 12 Nov 2026, 14:00 at Ghimbav: 202 W/m² with the sun at ~19°, low cloud 70 %, mid 94 %.
    const el = 19, k = 202 / clearSkyGhi(el), mu = Math.sin((el * Math.PI) / 180);
    expect(clearSkyGhi(el)).toBeGreaterThan(280);
    expect(clearSkyGhi(el)).toBeLessThan(320);
    const decks = [
      { cover: 0.7, tau: 0.05 * 0.75 * 852 },
      { cover: 0.94, tau: 0.03 * 0.75 * 3729 },
    ];
    const s = deckDepthScale(decks, k, el);
    const through = decks.reduce((p, d) => p * (1 - d.cover * (1 - deckTransmission(0.75 * s * d.tau, mu))), 1);
    expect(through).toBeCloseTo(k, 4);
    expect(s).toBeLessThan(0.2); // much thinner than solid cloud through the humid run
    // Clearer than any deck can be, darker than any can make it, the sun too low: the limits, 1.
    expect(deckDepthScale(decks, 1, el)).toBeCloseTo(0.02, 6);
    expect(deckDepthScale(decks, 0.01, el)).toBeCloseTo(5, 6);
    expect(deckDepthScale(decks, k, 3)).toBe(1);
    expect(deckTransmission(0, 0.5)).toBe(1);
    expect(deckTransmission(10, 1)).toBeCloseTo(1 / (1 + 0.9), 6);
  });
});
