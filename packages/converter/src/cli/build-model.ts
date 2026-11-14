/**
 * Usage: build-model <FG_ROOT path of a model XML> <name> [--out <dir>]
 * e.g. build-model AI/Aircraft/DR400/Models/dr400-ai.xml dr400 → apps/web/bundles/_models/dr400
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { repoRoot } from "../paths.ts";
import { buildSharedModel } from "../shared-model.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
const [fgPath, name] = positionals;
if (!fgPath || !name) {
  console.error("usage: build-model <FG_ROOT model xml> <name> [--out <dir>]");
  process.exit(2);
}
const out = path.resolve(values.out ?? path.join(repoRoot(), "apps/web/bundles/_models", name));
const m = await buildSharedModel(fgPath, out, { log: console.log });
console.log(`${fgPath} → ${path.relative(repoRoot(), out)}: ${m.stats.triangles} triangles, ${(m.stats.glbBytes / 1e6).toFixed(2)} MB, ${m.model.animations.length} animations`);
for (const w of m.warnings) console.log(`  - ${w}`);
