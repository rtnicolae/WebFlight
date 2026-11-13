/**
 * Couple an Environment to a JSBSim instance (fdm-core Fdm or anything with get/set):
 * terrain under the aircraft into position/terrain-elevation-asl-ft, and wind plus vertical
 * air motion into atmosphere/wind-{north,east,down}-fps. Call once per step batch.
 */
import type { Environment, EnvironmentOutput } from "./environment.ts";

export interface FdmLike {
  get(property: string): number;
  set(property: string, value: number): void;
}

export function applyEnvironment(env: Environment, fdm: FdmLike, dt: number): EnvironmentOutput {
  const o = env.update(dt, {
    latDeg: fdm.get("position/lat-geod-deg"),
    lonDeg: fdm.get("position/long-gc-deg"),
    altFt: fdm.get("position/geod-alt-ft"),
  });
  if (o.groundElevFt !== undefined) fdm.set("position/terrain-elevation-asl-ft", o.groundElevFt);
  fdm.set("atmosphere/wind-north-fps", o.windNorthFps);
  fdm.set("atmosphere/wind-east-fps", o.windEastFps);
  fdm.set("atmosphere/wind-down-fps", o.windDownFps);
  return o;
}
