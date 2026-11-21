/**
 * Couple an Environment to a JSBSim instance (fdm-core Fdm or anything with get/set):
 * terrain under the aircraft into position/terrain-elevation-asl-ft, and wind plus vertical
 * air motion into atmosphere/wind-{north,east,down}-fps, and the day's air (air.ts) into its
 * atmosphere. Call once per step batch.
 */
import { jsbsimAir, type JsbsimAir } from "./air.ts";
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
  if (o.air) setAir(fdm, o.air);
  return o;
}

/**
 * The day's air into JSBSim (air.ts): temperature bias and sea-level pressure first, then the
 * dew point (JSBSim turns it into a vapour fraction at the pressure it has then).
 */
function setAir(fdm: FdmLike, a: JsbsimAir): void {
  fdm.set("atmosphere/delta-T", a.deltaTR);
  fdm.set("atmosphere/P-sl-psf", a.pSlPsf);
  fdm.set("atmosphere/dew-point-R", a.dewPointR);
}

/**
 * The day's air at a height [m] without stepping the environment: before a start's trim and
 * RunIC, which turn its airspeed into a true one through the density there. Nothing without an
 * air column.
 */
export function applyAir(env: Environment, fdm: FdmLike, altM: number): JsbsimAir | undefined {
  const c = env.config.air;
  if (!c) return undefined;
  const a = jsbsimAir(c, altM);
  setAir(fdm, a);
  return a;
}
