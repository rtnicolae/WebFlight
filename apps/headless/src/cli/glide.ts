/** ASK21 solo: 120 s glide from 1000 m AGL at best-glide speed, neutral controls. */
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "@webflight/converter";
import { formatPolarSummary, glideExperiment } from "../experiment.ts";

const outDir = path.join(repoRoot(), "out");
fs.mkdirSync(outDir, { recursive: true });
const t0 = performance.now();
const r = await glideExperiment();
const file = path.join(outDir, "ask21-solo-glide.csv");
fs.writeFileSync(file, r.csv);
const s = r.summary;
console.log(`ASK21 (ask21-jsb), solo, ${r.massKg.toFixed(0)} kg, ISA, still air, 120 Hz`);
console.log(`Trim: pitch-trim ${r.glide.trim.control.toFixed(3)}, alpha ${r.glide.trim.alphaDeg.toFixed(2)} deg, ${r.glide.trim.iterations} Newton iterations`);
console.log(`Glide ${s.durationS.toFixed(0)} s from 1000 m AGL at ${r.polar.bestGlide.easKmh.toFixed(1)} km/h EAS, stick neutral:`);
console.log(`  height lost   ${s.heightLostM.toFixed(1)} m`);
console.log(`  mean EAS      ${s.meanEasKmh.toFixed(1)} km/h`);
console.log(`  mean sink     ${s.meanSinkMs.toFixed(3)} m/s (at altitude, true)`);
console.log(`  glide ratio   ${s.glideRatio.toFixed(1)} (ground distance / height lost)`);
console.log(`  mean pitch    ${s.meanPitchDeg.toFixed(2)} deg`);
console.log(`  final bank    ${s.finalBankDeg.toFixed(1)} deg, heading change ${s.headingChangeDeg.toFixed(1)} deg (spiral mode)`);
console.log(`Polar (trimmed, sea-level equivalent):\n${formatPolarSummary(r.polar)}`);
console.log(`Simulated 120 s in ${r.glide.wallMs.toFixed(0)} ms; total ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`CSV: ${path.relative(repoRoot(), file)}`);
