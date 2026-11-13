/**
 * The environment around the FDM: terrain height, horizontal wind, thermals and ridge lift,
 * turned into what JSBSim needs. As in FlightGear, the vertical air motion handed to the FDM
 * is thermal lift + ridge lift (FG: /environment/thermal-lift-fps, ridge-lift-fps), and wind
 * is "from" a heading.
 */
import { RidgeLift } from "./ridge.ts";
import type { TerrariumTerrain } from "./terrain.ts";
import { ThermalField, type ThermalFieldOptions, type WindProfile } from "./thermals.ts";

const KT_TO_FPS = 1.6878099;
const FT_TO_M = 0.3048;

export interface EnvironmentConfig {
  /** Surface wind. */
  windFromDeg: number;
  windKt: number;
  /** Wind aloft (FG aloft entry[2]); defaults to the surface wind. */
  aloftFromDeg?: number;
  aloftKt?: number;
  ridgeLift?: boolean;
  thermals?: Omit<ThermalFieldOptions, "groundAt"> | false;
}

export interface AircraftState {
  latDeg: number;
  lonDeg: number;
  /** [ft], above the ellipsoid = terrain datum. */
  altFt: number;
}

export interface EnvironmentOutput {
  /** Ground under the aircraft [ft], or undefined while terrain loads. */
  groundElevFt: number | undefined;
  /** JSBSim atmosphere/wind-north|east|down-fps (air velocity, NED). */
  windNorthFps: number;
  windEastFps: number;
  windDownFps: number;
  thermalLiftFps: number;
  ridgeLiftFps: number;
}

export class Environment {
  readonly ridge: RidgeLift | undefined;
  readonly thermals: ThermalField | undefined;
  private lastGroundFt = 0;

  constructor(
    readonly config: EnvironmentConfig,
    readonly terrain?: TerrariumTerrain,
  ) {
    const height = (lat: number, lon: number) => terrain?.heightAt(lat, lon) ?? (terrain ? undefined : 0);
    if (config.ridgeLift ?? true) this.ridge = new RidgeLift(height);
    if (config.thermals) this.thermals = new ThermalField({ ...config.thermals, groundAt: height });
  }

  get wind(): WindProfile {
    const c = this.config;
    return { groundFromDeg: c.windFromDeg, groundKt: c.windKt, aloftFromDeg: c.aloftFromDeg ?? c.windFromDeg, aloftKt: c.aloftKt ?? c.windKt };
  }

  groundElevFt(latDeg: number, lonDeg: number): number | undefined {
    if (!this.terrain) return 0;
    const h = this.terrain.heightAt(latDeg, lonDeg);
    return h === undefined ? undefined : h / FT_TO_M;
  }

  update(dt: number, s: AircraftState): EnvironmentOutput {
    const ground = this.groundElevFt(s.latDeg, s.lonDeg);
    if (ground !== undefined) this.lastGroundFt = ground;
    const groundFt = ground ?? this.lastGroundFt;
    const c = this.config;
    const ridge = this.ridge
      ? this.ridge.update(dt, { latDeg: s.latDeg, lonDeg: s.lonDeg, groundElevM: groundFt * FT_TO_M, aglM: (s.altFt - groundFt) * FT_TO_M, windFromDeg: c.windFromDeg, windKt: c.windKt })
      : 0;
    const thermal = this.thermals ? this.thermals.update(dt, s, this.wind) : 0;
    const from = (c.windFromDeg * Math.PI) / 180;
    return {
      groundElevFt: ground,
      windNorthFps: -c.windKt * KT_TO_FPS * Math.cos(from),
      windEastFps: -c.windKt * KT_TO_FPS * Math.sin(from),
      windDownFps: -(thermal + ridge),
      thermalLiftFps: thermal,
      ridgeLiftFps: ridge,
    };
  }
}
