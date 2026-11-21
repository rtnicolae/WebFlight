/**
 * The environment around the FDM: terrain height, horizontal wind, thermals and ridge lift,
 * turned into what JSBSim needs. As in FlightGear, the vertical air motion handed to the FDM
 * is thermal lift + ridge lift (FG: /environment/thermal-lift-fps, ridge-lift-fps), and wind
 * is "from" a heading.
 *
 * With the day's wind profile, the horizontal wind is the one at the aircraft's height, as
 * FlightGear's environment gives its FDM (layered as windLevels, over the weather model's own
 * ground), and within 10 m of the ground under it the wind slows as the surface layer does
 * (surfaceLayerFactor), which FG leaves out: the wind gradient a glider meets in the last metres
 * of an approach. Ridge lift is FG's, driven by the wind at the aircraft's height (FG: the
 * surface wind).
 *
 * Mountain waves (waves.ts), when a field has been built for the day: near the slopes the air's
 * rise over them is FG's ridge lift, so the waves come in as FG's ridge lift fades with height
 * (its own height factor): w = thermal + ridge + (1 − f_ridge)·wave, the slope's flow counted
 * once.
 *
 * With the day's air column (air.ts), the temperature, humidity and pressure at the aircraft's
 * height go to JSBSim too (its standard atmosphere otherwise).
 */
import { airColumnOf, jsbsimAir, type AirColumn, type JsbsimAir } from "./air.ts";
import { RidgeLift } from "./ridge.ts";
import type { TerrariumTerrain } from "./terrain.ts";
import { ThermalField, ThermalSky, type ThermalFieldOptions, type ThermalSkyOptions, type WindProfile } from "./thermals.ts";
import { waveAt, type WaveFieldData } from "./waves.ts";
import { surfaceLayerFactor, windAt, type Weather } from "./weather.ts";

/** The parts of the weather that make the wind profile. */
export type WindProfileData = Pick<Weather, "elevationM" | "windFromDeg" | "windKt" | "aloft" | "boundary">;

const KT_TO_FPS = 1.6878099;
const FT_TO_M = 0.3048;
const M_TO_FT = 1 / FT_TO_M;

export interface EnvironmentConfig {
  /** Surface wind. */
  windFromDeg: number;
  windKt: number;
  /** Wind aloft (FG aloft entry[2]); defaults to the surface wind. */
  aloftFromDeg?: number;
  aloftKt?: number;
  /**
   * The day's wind by height (the weather's surface, boundary and pressure-level winds): the
   * FDM flies in the wind at its height. Without it, the surface wind blows at every height.
   */
  profile?: WindProfileData;
  /** The day's temperature, humidity and pressure by height (air.ts); without it, JSBSim's standard atmosphere. */
  air?: AirColumn;
  ridgeLift?: boolean;
  thermals?: Omit<ThermalFieldOptions, "groundAt"> | false;
  /** Thermals everywhere, streamed around the aircraft (cross-country); replaces `thermals`. */
  thermalSky?: Omit<ThermalSkyOptions, "groundAt"> | false;
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
  /** Mountain-wave vertical air motion (as weighted in); undefined without a wave field there. */
  waveLiftFps: number | undefined;
  /** The horizontal wind at the aircraft (FG: /environment/wind-from-heading-deg, wind-speed-kt). */
  windFromDeg: number;
  windKt: number;
  /** The air at the aircraft for JSBSim, with the day's air column. */
  air?: JsbsimAir;
}

export class Environment {
  readonly ridge: RidgeLift | undefined;
  readonly thermals: ThermalField | ThermalSky | undefined;
  /** The mountain-wave field round the aircraft, when one has been built for the day. */
  waves: WaveFieldData | undefined;
  private lastGroundFt = 0;

  constructor(
    readonly config: EnvironmentConfig,
    readonly terrain?: TerrariumTerrain,
  ) {
    const height = (lat: number, lon: number) => terrain?.heightAt(lat, lon) ?? (terrain ? undefined : 0);
    if (config.ridgeLift ?? true) this.ridge = new RidgeLift(height);
    if (config.thermalSky) this.thermals = new ThermalSky({ ...config.thermalSky, groundAt: height });
    else if (config.thermals) this.thermals = new ThermalField({ ...config.thermals, groundAt: height });
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
    // FG drives its ridge lift with the surface wind; the weather's is the model's 10 m wind over
    // its own ground, a valley's among mountains (2 kt in the Brașov basin on 12 Nov 2026 while
    // the crests stood in 20–40 kt). With the profile, the wind at the aircraft's height drives it.
    const rw = c.profile ? windAt(c.profile, s.altFt * FT_TO_M) : { fromDeg: c.windFromDeg, kt: c.windKt };
    const ridge = this.ridge
      ? this.ridge.update(dt, { latDeg: s.latDeg, lonDeg: s.lonDeg, groundElevM: groundFt * FT_TO_M, aglM: (s.altFt - groundFt) * FT_TO_M, windFromDeg: rw.fromDeg, windKt: rw.kt })
      : 0;
    const thermal = this.thermals ? this.thermals.update(dt, s, this.wind) : 0;
    const wv = this.waves ? waveAt(this.waves, s.latDeg, s.lonDeg, s.altFt * FT_TO_M) : undefined;
    const wave = wv === undefined ? undefined : (1 - (this.ridge?.heightFactor ?? 0)) * wv * M_TO_FT;
    const here = this.windHere(s.altFt * FT_TO_M, groundFt * FT_TO_M);
    const from = (here.fromDeg * Math.PI) / 180;
    return {
      groundElevFt: ground,
      windNorthFps: -here.kt * KT_TO_FPS * Math.cos(from),
      windEastFps: -here.kt * KT_TO_FPS * Math.sin(from),
      windDownFps: -(thermal + ridge + (wave ?? 0)),
      thermalLiftFps: thermal,
      ridgeLiftFps: ridge,
      waveLiftFps: wave,
      windFromDeg: here.fromDeg,
      windKt: here.kt,
      ...(c.air ? { air: jsbsimAir(c.air, s.altFt * FT_TO_M) } : {}),
    };
  }

  /**
   * The weather now (weather over time, weatherAt): the wind by height the aircraft flies in
   * and the thermal sky follow it. winds: false keeps the winds as they are (a wind set by hand).
   */
  setWeather(w: Weather, opts: { winds?: boolean } = {}): void {
    const c = this.config;
    if (opts.winds !== false) {
      c.windFromDeg = w.windFromDeg;
      c.windKt = w.windKt;
      const aloft = w.aloft[0];
      if (aloft) {
        c.aloftFromDeg = aloft.fromDeg;
        c.aloftKt = aloft.kt;
      }
      if (c.profile) c.profile = { elevationM: w.elevationM, windFromDeg: w.windFromDeg, windKt: w.windKt, aloft: w.aloft, ...(w.boundary ? { boundary: w.boundary } : {}) };
    }
    // The air follows the weather wherever it was given (not a wind set by hand: that is wind only).
    if (c.air) c.air = airColumnOf(w);
    if (this.thermals instanceof ThermalSky) this.thermals.setWeather(w);
  }

  /** The wind at a height [m] over a ground height [m]. */
  windHere(altM: number, groundM: number): { fromDeg: number; kt: number } {
    const c = this.config, p = c.profile;
    if (!p) return { fromDeg: c.windFromDeg, kt: c.windKt };
    const w = windAt(p, altM);
    return { fromDeg: w.fromDeg, kt: w.kt * surfaceLayerFactor(altM - groundM) };
  }
}
