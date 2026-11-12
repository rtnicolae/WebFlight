/**
 * Collect the JSBSim files of a FlightGear JSBSim aircraft, plus defaults for the
 * FlightGear-owned ("host") properties that the JSBSim XML reads.
 *
 * Standalone JSBSim throws "Property /x does not exist" when a component reads a
 * property that FlightGear would normally create (e.g. the ASK21 maps its airbrake
 * lever to /controls/engines/engine/throttle). The host must define those first; the
 * defaults come from the aircraft's -set.xml property tree.
 */
import fs from "node:fs";
import path from "node:path";
import { getProp, propToNumber, readPropertyList } from "./proplist.ts";
import type { FgResolver } from "./resolve.ts";

export interface JsbsimFileSet {
  /** FGAddon folder name, e.g. "ASK21". */
  aircraft: string;
  /** The -set.xml this was read from. */
  setFile: string;
  /** JSBSim model name (the <aero> file name without .xml), e.g. "ask21-jsb". */
  model: string;
  /** Files relative to the JSBSim aircraft directory (the folder holding <model>.xml). */
  files: Record<string, string>;
  /** Absolute host properties referenced by the JSBSim XML, with -set.xml defaults (0 if unset). */
  hostProperties: Record<string, number>;
  warnings: string[];
}

/** Property paths used as values of JSBSim elements, e.g. <input>/controls/x</input>. */
export function findAbsolutePropertyRefs(xml: string): string[] {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const refs = new Set<string>();
  const re = />\s*-?(\/[A-Za-z_][\w\-./[\]]*)\s*</g;
  for (const m of noComments.matchAll(re)) refs.add(m[1]!);
  return [...refs].sort();
}

export function loadJsbsimFiles(aircraftDir: string, setFileName: string, resolver?: FgResolver): JsbsimFileSet {
  const aircraft = path.basename(aircraftDir);
  const warnings: string[] = [];
  const tree = readPropertyList(path.join(aircraftDir, setFileName), {
    aircraftDir,
    aircraftName: aircraft,
    warnings,
    ...(resolver ? { resolver } : {}),
  });
  const fm = getProp(tree, "/sim/flight-model");
  if (fm !== "jsb") throw new Error(`${setFileName}: flight-model is "${fm}", only "jsb" is supported`);
  const aero = getProp(tree, "/sim/aero");
  if (!aero) throw new Error(`${setFileName}: no /sim/aero`);

  const modelDir = path.join(aircraftDir, path.dirname(aero));
  const model = path.basename(aero);
  const fdmRel = `${model}.xml`;
  if (!fs.existsSync(path.join(modelDir, fdmRel))) throw new Error(`JSBSim file not found: ${aero}.xml`);

  // Follow file="..." references transitively (<system file>, <aerodynamics file>,
  // <engine file>, <thruster file>, ...). JSBSim looks in the aircraft dir, then
  // Systems/ and Engines/; names may omit ".xml".
  const rels = new Set<string>();
  const queue = [fdmRel];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (rels.has(rel)) continue;
    rels.add(rel);
    const text = fs.readFileSync(path.join(modelDir, rel), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    for (const m of text.matchAll(/\sfile="([^"]+)"/g)) {
      const ref = m[1]!;
      const found = [ref, `${ref}.xml`, `Systems/${ref}`, `Systems/${ref}.xml`, `Engines/${ref}`, `Engines/${ref}.xml`].find(
        (c) => fs.existsSync(path.join(modelDir, c)) && fs.statSync(path.join(modelDir, c)).isFile(),
      );
      if (found) queue.push(found);
      else warnings.push(`${rel}: referenced file not found: ${ref}`);
    }
  }

  const files: Record<string, string> = {};
  for (const rel of [...rels].sort()) files[rel] = fs.readFileSync(path.join(modelDir, rel), "utf8");

  const hostProperties: Record<string, number> = {};
  for (const text of Object.values(files)) {
    for (const ref of findAbsolutePropertyRefs(text)) {
      hostProperties[ref] = propToNumber(getProp(tree, ref)) ?? 0;
    }
  }
  return { aircraft, setFile: setFileName, model, files, hostProperties, warnings };
}
