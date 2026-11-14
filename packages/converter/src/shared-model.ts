/**
 * A standalone FGData model (e.g. the AI tow plane AI/Aircraft/DR400/Models/dr400-ai.xml)
 * converted to glTF with its animation manifest, for things the renderer draws that aren't
 * the user's aircraft. Files are fetched on demand into the FGData cache: the model XML,
 * then whatever it references relative to itself (<path>, .ac textures), then FG_ROOT paths
 * reported missing by the resolver, until nothing is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { defaultFgdataDir, fetchFgdataFiles } from "./fgdata.ts";
import { convertFgModel } from "./fgmodel.ts";
import { buildGlb } from "./glb.ts";
import { FgResolver } from "./resolve.ts";

export interface SharedModelManifest {
  format: 1;
  /** FG_ROOT path of the model XML. */
  source: string;
  model: { file: string; animations: unknown[]; properties: string[]; parents: Record<string, string> };
  license: string;
  stats: { triangles: number; glbBytes: number };
  warnings: string[];
}

/** Relative files a model XML or .ac file references. */
function relativeRefs(file: string): string[] {
  const text = fs.readFileSync(file, "latin1");
  const refs = new Set<string>();
  if (file.endsWith(".ac")) for (const m of text.matchAll(/^texture\s+"([^"]+)"/gm)) refs.add(m[1]!);
  else for (const m of text.matchAll(/<(?:path|texture)>\s*([^<]+?)\s*<\/(?:path|texture)>/g)) refs.add(m[1]!);
  return [...refs].filter((r) => !/^(Aircraft|Models|Textures|Effects|AI)\//.test(r));
}

export async function buildSharedModel(fgPath: string, outDir: string, opts: { fgdataDir?: string; log?: (m: string) => void } = {}): Promise<SharedModelManifest> {
  const fgdata = opts.fgdataDir ?? defaultFgdataDir();
  const dirRel = path.posix.dirname(fgPath);
  // Model XML and its relative references (transitively).
  let todo = [fgPath];
  const seen = new Set<string>();
  while (todo.length) {
    await fetchFgdataFiles(todo, fgdata, opts.log);
    const next: string[] = [];
    for (const rel of todo) {
      seen.add(rel);
      const abs = path.join(fgdata, rel);
      if (!fs.existsSync(abs) || !/\.(xml|ac)$/i.test(rel)) continue;
      for (const r of relativeRefs(abs)) {
        const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), r));
        if (!seen.has(p)) next.push(p);
      }
    }
    todo = [...new Set(next)];
  }
  // Convert until no FG_ROOT file is missing.
  const modelDir = path.join(fgdata, dirRel);
  for (let round = 0; ; round++) {
    const resolver = new FgResolver(modelDir, path.basename(modelDir), fgdata);
    const model = convertFgModel(modelDir, path.join(fgdata, fgPath), resolver);
    const missing = [...resolver.missing];
    if (missing.length && round < 5) {
      const r = await fetchFgdataFiles(missing, fgdata, opts.log);
      if (r.fetched.length) continue;
    }
    fs.mkdirSync(outDir, { recursive: true });
    const glb = buildGlb(model.nodes, model.roots, model.materials, model.images);
    fs.writeFileSync(path.join(outDir, "model.glb"), glb);
    const manifest: SharedModelManifest = {
      format: 1,
      source: fgPath,
      model: { file: "model.glb", animations: model.animations, properties: model.properties, parents: model.parents },
      license: "FGData (https://gitlab.com/flightgear/fgdata), GPL-2.0-or-later",
      stats: { triangles: model.stats.triangles, glbBytes: glb.byteLength },
      warnings: [...model.warnings, ...missing.map((m) => `missing: ${m}`)],
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
    return manifest;
  }
}
