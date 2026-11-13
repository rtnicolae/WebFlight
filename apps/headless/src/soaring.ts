/**
 * Soaring scenarios in Node: the glider over real terrain with wind, ridge lift and
 * thermals (same Environment as the browser worker), plus a small autopilot that holds a
 * heading or a bank angle and an airspeed. Used by tests and as a baseline for training.
 */
import { applyEnvironment, Environment, type EnvironmentConfig, type EnvironmentOutput, type TerrariumTerrain } from "@webflight/environment";
import { controlsToJsbsim, FT_PER_M, KMH_PER_KT, M_PER_FT, P, trimSteadyGlide, type AirbrakeRoute, type Fdm, type FgControls } from "@webflight/fdm-core";
import { ASK21, createGlider, type GliderProfile } from "./gliders.ts";
import { nodeTerrain } from "./terrain.ts";

export const ASK21_AIRBRAKE: AirbrakeRoute = { property: "/controls/engines/engine/throttle", invert: true };

export interface SoaringStart {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  aglM: number;
  easKmh: number;
}

export interface Autopilot {
  /** Hold this heading [deg] (roll to turn, max 30° bank) … */
  headingDeg?: number;
  /** … or this bank angle [deg]. */
  bankDeg?: number;
  /** Hold this equivalent airspeed with the elevator. */
  easKmh: number;
}

export class SoaringSim {
  readonly ctl: FgControls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0 };
  last: EnvironmentOutput | undefined;
  /** Pitch attitude [deg] that holds the target speed (integrator), from the trim. */
  private pitchBase = 0;

  constructor(
    readonly fdm: Fdm,
    readonly env: Environment,
    readonly airbrake: AirbrakeRoute,
  ) {}

  static async create(start: SoaringStart, env: EnvironmentConfig, opts: { profile?: GliderProfile; terrain?: TerrariumTerrain } = {}): Promise<SoaringSim> {
    const terrain = opts.terrain ?? nodeTerrain();
    await terrain.load(start.latDeg, start.lonDeg, 6000);
    const ground = (await terrain.heightAtAsync(start.latDeg, start.lonDeg)) * FT_PER_M;
    const { fdm } = await createGlider(opts.profile ?? ASK21, "solo");
    const environment = new Environment(env, terrain);
    const sim = new SoaringSim(fdm, environment, ASK21_AIRBRAKE);
    fdm.set(P.terrainElevationAslFt, ground);
    const trim = trimSteadyGlide(fdm, {
      speed: { veKts: start.easKmh / KMH_PER_KT },
      base: { "ic/terrain-elevation-ft": ground, "ic/lat-geod-deg": start.latDeg, "ic/long-gc-deg": start.lonDeg, "ic/h-agl-ft": start.aglM * FT_PER_M, "ic/psi-true-deg": start.headingDeg },
    });
    sim.ctl.elevatorTrim = trim.control;
    sim.pitchBase = fdm.get(P.thetaDeg);
    sim.apply();
    sim.last = applyEnvironment(environment, fdm, 0);
    return sim;
  }

  private apply(): void {
    for (const [p, v] of Object.entries(controlsToJsbsim(this.ctl, this.airbrake))) this.fdm.set(p, v);
  }

  /** Simple autopilot: bank from heading error, bank via ailerons, airspeed via elevator. */
  autopilot(ap: Autopilot, dt: number): void {
    const f = this.fdm;
    const phi = f.get(P.phiDeg), p = f.get("velocities/p-rad_sec");
    let bank = ap.bankDeg ?? 0;
    if (ap.headingDeg !== undefined) {
      const err = ((ap.headingDeg - f.get(P.psiDeg) + 540) % 360) - 180;
      bank = Math.max(-30, Math.min(30, 1.5 * err));
    }
    this.ctl.aileron = Math.max(-1, Math.min(1, 0.04 * (bank - phi) - 0.3 * p));
    // Speed → pitch attitude (too fast → raise the nose), pitch via elevator (FG: + = nose down).
    const eas = f.get(P.veKts) * KMH_PER_KT;
    const err = eas - ap.easKmh;
    this.pitchBase = Math.max(-15, Math.min(15, this.pitchBase + 0.05 * err * dt));
    const thetaTarget = Math.max(-20, Math.min(20, this.pitchBase + 0.3 * err));
    this.ctl.elevator = Math.max(-1, Math.min(1, 0.08 * (f.get(P.thetaDeg) - thetaTarget) + 0.6 * f.get("velocities/q-rad_sec")));
    // Coordinate turns a little with rudder.
    this.ctl.rudder = Math.max(-1, Math.min(1, 6 * f.get("aero/beta-rad"))); // FG rudder: + yaws right, kills +beta
  }

  /** Advance `seconds` in batches of `batch` steps, with environment and optional autopilot. */
  run(seconds: number, ap?: Autopilot, batch = 4, onSample?: (s: SoaringSim) => void): void {
    const dt = batch * this.fdm.dt;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      if (ap) this.autopilot(ap, dt);
      this.apply();
      this.fdm.step(batch);
      this.last = applyEnvironment(this.env, this.fdm, dt);
      onSample?.(this);
    }
  }

  get altM(): number {
    return this.fdm.get("position/geod-alt-ft") * M_PER_FT;
  }
  get aglM(): number {
    return this.fdm.get(P.hAglFt) * M_PER_FT;
  }
}
