/**
 * Layers of stratiform cloud (stratus, stratocumulus, altostratus, altocumulus) from the weather
 * model's own cloud cover and its humidity profile. These are drawn only: the simulation doesn't
 * read them, because the day's radiation already carries the dimming they cause.
 *
 * How much sky each deck covers is the model's cover of its band. ICON, Open-Meteo's best match
 * over Europe, counts low cloud from the ground to 800 hPa and mid cloud from 800 to 400 hPa;
 * high cloud is the cirrus (atmosphere.ts). Neither cover says where in its band the cloud is.
 *
 * The height comes from the humidity profile, the column's air (air.ts: temperature and dew
 * point linear in height between the 2 m values and the pressure levels). Cloud is taken where
 * the relative humidity is above Sundqvist et al.'s (1989) critical humidity. That threshold
 * rises towards the ground, RHc(p) = 0.7 + 0.2·exp(1 − (1013.25/p)⁴): 0.89 at 1000 hPa, 0.74 at
 * 800 and 0.70 aloft. Open-Meteo derives its pressure-level cloud cover the same way
 * (Meteorology.swift), following ECMWF's cloud-cover notes and Mauritsen et al. 2019 (§3.1).
 *
 * In each band, the deck is the run of the profile above the threshold whose largest Sundqvist
 * fraction is highest, cut to the band. A run through 800 hPa gives a low and a mid deck that are
 * one cloud. Such decks share their holes (maximum overlap, as the models assume for
 * contiguous cloud); separate decks are independent (random overlap).
 *
 * The model can have cloud where its grid air is below the threshold (sub-grid cloud). Then the
 * deck is put at the band's most humid layer (within 3 % RH of its peak, 150–800 m deep). On a
 * cumulus day, sub-grid low cloud is the cumulus already drawn over the thermals, so it makes no
 * deck.
 *
 * A deck from the ground starts at the 2 m air's condensation level (Espy: 125 m per °C of
 * dew-point spread), unless the visibility is under 1 km (WMO's fog). Without pressure levels
 * (the reanalysis), heights are estimates: the low deck from that condensation level to the
 * boundary layer's top (none on a cumulus day: there is no telling it from the cumulus), the mid
 * one round 600 hPa.
 */
import { airAt } from "./air.ts";
import type { Weather } from "./weather.ts";

export interface CloudDeck {
  /** Base and top [m above sea level]. */
  baseM: number;
  topM: number;
  /** Share of the sky it covers, 0–1. */
  cover: number;
  band: "low" | "mid";
  /** One cloud with the deck below it, through the band boundary: drawn with the same holes. */
  joined?: boolean;
  /** From the ground: fog (visibility under 1 km). */
  fog?: boolean;
  /**
   * Where its height came from:
   * - "profile": the humidity profile above the critical humidity;
   * - "humid": the band's most humid layer (sub-grid cloud);
   * - "estimate": no pressure levels.
   */
  from: "profile" | "humid" | "estimate";
}

/** Sundqvist's critical relative humidity at a pressure [hPa] (Open-Meteo's, after ECMWF). */
export function criticalHumidity(hPa: number): number {
  return 0.7 + 0.2 * Math.exp(1 - (1013.25 / hPa) ** 4);
}

/** Sundqvist et al. (1989) cloud fraction at a relative humidity (0–1) over its critical one. */
export function sundqvistFraction(rh: number, rhc: number): number {
  return Math.max(0, 1 - Math.sqrt(Math.max(0, 1 - rh) / (1 - rhc)));
}

/** Upper ends of the low and mid bands [hPa] (ICON's CLCL and CLCM). */
export const LOW_TOP_HPA = 800;
export const MID_TOP_HPA = 400;
/** Thinnest deck drawn [m]. */
export const MIN_DECK_M = 150;
/** Least cover drawn. */
const MIN_COVER = 0.03;
/** Sampling step of the profile [m]. */
const STEP_M = 25;

const es = (t: number) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));

interface Sample {
  z: number;
  /** Relative humidity above the critical one. */
  e: number;
  /** Sundqvist fraction. */
  f: number;
}

interface Run {
  z0: number;
  z1: number;
}

/** Height [m above sea level] of a pressure in the column (bisection on airAt). */
function heightOf(w: Weather, hPa: number): number {
  let lo = w.elevationM - 500, hi = w.elevationM + 15000;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (airAt(w, m).hPa > hPa) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** Runs of the samples above the critical humidity, the crossings between samples linear. */
function runsOf(s: Sample[]): Run[] {
  const runs: Run[] = [];
  let start: number | undefined;
  for (let i = 0; i < s.length; i++) {
    const a = s[i]!;
    if (a.e > 0 && start === undefined) start = i === 0 ? a.z : cross(s[i - 1]!, a);
    if (start !== undefined && (a.e <= 0 || i === s.length - 1)) {
      runs.push({ z0: start, z1: a.e > 0 ? a.z : cross(s[i - 1]!, a) });
      start = undefined;
    }
  }
  return runs;
}
const cross = (a: Sample, b: Sample) => a.z + ((0 - a.e) / (b.e - a.e)) * (b.z - a.z);

/** At least MIN_DECK_M deep, round its middle, inside [lo, hi] where it can be. */
function deepen(z0: number, z1: number, lo: number, hi: number): [number, number] {
  if (z1 - z0 >= MIN_DECK_M) return [z0, z1];
  const m = Math.min(hi - MIN_DECK_M / 2, Math.max(lo + MIN_DECK_M / 2, (z0 + z1) / 2));
  return [m - MIN_DECK_M / 2, m + MIN_DECK_M / 2];
}

/**
 * The weather's cloud decks, lowest first. `cumulus`: the thermals draw cumulus today. Sub-grid
 * low cloud then makes no deck.
 */
export function cloudDecks(w: Weather, o: { cumulus?: boolean } = {}): CloudDeck[] {
  if (w.source === "estimated") return [];
  const g = w.elevationM;
  const bands: { band: "low" | "mid"; cover: number; lo: number; hi: number }[] = [];
  const levels = w.aloft.some((l) => l.hPa !== undefined && l.tempC !== undefined && l.dewPointC !== undefined) && w.surfacePressureHpa !== undefined;
  const zLow = heightOf(w, LOW_TOP_HPA), zMid = heightOf(w, MID_TOP_HPA);
  if (w.lowCloud >= MIN_COVER && zLow > g) bands.push({ band: "low", cover: Math.min(1, w.lowCloud), lo: g, hi: zLow });
  if ((w.midCloud ?? 0) >= MIN_COVER) bands.push({ band: "mid", cover: Math.min(1, w.midCloud!), lo: Math.max(g, zLow), hi: zMid });
  if (!bands.length) return [];
  // The 2 m air's condensation level above the ground (Espy).
  const lcl = Math.max(MIN_DECK_M, 125 * Math.max(0, w.tempC - w.dewPointC));
  const fog = w.visibilityM !== undefined && w.visibilityM < 1000;
  if (!levels) {
    return bands.flatMap((b): CloudDeck[] => {
      // (On a cumulus day the low cloud is the cumulus: no deck, as for sub-grid cloud below.)
      if (b.band === "low" && o.cumulus) return [];
      if (b.band === "low") {
        const base = fog ? g : g + lcl;
        return [{ baseM: base, topM: Math.max(base + 300, g + w.boundaryLayerM), cover: b.cover, band: b.band, from: "estimate" as const, ...(fog ? { fog } : {}) }];
      }
      const z = heightOf(w, 600);
      return [{ baseM: z - 300, topM: z + 300, cover: b.cover, band: b.band, from: "estimate" as const }];
    });
  }
  const s: Sample[] = [];
  for (let z = g + 2; z <= zMid + STEP_M; z += STEP_M) {
    const a = airAt(w, z), rh = Math.min(1, es(a.dewPointC) / es(a.tempC)), rhc = criticalHumidity(a.hPa);
    s.push({ z, e: rh - rhc, f: sundqvistFraction(rh, rhc) });
  }
  const runs = runsOf(s);
  const peak = (z0: number, z1: number) => s.reduce((m, x) => (x.z >= z0 - STEP_M / 2 && x.z <= z1 + STEP_M / 2 ? Math.max(m, x.f) : m), 0);
  const out: (CloudDeck & { run?: Run })[] = [];
  for (const b of bands) {
    let best: { run: Run; f: number } | undefined;
    for (const r of runs) {
      const z0 = Math.max(r.z0, b.lo), z1 = Math.min(r.z1, b.hi);
      if (z1 <= z0) continue;
      const f = peak(z0, z1);
      if (!best || f > best.f) best = { run: r, f };
    }
    if (best) {
      let z0 = Math.max(best.run.z0, b.lo);
      const z1 = Math.min(best.run.z1, b.hi);
      const fromGround = z0 <= g + 2 + STEP_M;
      if (fromGround) z0 = fog ? g : Math.max(g, Math.min(g + lcl, z1 - MIN_DECK_M));
      const [base, top] = deepen(z0, z1, b.lo, b.hi);
      out.push({ baseM: base, topM: top, cover: b.cover, band: b.band, from: "profile", run: best.run, ...(fromGround && fog ? { fog } : {}) });
      continue;
    }
    if (b.band === "low" && o.cumulus) continue;
    // Sub-grid cloud: the band's most humid layer.
    const inBand = s.filter((x) => x.z >= b.lo && x.z <= b.hi);
    if (!inBand.length) continue;
    const eMax = Math.max(...inBand.map((x) => x.e));
    const k = inBand.findIndex((x) => x.e === eMax);
    let i0 = k, i1 = k;
    while (i0 > 0 && inBand[i0 - 1]!.e > eMax - 0.03) i0--;
    while (i1 < inBand.length - 1 && inBand[i1 + 1]!.e > eMax - 0.03) i1++;
    let z0 = inBand[i0]!.z, z1 = inBand[i1]!.z;
    if (z1 - z0 > 800) {
      const m = inBand[k]!.z;
      z0 = Math.max(z0, m - 400);
      z1 = z0 + 800;
    }
    const fromGround = z0 <= g + 2 + STEP_M;
    if (fromGround && !fog) {
      z0 = g + lcl;
      z1 = Math.max(z1, z0 + MIN_DECK_M);
    }
    const [base, top] = deepen(fromGround && fog ? g : z0, z1, b.lo, b.hi);
    out.push({ baseM: base, topM: top, cover: b.cover, band: b.band, from: "humid", ...(fromGround && fog ? { fog } : {}) });
  }
  // One cloud through the band boundary: the mid deck continues the low one.
  const low = out.find((d) => d.band === "low"), mid = out.find((d) => d.band === "mid");
  if (low?.run && mid?.run && low.run === mid.run) mid.joined = true;
  return out.map(({ run: _r, ...d }) => d).sort((a, b) => a.baseM - b.baseM);
}

/** Clear-sky global radiation [W/m²] with the sun at an elevation (Haurwitz 1945). */
export function clearSkyGhi(sunElevationDeg: number): number {
  const mu = Math.sin((sunElevationDeg * Math.PI) / 180);
  return mu > 0.01 ? 1098 * mu * Math.exp(-0.057 / mu) : 0;
}

/**
 * The sunlight through a cloud layer of optical depth τ, direct and scattered together, with the
 * sun at μ = sin(elevation): conservative two-stream (Eddington), g = 0.85, the thick layer's
 * (½ + ¾μ) / (1 + ¾(1 − g)τ), made to reach 1 for a thin one: 1 / (1 + ¾(1 − g)τ / (½ + ¾μ)).
 */
export function deckTransmission(tau: number, mu: number): number {
  return 1 / (1 + (0.1125 * tau) / (0.5 + 0.75 * Math.max(0, mu)));
}

/**
 * How thick the decks are, from the weather's own radiation. Each deck k (cover c, optical depth
 * τ through a full patch at mean density) lets through 1 − c(1 − T(¾τ)) on average (its patches
 * are three quarters as deep on average). The factor s on every τ that makes the decks together
 * pass the weather's share of the clear-sky radiation (`clearness`: its global radiation over
 * clearSkyGhi): the model's cover counts thin cloud too, and the run of humid air a deck fills
 * isn't solid cloud all through. 1/50 to 5; 1 with the sun below 5° (too little light to tell).
 */
export function deckDepthScale(decks: { cover: number; tau: number }[], clearness: number, sunElevationDeg: number): number {
  if (sunElevationDeg < 5 || !decks.length) return 1;
  const mu = Math.sin((sunElevationDeg * Math.PI) / 180), k = Math.min(1, Math.max(0.02, clearness));
  const through = (s: number) => decks.reduce((p, d) => p * (1 - d.cover * (1 - deckTransmission(0.75 * s * d.tau, mu))), 1);
  let lo = Math.log(0.02), hi = Math.log(5);
  if (through(Math.exp(lo)) <= k) return Math.exp(lo);
  if (through(Math.exp(hi)) >= k) return Math.exp(hi);
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (through(Math.exp(m)) > k) lo = m;
    else hi = m;
  }
  return Math.exp((lo + hi) / 2);
}
