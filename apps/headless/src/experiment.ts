/** Milestone 1 experiment drivers shared by the CLIs and the tests. */
import { ASK21, createGlider, type GliderProfile } from "./gliders.ts";
import { runGlide, simulatedPolar, summarizeGlide, summarizePolar, trimmedPolar, type GlideResult, type GlideSummary, type PolarPoint, type PolarSummary, type SimPolarPoint } from "./glide.ts";
import { toCsv } from "./csv.ts";

export interface GlideExperiment {
  massKg: number;
  polar: PolarSummary;
  glide: GlideResult;
  summary: GlideSummary;
  csv: string;
}

/** 120 s straight glide from 1000 m AGL at the best-glide speed (found by trimming). */
export async function glideExperiment(opts: { profile?: GliderProfile; loadout?: string; durationS?: number } = {}): Promise<GlideExperiment> {
  const { fdm, massKg } = await createGlider(opts.profile ?? ASK21, opts.loadout ?? "solo");
  try {
    const polar = summarizePolar(trimmedPolar(fdm, { stepKmh: 1 }));
    const glide = runGlide(fdm, { easKmh: polar.bestGlide.easKmh, durationS: opts.durationS ?? 120 });
    const csv = toCsv(glide.samples, {
      t_s: (r) => r.t,
      h_agl_m: (r) => r.hAglM,
      ias_kmh: (r) => r.iasKmh,
      eas_kmh: (r) => r.easKmh,
      tas_kmh: (r) => r.tasKmh,
      sink_ms: (r) => r.sinkMs,
      glide_ratio: (r) => r.glideRatio,
      pitch_deg: (r) => r.pitchDeg,
      alpha_deg: (r) => r.alphaDeg,
      gamma_deg: (r) => r.gammaDeg,
      bank_deg: (r) => r.bankDeg,
      heading_deg: (r) => r.headingDeg,
    });
    return { massKg, polar, glide, summary: summarizeGlide(glide), csv };
  } finally {
    fdm.destroy();
  }
}

export interface PolarExperiment {
  massKg: number;
  trimmed: PolarPoint[];
  simulated: SimPolarPoint[];
  summary: PolarSummary;
  csv: string;
}

/** Speed polar across the flying range: trimmed steady states plus a time-domain check at each speed. */
export async function polarExperiment(opts: { profile?: GliderProfile; loadout?: string; stepKmh?: number; maxKmh?: number } = {}): Promise<PolarExperiment> {
  const { fdm, massKg } = await createGlider(opts.profile ?? ASK21, opts.loadout ?? "solo");
  try {
    const trimmed = trimmedPolar(fdm, { stepKmh: opts.stepKmh ?? 1, maxKmh: opts.maxKmh ?? 200 });
    // Time-domain check every 5 km/h across the trimmed range.
    const simulated = simulatedPolar(fdm, trimmed.map((p) => p.easKmh).filter((v) => Math.abs(v / 5 - Math.round(v / 5)) < 1e-6));
    const sim = new Map(simulated.map((p) => [p.targetKmh.toFixed(2), p]));
    const csv = toCsv(trimmed, {
      eas_kmh: (r) => r.easKmh,
      sink_ms: (r) => r.sinkMs,
      glide_ratio: (r) => r.glideRatio,
      alpha_deg: (r) => r.alphaDeg,
      pitch_trim_norm: (r) => r.pitchTrim,
      sim_eas_kmh: (r) => sim.get(r.easKmh.toFixed(2))?.easKmh ?? NaN,
      sim_sink_ms: (r) => sim.get(r.easKmh.toFixed(2))?.sinkMs ?? NaN,
      sim_glide_ratio: (r) => sim.get(r.easKmh.toFixed(2))?.glideRatio ?? NaN,
      sim_drift_kmh: (r) => sim.get(r.easKmh.toFixed(2))?.driftKmh ?? NaN,
    });
    return { massKg, trimmed, simulated, summary: summarizePolar(trimmed), csv };
  } finally {
    fdm.destroy();
  }
}

export function formatPolarSummary(s: PolarSummary): string {
  return [
    `  best L/D   ${s.bestGlide.glideRatio.toFixed(1)} at ${s.bestGlide.easKmh.toFixed(1)} km/h EAS (sink ${s.bestGlide.sinkMs.toFixed(2)} m/s)`,
    `  min sink   ${s.minSink.sinkMs.toFixed(2)} m/s at ${s.minSink.easKmh.toFixed(1)} km/h EAS (L/D ${s.minSink.glideRatio.toFixed(1)})`,
    `  min speed  ${s.minSpeed.easKmh.toFixed(1)} km/h EAS (lowest speed with a steady trim)`,
  ].join("\n");
}
