/**
 * Ground launches in Node: the glider on the runway, a winch or aerotow from
 * @webflight/launch, and scripted pilots that fly them (baselines for training).
 *
 * Pilots use FG control conventions (+elevator = nose down, +rudder = yaw right).
 */
import { advance, type TerrariumTerrain } from "@webflight/environment";
import { controlsToJsbsim, FT_PER_M, M_PER_FT, type Fdm, type FgControls } from "@webflight/fdm-core";
import { ASK21_HITCHES } from "@webflight/gym";
import { directionInNed, ecef, Launch, type LaunchOptions } from "@webflight/launch";
import { ASK21, createGlider, type GliderProfile } from "./gliders.ts";
import { ASK21_AIRBRAKE } from "./soaring.ts";

/** ASK21 hitches: one definition, the gym's (ask21-jsb-set.xml and ask21-main.xml /sim/hitches). */
export { ASK21_HITCHES };

export interface GroundStart {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
}

export interface LaunchRunSample {
  t: number;
  aglM: number;
  iasKmh: number;
  pitchDeg: number;
  bankDeg: number;
  ropeForceN: number;
  connected: boolean;
}

export class GroundLaunchSim {
  readonly ctl: FgControls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0 };
  readonly samples: LaunchRunSample[] = [];
  maxForceN = 0;
  releasedAt: { t: number; aglM: number; iasKmh: number; by: "pilot" | "tow" } | undefined;
  maxIasOnTowKmh = 0;
  private pitchBase = 25;
  private dzInt = 0;

  private constructor(
    readonly fdm: Fdm,
    readonly launch: Launch,
    readonly groundAtM: (lat: number, lon: number) => number,
  ) {}

  /**
   * Glider standing on the runway (wing runner holding the wings), settled for 2 s, with
   * the winch laid out ahead or the tow plane in front.
   */
  static async create(start: GroundStart, kind: "winch" | "aerotow", terrain: TerrariumTerrain, opts: { profile?: GliderProfile; seed?: number; launch?: Partial<LaunchOptions>; log?: (s: string) => void } = {}): Promise<GroundLaunchSim> {
    await terrain.load(start.latDeg, start.lonDeg, kind === "aerotow" ? 9000 : 3000);
    const ground = await terrain.heightAtAsync(start.latDeg, start.lonDeg);
    const groundAtM = (lat: number, lon: number) => terrain.heightAt(lat, lon) ?? ground;
    const { fdm } = await createGlider(opts.profile ?? ASK21, "solo");
    fdm.set("position/terrain-elevation-asl-ft", ground * FT_PER_M);
    fdm.setInitialConditions({
      "ic/lat-geod-deg": start.latDeg,
      "ic/long-gc-deg": start.lonDeg,
      "ic/terrain-elevation-ft": ground * FT_PER_M,
      "ic/h-agl-ft": 2.4,
      "ic/psi-true-deg": start.headingDeg,
      "ic/vc-kts": 0,
      "ic/theta-deg": 0,
      "ic/phi-deg": 0,
    });
    // FG: /controls/gear/assist-1 → ground_handling.xml → /systems/groundhandling/wingholder.
    fdm.set("systems/groundhandling/wingholder", 1);
    fdm.runIc();
    const say = opts.log ? (c: string, m: string) => opts.log!(`[${c}] ${m}`) : undefined;
    const sim0 = { fdm } as { fdm: Fdm };
    for (const [p, v] of Object.entries(controlsToJsbsim({ aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0 }, ASK21_AIRBRAKE))) sim0.fdm.set(p, v);
    fdm.step(Math.round(2 / fdm.dt));
    const launch = new Launch(fdm, { kind, hitches: ASK21_HITCHES, groundAtM, headingDeg: start.headingDeg, seed: opts.seed ?? 1, ...(say ? { say } : {}), ...opts.launch });
    return new GroundLaunchSim(fdm, launch, groundAtM);
  }

  private apply(): void {
    for (const [p, v] of Object.entries(controlsToJsbsim(this.ctl, ASK21_AIRBRAKE))) this.fdm.set(p, v);
  }

  private get aglM(): number {
    return this.fdm.get("position/h-agl-ft") * M_PER_FT;
  }
  private get iasKmh(): number {
    return this.fdm.get("velocities/vc-kts") * 1.852;
  }

  /** Wings level with ailerons, ball centred with rudder (FG conventions). */
  private wings(bankDeg: number, onGround: boolean, headingErrDeg = 0): void {
    const f = this.fdm;
    this.ctl.aileron = Math.max(-1, Math.min(1, 0.05 * (bankDeg - f.get("attitude/phi-deg")) - 0.3 * f.get("velocities/p-rad_sec")));
    this.ctl.rudder = Math.max(-1, Math.min(1, onGround ? 0.05 * headingErrDeg : 6 * f.get("aero/beta-rad")));
  }

  private pitch(targetDeg: number): void {
    const f = this.fdm;
    this.ctl.elevator = Math.max(-1, Math.min(1, 0.06 * (f.get("attitude/theta-deg") - targetDeg) + 0.5 * f.get("velocities/q-rad_sec")));
  }

  /**
   * Winch pilot: level ground roll, gentle rotation, then ~105 km/h held with pitch (fast →
   * nose up); releases when the rope is steeper than `releaseAngleDeg` above the horizon.
   */
  private winchPilot(dt: number, releaseAngleDeg: number): void {
    const agl = this.aglM, ias = this.iasKmh;
    if (agl > 30) this.pitchBase = Math.max(10, Math.min(45, this.pitchBase + 0.4 * (ias - 105) * dt));
    let target = agl < 3 ? 2 : agl < 30 ? Math.min(this.pitchBase, 5 + agl * 0.8) : Math.max(5, Math.min(50, this.pitchBase + 0.5 * (ias - 105)));
    if (ias < 85) target = Math.min(target, 5);
    this.pitch(target);
    this.wings(0, agl < 1.5);
    const w = this.launch.winch!;
    if (w.winchGeo && w.distM > 0 && agl > 50) {
      const angle = (Math.asin((this.fdm.get("position/geod-alt-ft") * M_PER_FT - w.winchGeo.altM) / w.distM) * 180) / Math.PI;
      if (angle > releaseAngleDeg) this.release("pilot");
    }
  }

  /** Aerotow pilot: high tow ~8 m above the tug, steering at the tug, following its bank. */
  private towPilot(dt: number): void {
    const f = this.fdm, tug = this.launch.tug!;
    const gl = { latDeg: f.get("position/lat-geod-deg"), lonDeg: f.get("position/long-gc-deg") };
    const altM = f.get("position/geod-alt-ft") * M_PER_FT;
    const to = directionInNed(gl, ecef(gl.latDeg, gl.lonDeg, altM), ecef(tug.latDeg, tug.lonDeg, tug.altM));
    const bearing = (Math.atan2(to[1], to[0]) * 180) / Math.PI;
    const herr = ((bearing - f.get("attitude/psi-deg") + 540) % 360) - 180;
    const agl = this.aglM, ias = this.iasKmh;
    const onGround = agl < 2;
    this.wings(onGround ? 0 : Math.max(-30, Math.min(30, 2 * herr + tug.rollDeg * 0.8)), onGround, herr);
    const tugAgl = tug.altM - this.groundAtM(tug.latDeg, tug.lonDeg);
    if (tugAgl < 1) {
      // Lift off and hold low until the tug is airborne.
      this.pitch(ias < 65 ? 0 : agl < 3 ? 4 : 0);
    } else {
      const dz = altM - tug.altM, target = 8;
      this.dzInt = Math.max(-30, Math.min(30, this.dzInt + (target - dz) * dt));
      this.pitch(Math.max(-10, Math.min(15, 0.5 * (target - dz) + 0.05 * this.dzInt - 0.8 * f.get("velocities/h-dot-fps") * M_PER_FT + 0.8 * tug.liftMs)));
    }
  }

  private release(by: "pilot" | "tow"): void {
    if (this.releasedAt) return;
    if (by === "pilot") this.launch.release();
    this.releasedAt = { t: this.fdm.simTime, aglM: this.aglM, iasKmh: this.iasKmh, by };
  }

  /**
   * Start the launch and fly it with the scripted pilot until released (plus `afterS`
   * seconds of glide), or `maxS`. Rope forces update every `batch` FDM steps.
   */
  fly(opts: { maxS?: number; afterS?: number; batch?: number; winchReleaseAngleDeg?: number } = {}): void {
    const f = this.fdm, batch = opts.batch ?? 4, dt = batch * f.dt;
    const maxS = opts.maxS ?? 600, afterS = opts.afterS ?? 10;
    this.launch.start();
    const n = Math.round(maxS / dt);
    for (let i = 0; i < n; i++) {
      if (f.get("velocities/vg-fps") * M_PER_FT > 15 * 0.514444) f.set("systems/groundhandling/wingholder", 0); // FG: assist off above 15 kt
      if (!this.releasedAt) {
        if (this.launch.kind === "winch") this.winchPilot(dt, opts.winchReleaseAngleDeg ?? 65);
        else this.towPilot(dt);
        if (!this.launch.connected) this.release("tow");
      } else {
        this.pitch(-2);
        this.wings(0, false);
      }
      this.apply();
      const force = this.launch.update(dt, { windFromDeg: 0, windKt: 0 });
      if (this.launch.connected) {
        this.maxForceN = Math.max(this.maxForceN, force?.forceN ?? 0);
        if (this.aglM > 2) this.maxIasOnTowKmh = Math.max(this.maxIasOnTowKmh, this.iasKmh);
      }
      f.step(batch);
      if (i % Math.round(1 / dt) === 0)
        this.samples.push({ t: f.simTime, aglM: this.aglM, iasKmh: this.iasKmh, pitchDeg: f.get("attitude/theta-deg"), bankDeg: f.get("attitude/phi-deg"), ropeForceN: force?.forceN ?? 0, connected: this.launch.connected });
      if (this.releasedAt && f.simTime > this.releasedAt.t + afterS) break;
    }
  }
}

/** Start on Grenchen's runway 07, `fromThresholdM` past the threshold. */
export function grenchenRunwayStart(site: { latDeg: number; lonDeg: number; headingDeg: number }, lengthM = 1000, fromThresholdM = 50): GroundStart {
  const [lat, lon] = advance(site.latDeg, site.lonDeg, site.headingDeg + 180, lengthM / 2 - fromThresholdM);
  return { latDeg: lat, lonDeg: lon, headingDeg: site.headingDeg };
}
