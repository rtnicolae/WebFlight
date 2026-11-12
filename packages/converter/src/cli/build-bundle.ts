/**
 * Usage: build-bundle <AircraftFolder> <set-file> [--out <dir>]
 * Fetches the aircraft into the FGAddon cache if needed. Default out: apps/web/bundles
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildBundle } from "../bundle.ts";
import { fetchAircraft } from "../fgaddon.ts";
import { defaultCacheDir, repoRoot } from "../paths.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
const [aircraft, setFile] = positionals;
if (!aircraft || !setFile) {
  console.error("usage: build-bundle <AircraftFolder> <set-file> [--out <dir>]");
  process.exit(2);
}
const cache = defaultCacheDir();
const dir = path.join(cache, aircraft);
if (!fs.existsSync(path.join(dir, setFile))) await fetchAircraft(aircraft, { dest: cache, log: console.log });
const out = path.resolve(values.out ?? path.join(repoRoot(), "apps/web/bundles"));
const t0 = performance.now();
const m = buildBundle(dir, setFile, out);
console.log(`${m.aircraft}/${m.setFile} → ${path.relative(repoRoot(), path.join(out, m.aircraft))} in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`  FDM ${m.fdm.model}: ${m.fdm.files.length} files; host properties ${Object.keys(m.fdm.hostProperties).length}`);
console.log(`  model: ${m.stats.models} model files, ${m.stats.objects} objects, ${m.stats.triangles} triangles, ${(m.stats.glbBytes / 1e6).toFixed(2)} MB glb`);
const byType = m.model.animations.reduce<Record<string, number>>((a, x) => ((a[x.type] = (a[x.type] ?? 0) + 1), a), {});
console.log(`  animations: ${JSON.stringify(byType)}; skipped ${JSON.stringify(m.stats.skippedAnimations)}`);
console.log(`  warnings: ${m.warnings.length}`);
for (const w of m.warnings) console.log(`    - ${w}`);
