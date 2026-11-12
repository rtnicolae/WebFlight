import fs from "node:fs";
import path from "node:path";
import { defaultCacheDir, fetchAircraft, loadJsbsimFiles } from "@webflight/converter";
import { Fdm, LBS_PER_KG, P, type AircraftFiles, type FdmOptions } from "@webflight/fdm-core";

export interface GliderProfile {
  /** FGAddon folder. */
  folder: string;
  setFile: string;
  /** Named loadouts: pointmass index -> kg. */
  loadouts: Record<string, Record<number, number>>;
}

/** ASK21 pointmasses in ask21-jsb.xml: 0 Pilot (80 kg), 1 Copilot (80 kg), 2 Spin Ballast (0). */
export const ASK21: GliderProfile = {
  folder: "ASK21",
  setFile: "ask21-jsb-set.xml",
  loadouts: {
    solo: { 0: 80, 1: 0, 2: 0 },
    dual: { 0: 80, 1: 80, 2: 0 },
  },
};

/** Make sure the aircraft is in the local FGAddon cache, downloading it if needed. */
export async function ensureAircraft(profile: GliderProfile, log?: (m: string) => void): Promise<string> {
  const cache = defaultCacheDir();
  const dir = path.join(cache, profile.folder);
  if (!fs.existsSync(path.join(dir, profile.setFile))) {
    log?.(`${profile.folder} not in ${cache}; fetching from FGAddon...`);
    await fetchAircraft(profile.folder, { dest: cache, ...(log ? { log } : {}) });
  }
  return dir;
}

export function aircraftFiles(dir: string, profile: GliderProfile): AircraftFiles {
  const set = loadJsbsimFiles(dir, profile.setFile);
  return { aircraft: set.aircraft, model: set.model, files: set.files, hostProperties: set.hostProperties };
}

export async function createGlider(
  profile: GliderProfile,
  loadout: string,
  opts: FdmOptions = {},
): Promise<{ fdm: Fdm; massKg: number }> {
  const dir = await ensureAircraft(profile);
  const fdm = await Fdm.create(opts);
  fdm.load(aircraftFiles(dir, profile));
  const lo = profile.loadouts[loadout];
  if (!lo) throw new Error(`unknown loadout ${loadout}`);
  for (const [i, kg] of Object.entries(lo)) fdm.set(P.pointmassWeightLbs(Number(i)), kg * LBS_PER_KG);
  fdm.runIc(); // refresh mass properties
  return { fdm, massKg: fdm.get(P.weightLbs) / LBS_PER_KG };
}
