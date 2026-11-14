/** Gym environments for Node: the ASK21 from the FGAddon cache, real terrain from the disk cache. */
import { AerotowTask, GliderEnv, LandingTask, type Task } from "@webflight/gym";
import { aircraftFiles, ASK21, ensureAircraft } from "./gliders.ts";
import { ASK21_AIRBRAKE } from "./soaring.ts";
import { nodeTerrain } from "./terrain.ts";

export const TASKS: Record<string, () => Task> = {
  landing: () => new LandingTask(),
  aerotow: () => new AerotowTask(),
};

export async function makeGym(task: string, opts: { decisionHz?: number; loadout?: "solo" | "dual" } = {}): Promise<GliderEnv> {
  const make = TASKS[task];
  if (!make) throw new Error(`unknown task ${task} (${Object.keys(TASKS).join(", ")})`);
  const dir = await ensureAircraft(ASK21);
  return GliderEnv.make({
    task: make(),
    aircraft: aircraftFiles(dir, ASK21),
    loadoutKg: ASK21.loadouts[opts.loadout ?? "solo"]!,
    airbrake: ASK21_AIRBRAKE,
    terrain: nodeTerrain(),
    ...(opts.decisionHz ? { decisionHz: opts.decisionHz } : {}),
  });
}
