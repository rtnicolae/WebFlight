/**
 * Gym environments for Node: the ASK21 from the FGAddon cache, real terrain from the disk
 * cache, airfields and weather from data (random sites by default; recorded weather
 * snapshots from packages/gym/data/weather-snapshots.json when present).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Weather } from "@webflight/environment";
import { AerotowTask, dataSites, GliderEnv, LandingTask, loadGymAirfields, type SitePicker, type Task } from "@webflight/gym";
import { aircraftFiles, ASK21, ensureAircraft } from "./gliders.ts";
import { ASK21_AIRBRAKE } from "./soaring.ts";
import { nodeTerrain } from "./terrain.ts";

export const TASKS: Record<string, () => Task> = {
  landing: () => new LandingTask(),
  aerotow: () => new AerotowTask(),
};

export const WEATHER_SNAPSHOTS = new URL("../../../packages/gym/data/weather-snapshots.json", import.meta.url);

/** Random airfields from the data, with the recorded weather snapshots if any. */
export async function defaultSites(): Promise<SitePicker> {
  const snapshots = existsSync(WEATHER_SNAPSHOTS) ? (JSON.parse(readFileSync(WEATHER_SNAPSHOTS, "utf8")) as { snapshots: { ident: string; weather: Weather }[] }).snapshots : [];
  return dataSites(await loadGymAirfields(), snapshots);
}

export async function makeGym(task: string, opts: { decisionHz?: number; loadout?: "solo" | "dual"; sites?: SitePicker; thermals?: boolean } = {}): Promise<GliderEnv> {
  const make = TASKS[task];
  if (!make) throw new Error(`unknown task ${task} (${Object.keys(TASKS).join(", ")})`);
  const dir = await ensureAircraft(ASK21);
  return GliderEnv.make({
    task: make(),
    sites: opts.sites ?? (await defaultSites()),
    aircraft: aircraftFiles(dir, ASK21),
    loadoutKg: ASK21.loadouts[opts.loadout ?? "solo"]!,
    airbrake: ASK21_AIRBRAKE,
    terrain: nodeTerrain(),
    ...(opts.decisionHz ? { decisionHz: opts.decisionHz } : {}),
    ...(opts.thermals !== undefined ? { thermals: opts.thermals } : {}),
  });
}
