/**
 * Web bundle for one FlightGear JSBSim aircraft:
 *   <out>/<Aircraft>/manifest.json
 *   <out>/<Aircraft>/jsbsim/...      JSBSim XML, unchanged
 *   <out>/<Aircraft>/model.glb       AC3D model(s) as glTF
 *   <out>/<Aircraft>/COPYING         the aircraft's license text
 */
import fs from "node:fs";
import path from "node:path";
import { buildGlb } from "./glb.ts";
import { convertFgModel, type AnimationEntry } from "./fgmodel.ts";
import { loadJsbsimFiles } from "./jsbsim-files.ts";
import { getProp, readPropertyList } from "./proplist.ts";

/** How the generic "airbrake lever" input reaches the aircraft (FG property, 0..1 = closed..open). */
export interface InputProfile {
  airbrake: { property: string; invert: boolean };
}

/**
 * Per-aircraft input quirks. Default: FlightGear's /controls/flight/speedbrake, which the
 * FG JSBSim interface copies to fcs/speedbrake-cmd-norm.
 */
const INPUT_PROFILES: Record<string, InputProfile> = {
  // ASK21 maps the airbrake lever to the throttle, inverted (ask21-fcs.xml).
  "ASK21/ask21-jsb-set.xml": { airbrake: { property: "/controls/engines/engine/throttle", invert: true } },
};
const DEFAULT_INPUT: InputProfile = { airbrake: { property: "/controls/flight/speedbrake", invert: false } };

export interface BundleManifest {
  format: 1;
  aircraft: string;
  setFile: string;
  description: string | undefined;
  license: { file: string | undefined; note: string };
  fdm: { model: string; files: string[]; hostProperties: Record<string, number> };
  model: {
    file: string;
    animations: AnimationEntry[];
    /** Defaults for every property animations read (from the -set.xml tree; null = unset). */
    properties: Record<string, number | string | null>;
  };
  input: InputProfile;
  stats: { objects: number; triangles: number; models: number; glbBytes: number; skippedAnimations: Record<string, number> };
  warnings: string[];
}

export function buildBundle(aircraftDir: string, setFile: string, outRoot: string): BundleManifest {
  const aircraft = path.basename(aircraftDir);
  const out = path.join(outRoot, aircraft);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const fdm = loadJsbsimFiles(aircraftDir, setFile);
  for (const [rel, text] of Object.entries(fdm.files)) {
    const dst = path.join(out, "jsbsim", rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
  }

  const warnings = [...fdm.warnings];
  const tree = readPropertyList(path.join(aircraftDir, setFile), { aircraftDir, aircraftName: aircraft, warnings: [] });
  const modelPath = getProp(tree, "/sim/model/path");
  if (!modelPath) throw new Error(`${setFile}: no /sim/model/path`);
  const prefix = `Aircraft/${aircraft}/`;
  const modelFile = path.join(aircraftDir, modelPath.startsWith(prefix) ? modelPath.slice(prefix.length) : modelPath);
  const model = convertFgModel(aircraftDir, modelFile);
  warnings.push(...model.warnings);
  const glb = buildGlb(model.nodes, model.roots, model.materials, model.images);
  fs.writeFileSync(path.join(out, "model.glb"), glb);

  const properties: Record<string, number | string | null> = {};
  for (const p of model.properties) {
    const v = getProp(tree, p);
    properties[p] = v === undefined ? null : v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v.trim() === "true" ? 1 : v.trim() === "false" ? 0 : v;
  }

  const copying = ["COPYING", "LICENSE", "LICENSE.txt", "COPYING.txt"].find((f) => fs.existsSync(path.join(aircraftDir, f)));
  if (copying) fs.copyFileSync(path.join(aircraftDir, copying), path.join(out, "COPYING"));
  else warnings.push("no COPYING/LICENSE file in the aircraft folder");

  const manifest: BundleManifest = {
    format: 1,
    aircraft,
    setFile,
    description: getProp(tree, "/sim/description"),
    license: { file: copying ? "COPYING" : undefined, note: "Aircraft files from FGAddon; see COPYING. Most FGAddon aircraft are GPL." },
    fdm: { model: fdm.model, files: Object.keys(fdm.files), hostProperties: fdm.hostProperties },
    model: { file: "model.glb", animations: model.animations, properties },
    input: INPUT_PROFILES[`${aircraft}/${setFile}`] ?? DEFAULT_INPUT,
    stats: { ...model.stats, glbBytes: glb.byteLength },
    warnings,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}
