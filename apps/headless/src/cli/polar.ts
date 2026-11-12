/** ASK21 solo speed polar: CSV + PNG in out/. */
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "@webflight/converter";
import { formatPolarSummary, polarExperiment } from "../experiment.ts";
import { plotPolar } from "../plot/polar-plot.ts";

const outDir = path.join(repoRoot(), "out");
fs.mkdirSync(outDir, { recursive: true });
const t0 = performance.now();
const r = await polarExperiment();
const csv = path.join(outDir, "ask21-solo-polar.csv");
const png = path.join(outDir, "ask21-solo-polar.png");
fs.writeFileSync(csv, r.csv);
fs.writeFileSync(png, plotPolar(r.trimmed, r.simulated, r.summary, `ASK21 JSBSim polar, solo ${r.massKg.toFixed(0)} kg, sea level ISA`));
const maxDrift = Math.max(...r.simulated.map((p) => Math.abs(p.driftKmh)));
const maxDiff = Math.max(...r.simulated.map((p, i) => Math.abs(p.sinkMs - (r.trimmed.find((q) => Math.abs(q.easKmh - p.targetKmh) < 1e-6) ?? r.trimmed[i]!).sinkMs)));
console.log(`ASK21 (ask21-jsb), solo, ${r.massKg.toFixed(0)} kg: ${r.trimmed.length} speeds, ${r.trimmed[0]!.easKmh.toFixed(1)}-${r.trimmed.at(-1)!.easKmh.toFixed(1)} km/h EAS`);
console.log(formatPolarSummary(r.summary));
console.log(`Time-domain check: max |sink(sim) - sink(trim)| = ${maxDiff.toFixed(3)} m/s, max speed drift over 20 s = ${maxDrift.toFixed(2)} km/h`);
console.log(`${(performance.now() - t0).toFixed(0)} ms. CSV: ${path.relative(repoRoot(), csv)}  PNG: ${path.relative(repoRoot(), png)}`);
