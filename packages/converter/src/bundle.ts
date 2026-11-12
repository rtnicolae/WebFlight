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
import { getProp, readPropertyList, toPNode, type PNodeJson, type PropNode } from "./proplist.ts";
import { FgResolver } from "./resolve.ts";

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
  /** fg-host configuration file in the bundle. */
  host?: string;
  /** Cockpit eye point in glTF/AC axes [m] and default view pitch, from /sim/view/config. */
  views: { cockpit: { eye: [number, number, number]; pitchDeg: number; fovDeg: number } };
  stats: { objects: number; triangles: number; models: number; glbBytes: number; skippedAnimations: Record<string, number> };
  warnings: string[];
}

const num = (v: string | undefined): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 0);

export interface BuildOptions {
  /** FGData cache for shared files (Aircraft/Generic, Instruments-3d, ...). */
  fgdataDir?: string;
}

export function buildBundle(aircraftDir: string, setFile: string, outRoot: string, opts: BuildOptions = {}): BundleManifest & { missingShared: string[] } {
  const aircraft = path.basename(aircraftDir);
  const resolver = new FgResolver(aircraftDir, aircraft, opts.fgdataDir);
  const out = path.join(outRoot, aircraft);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const fdm = loadJsbsimFiles(aircraftDir, setFile, resolver);
  for (const [rel, text] of Object.entries(fdm.files)) {
    const dst = path.join(out, "jsbsim", rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
  }

  const warnings = [...fdm.warnings];
  const tree = readPropertyList(path.join(aircraftDir, setFile), { aircraftDir, aircraftName: aircraft, warnings: [], resolver });
  const modelPath = getProp(tree, "/sim/model/path");
  if (!modelPath) throw new Error(`${setFile}: no /sim/model/path`);
  const prefix = `Aircraft/${aircraft}/`;
  const modelFile = path.join(aircraftDir, modelPath.startsWith(prefix) ? modelPath.slice(prefix.length) : modelPath);
  const model = convertFgModel(aircraftDir, modelFile, resolver);
  warnings.push(...model.warnings);
  const glb = buildGlb(model.nodes, model.roots, model.materials, model.images);
  fs.writeFileSync(path.join(out, "model.glb"), glb);

  // FG divides gear compression by /gear/gear[n]/max-compression-ft|m (JSBSim.cxx update_gear).
  const props = new Set(model.properties);
  for (const p of model.properties) {
    const g = /^(\/gear\/gear(?:\[\d+\])?)\/compression-norm$/.exec(p);
    if (g) {
      props.add(`${g[1]}/max-compression-ft`);
      props.add(`${g[1]}/max-compression-m`);
    }
  }
  const properties: Record<string, number | string | null> = {};
  for (const p of [...props].sort()) {
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
    views: {
      cockpit: {
        // FG view offsets: x right, y up, z aft → AC axes (x aft, y up, z left).
        eye: [num(getProp(tree, "/sim/view/config/z-offset-m")), num(getProp(tree, "/sim/view/config/y-offset-m")), -num(getProp(tree, "/sim/view/config/x-offset-m"))],
        pitchDeg: num(getProp(tree, "/sim/view/config/pitch-offset-deg")),
        fovDeg: num(getProp(tree, "/sim/view/config/default-field-of-view-deg")) || 55,
      },
    },
    stats: { ...model.stats, glbBytes: glb.byteLength },
    warnings,
  };
  // Host configuration for fg-host (property tree defaults, property rules, instruments).
  const host = buildHostConfig(aircraftDir, aircraft, setFile, tree, resolver, fdm.files, warnings);
  fs.writeFileSync(path.join(out, "host.json"), JSON.stringify(host));
  manifest.host = "host.json";
  if (resolver.sharedUsed.size > 0) manifest.license.note += " Shared parts come from FGData (GPL-2.0-or-later).";
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  return { ...manifest, missingShared: [...resolver.missing].sort() };
}

/** Subtrees of the -set.xml that the runtime never needs. */
const SKIP_TREE = [/^\/nasal\b/, /^\/input\b/, /^\/sim\/(help|checklists|tutorials|gui|previews|tags|long-description)\b/];

function readConfigFile(ref: string | undefined, aircraftDir: string, aircraft: string, resolver: FgResolver, warnings: string[]): PNodeJson | undefined {
  if (!ref?.trim()) return undefined;
  const file = resolver.resolve(ref.trim(), aircraftDir);
  if (!file) {
    warnings.push(`config file not found: ${ref.trim()}`);
    return undefined;
  }
  return toPNode(readPropertyList(file, { aircraftDir, aircraftName: aircraft, warnings, resolver }));
}

export interface HostConfigJson {
  aircraft: string;
  setFile: string;
  tree: PNodeJson;
  propertyRules: { name: string; file: string; root: PNodeJson }[];
  instrumentation?: PNodeJson;
  systems?: PNodeJson;
  gearCount: number;
  nasal: { module: string; files: string[] }[];
}

function buildHostConfig(aircraftDir: string, aircraft: string, setFile: string, tree: PropNode, resolver: FgResolver, fdmFiles: Record<string, string>, warnings: string[]): HostConfigJson {
  const rules: HostConfigJson["propertyRules"] = [];
  const systemsNode = tree.children.get("sim[0]")?.children.get("systems[0]");
  for (const kind of ["property-rule", "autopilot"]) {
    const entries = [...(systemsNode?.children ?? [])].filter(([k]) => k.startsWith(`${kind}[`)).sort((a, b) => Number(/\[(\d+)\]/.exec(a[0])![1]) - Number(/\[(\d+)\]/.exec(b[0])![1]));
    for (const [, n] of entries) {
      const file = n.children.get("path[0]")?.value?.trim();
      const root = readConfigFile(file, aircraftDir, aircraft, resolver, warnings);
      if (root && file) rules.push({ name: n.children.get("name[0]")?.value?.trim() ?? kind, file, root });
    }
  }
  const instrumentation = readConfigFile(getProp(tree, "/sim/instrumentation/path"), aircraftDir, aircraft, resolver, warnings);
  const systems = readConfigFile(getProp(tree, "/sim/systems/path"), aircraftDir, aircraft, resolver, warnings);
  const nasal = [...(tree.children.get("nasal[0]")?.children ?? [])].map(([key, mod]) => ({
    module: key.replace(/\[\d+\]$/, ""),
    files: [...mod.children].filter(([k]) => k.startsWith("file[")).map(([, f]) => (f.value ?? "").trim().replace(/^\/+/, "")),
  }));
  const gearCount = Object.values(fdmFiles).reduce((n, t) => n + (t.replace(/<!--[\s\S]*?-->/g, "").match(/<contact[\s>]/g)?.length ?? 0), 0);
  return {
    aircraft,
    setFile,
    tree: toPNode(tree, "PropertyList", 0, (p) => SKIP_TREE.some((re) => re.test(p))),
    propertyRules: rules,
    ...(instrumentation ? { instrumentation } : {}),
    ...(systems ? { systems } : {}),
    gearCount,
    nasal,
  };
}
