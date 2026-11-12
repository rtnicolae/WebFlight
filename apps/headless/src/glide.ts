/**
 * Milestone 1 experiments: a straight glide from 1000 m AGL and the speed polar.
 *
 * Polar values are reduced to sea level (ISA) so they compare with published polars:
 * speed is EAS, sink is multiplied by sqrt(sigma). Glide ratio is ground speed over
 * sink rate in still air.
 */
import { FT_PER_M, KMH_PER_KT, M_PER_FT, P, trimSteadyGlide, type Fdm, type GlideTrimResult, type InitialConditions } from "@webflight/fdm-core";

export const START: InitialConditions = {
  "ic/terrain-elevation-ft": 0,
  "ic/lat-geod-deg": 47.0,
  "ic/long-gc-deg": 8.0,
  "ic/h-agl-ft": 1000 * FT_PER_M,
  "ic/psi-true-deg": 0,
};

const ktsFromKmh = (kmh: number) => kmh / KMH_PER_KT;
const msFromFps = (fps: number) => fps * M_PER_FT;

export interface PolarPoint {
  easKmh: number;
  /** Sea-level-equivalent sink [m/s]. */
  sinkMs: number;
  glideRatio: number;
  alphaDeg: number;
  pitchTrim: number;
}

function toPoint(fdm: Fdm, t: GlideTrimResult): PolarPoint {
  return {
    easKmh: t.veKts * KMH_PER_KT,
    sinkMs: msFromFps(t.sinkFps) * Math.sqrt(fdm.get(P.sigma)),
    glideRatio: t.glideRatio,
    alphaDeg: t.alphaDeg,
    pitchTrim: t.control,
  };
}

/**
 * Steady-state polar from trim alone (no time integration). Continues from 100 km/h
 * down until trim fails (stall), then up to maxKmh.
 */
export function trimmedPolar(fdm: Fdm, opts: { stepKmh?: number; maxKmh?: number; base?: InitialConditions } = {}): PolarPoint[] {
  const step = opts.stepKmh ?? 2.5;
  const base = opts.base ?? START;
  const out: PolarPoint[] = [];
  const sweep = (from: number, dir: 1 | -1, limit: number) => {
    let guess: { alphaDeg: number; gammaDeg: number; control: number } | undefined;
    for (let v = from; dir > 0 ? v <= limit : v >= limit; v += dir * step) {
      const t = trimSteadyGlide(fdm, { speed: { veKts: ktsFromKmh(v) }, base, ...(guess ? { guess } : {}) });
      if (!t.converged) break;
      guess = { alphaDeg: t.alphaDeg, gammaDeg: t.gammaDeg, control: t.control };
      out.push(toPoint(fdm, t));
    }
  };
  sweep(100, -1, 40);
  sweep(100 + step, 1, opts.maxKmh ?? 200);
  return out.sort((a, b) => a.easKmh - b.easKmh);
}

export interface PolarSummary {
  bestGlide: PolarPoint;
  minSink: PolarPoint;
  minSpeed: PolarPoint;
}

export function summarizePolar(points: readonly PolarPoint[]): PolarSummary {
  if (points.length === 0) throw new Error("empty polar");
  const by = (f: (p: PolarPoint) => number) => points.reduce((a, b) => (f(b) > f(a) ? b : a));
  return {
    bestGlide: by((p) => p.glideRatio),
    minSink: by((p) => -p.sinkMs),
    minSpeed: by((p) => -p.easKmh),
  };
}

export interface GlideSample {
  t: number;
  hAglM: number;
  iasKmh: number;
  easKmh: number;
  tasKmh: number;
  sinkMs: number;
  glideRatio: number;
  pitchDeg: number;
  alphaDeg: number;
  gammaDeg: number;
  bankDeg: number;
  headingDeg: number;
}

function sample(fdm: Fdm): GlideSample {
  const sinkFps = fdm.get(P.vDownFps);
  return {
    t: fdm.simTime,
    hAglM: fdm.get(P.hAglFt) * M_PER_FT,
    iasKmh: fdm.get(P.vcKts) * KMH_PER_KT,
    easKmh: fdm.get(P.veKts) * KMH_PER_KT,
    tasKmh: fdm.get(P.vtrueKts) * KMH_PER_KT,
    sinkMs: msFromFps(sinkFps),
    glideRatio: fdm.get(P.vgFps) / sinkFps,
    pitchDeg: fdm.get(P.thetaDeg),
    alphaDeg: fdm.get(P.alphaDeg),
    gammaDeg: fdm.get(P.gammaDeg),
    bankDeg: fdm.get(P.phiDeg),
    headingDeg: (((fdm.get(P.psiDeg) % 360) + 360) % 360) % 360,
  };
}

export interface GlideResult {
  trim: GlideTrimResult;
  samples: GlideSample[];
  wallMs: number;
}

export interface GlideSummary {
  durationS: number;
  heightLostM: number;
  meanEasKmh: number;
  meanSinkMs: number;
  /** Distance over ground / height lost. */
  glideRatio: number;
  meanPitchDeg: number;
  finalBankDeg: number;
  headingChangeDeg: number;
}

export function summarizeGlide(r: GlideResult): GlideSummary {
  const s = r.samples;
  const first = s[0]!, last = s[s.length - 1]!;
  const mean = (f: (x: GlideSample) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
  // Ground distance: integrate ground speed = sink * glide ratio between samples.
  let dist = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    dist += ((a.sinkMs * a.glideRatio + b.sinkMs * b.glideRatio) / 2) * (b.t - a.t);
  }
  const lost = first.hAglM - last.hAglM;
  return {
    durationS: last.t - first.t,
    heightLostM: lost,
    meanEasKmh: mean((x) => x.easKmh),
    meanSinkMs: mean((x) => x.sinkMs),
    glideRatio: dist / lost,
    meanPitchDeg: mean((x) => x.pitchDeg),
    finalBankDeg: last.bankDeg,
    headingChangeDeg: ((last.headingDeg - first.headingDeg + 540) % 360) - 180,
  };
}

/** Trim at `easKmh`, then fly `durationS` with controls held (stick neutral, trim set). */
export function runGlide(fdm: Fdm, opts: { easKmh: number; durationS: number; sampleHz?: number; base?: InitialConditions }): GlideResult {
  const trim = trimSteadyGlide(fdm, { speed: { veKts: ktsFromKmh(opts.easKmh) }, base: opts.base ?? START });
  if (!trim.converged) throw new Error(`glide trim failed at ${opts.easKmh} km/h: ${JSON.stringify(trim)}`);
  fdm.set(P.elevatorCmd, 0);
  fdm.set(P.aileronCmd, 0);
  fdm.set(P.rudderCmd, 0);
  const every = Math.round(1 / fdm.dt / (opts.sampleHz ?? 10));
  const steps = Math.round(opts.durationS / fdm.dt);
  const samples = [sample(fdm)];
  const t0 = performance.now();
  for (let i = 1; i <= steps; i++) {
    fdm.step();
    if (i % every === 0) samples.push(sample(fdm));
  }
  return { trim, samples, wallMs: performance.now() - t0 };
}

export interface SimPolarPoint extends PolarPoint {
  targetKmh: number;
  /** EAS change over the measurement window [km/h]: ~0 means the trimmed glide holds. */
  driftKmh: number;
}

/**
 * Time-domain polar: trim at each speed, let it settle, then average sink over a
 * window. Checks that the trimmed states are actually steady in free flight.
 */
export function simulatedPolar(fdm: Fdm, speedsKmh: readonly number[], opts: { settleS?: number; measureS?: number } = {}): SimPolarPoint[] {
  const settle = Math.round((opts.settleS ?? 5) / fdm.dt);
  const measure = Math.round((opts.measureS ?? 20) / fdm.dt);
  const out: SimPolarPoint[] = [];
  for (const v of speedsKmh) {
    const trim = trimSteadyGlide(fdm, { speed: { veKts: ktsFromKmh(v) }, base: START });
    if (!trim.converged) continue;
    fdm.step(settle);
    const start = sample(fdm);
    let eas = 0, sink = 0, gr = 0, alpha = 0;
    for (let i = 0; i < measure; i++) {
      fdm.step();
      eas += fdm.get(P.veKts) * KMH_PER_KT;
      sink += msFromFps(fdm.get(P.vDownFps)) * Math.sqrt(fdm.get(P.sigma));
      gr += fdm.get(P.vgFps) / fdm.get(P.vDownFps);
      alpha += fdm.get(P.alphaDeg);
    }
    out.push({
      targetKmh: v,
      easKmh: eas / measure,
      sinkMs: sink / measure,
      glideRatio: gr / measure,
      alphaDeg: alpha / measure,
      pitchTrim: trim.control,
      driftKmh: sample(fdm).easKmh - start.easKmh,
    });
  }
  return out;
}
