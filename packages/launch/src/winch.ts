/**
 * Winch launch, ported from FlightGear's Nasal/towing/hitch.nas (D-NXKT, Bea Wolf;
 * GPL-2.0-or-later): winch(), the automatic winch driver (auto_winch_driver*),
 * setWinchPositionAuto(), runWinch(), releaseHitch("winch"), the rope-breakage and
 * loss-of-power training options. Units and defaults are FG's; property names in the
 * comments refer to /sim/hitches/winch/*.
 *
 * The force acts at the glider's winch hitch along the rope, towards the winch, and goes to
 * JSBSim as external_reactions/<hitch>/{magnitude [lbs], x, y, z [body unit vector]}.
 */
import type { Vec3 } from "@webflight/fdm-core";
import { directionInBody, dist, ecef, offset as advance, type Attitude } from "./geo.ts";
import type { HitchForce, MessageSink } from "./types.ts";

export interface WinchConfig {
  /** 0: FG "tow with constant force"; 1: "tow with constant rope speed" (hitch type). */
  type: 0 | 1;
  /** tow/elastic-constant [N] */
  elasticConstant: number;
  /** tow/weight-per-m-kg-m */
  weightPerMKg: number;
  /** winch/initial-tow-length-m */
  initialTowLengthM: number;
  /** winch/max-tow-length-m */
  maxTowLengthM: number;
  /** winch/max-spool-speed-m-s */
  maxSpoolSpeedMs: number;
  /** winch/max-unspool-speed-m-s */
  maxUnspoolSpeedMs: number;
  /** winch/force-acceleration-N-s */
  forceAccelerationNs: number;
  /** winch/spool-acceleration-m-s-s */
  spoolAccelerationMss: number;
  /** winch/max-force-N */
  maxForceN: number;
  /** winch/max-power-kW */
  maxPowerKW: number;
  /** winch/magic-constant (rope drag when unclutched) */
  magicConstant: number;
  /** Aircraft-specific: tow/break-force [N] (weak link), automatic-release-angle-deg,
   * typical-tow-speed-kph, typical-tow-force-N. */
  breakForceN: number;
  automaticReleaseAngleDeg: number;
  typicalTowSpeedKph: number;
  typicalTowForceN: number;
  /** Training: rope breaks at this height [m] above ground (breakage/enabled). "random": 1–301 m. */
  ropeBreakage?: number | "random";
  /** Training: the winch loses power at this height [m] (loss-of-power/enabled). */
  lossOfPower?: number | "random";
}

/** FG defaults (hitch.nas `config`, `aircraft_settings`). */
export const FG_WINCH_DEFAULTS: WinchConfig = {
  type: 0,
  elasticConstant: 40001,
  weightPerMKg: 0.1,
  initialTowLengthM: 1000,
  maxTowLengthM: 1500,
  maxSpoolSpeedMs: 40,
  maxUnspoolSpeedMs: 40,
  forceAccelerationNs: 1000,
  spoolAccelerationMss: 8,
  maxForceN: 10000,
  maxPowerKW: 123,
  magicConstant: 500,
  breakForceN: 12345,
  automaticReleaseAngleDeg: 361,
  typicalTowSpeedKph: 0,
  typicalTowForceN: 0,
};

/**
 * check_aircraft_tow_settings(): typical speed and force from the weight when the aircraft
 * doesn't set them.
 */
export function typicalTowSettings(weightLb: number): { speedKph: number; forceN: number } {
  const kg = weightLb * 0.45359237;
  return { speedKph: -0.0002 * kg * kg + 0.33 * kg + 21, forceN: 0.15 * Math.pow(weightLb, 1.25) * 0.45359237 * 9.81 };
}

const WINCH_IDLE_FORCE = 1000; // N
const WINCH_IDLE_SPEED = 4; // m/s

export interface WinchInput {
  /** Glider attitude and position (CG). */
  att: Attitude;
  /** Glider's winch hitch [ECEF m], its altitude [m] and the ground elevation under it [m]. */
  hitch: Vec3;
  hitchAltM: number;
  hitchGroundM: number;
  /** Glider height above ground [ft] (alt_agl_ft) and groundspeed [kt]. */
  aglFt: number;
  groundspeedKt: number;
  windFromDeg: number;
  windKt: number;
}

export class Winch {
  readonly cfg: WinchConfig;
  /** sim/hitches/winch/open: true while not connected. */
  open = true;
  clutched = false;
  broken = false;
  /** Winch (rope end) position [ECEF m] and geodetic, once placed. */
  winchEcef: Vec3 | undefined;
  winchGeo: { latDeg: number; lonDeg: number; altM: number } | undefined;
  /** tow/length, tow/dist [m]; actual spool speed [m/s]; actual force [N]. */
  towLengthM = 0;
  distM = 0;
  spoolSpeedMs = 0;
  actualForceN = 0;
  /** Rope heading from the glider and elevation angle [deg] (for drawing). */
  ropeHeadingDeg = 0;
  /** Auto winch driver phase (0, 1, 2, 2.5, 3, 4, 5), settings and requested change. */
  phase = 0;
  forceSetting = 0;
  speedSetting = 0;
  private targetForce = 0;
  private targetSpeed = 0;
  private accelerationNs = 0;
  private accelerationMss = 0;
  private requestedChange = 0;
  private driverRunning = false;
  private alphaDeg = 0;
  private maxPowerW: number;
  private ropeBreakageHeight: number | undefined;
  private lossOfPowerHeight: number | undefined;
  private lossT: number | undefined;
  private lossDur: [number, number] = [3, 2];
  private powerAtStage2 = 0;
  private timers: { at: number; run: () => void }[] = [];
  private t = 0;

  constructor(
    cfg: Partial<WinchConfig> & Pick<WinchConfig, "typicalTowSpeedKph" | "typicalTowForceN">,
    private readonly rand: () => number,
    private readonly say: MessageSink = () => {},
  ) {
    this.cfg = { ...FG_WINCH_DEFAULTS, ...cfg };
    this.maxPowerW = this.cfg.maxPowerKW * 1000;
  }

  /**
   * setWinchPositionAuto(): the winch on the ground `initial-tow-length − 1` m ahead along
   * `headingDeg` from `from`, the rope laid out, the hook closed (unclutched).
   */
  place(from: { latDeg: number; lonDeg: number }, headingDeg: number, groundAtM: (lat: number, lon: number) => number, hitch: Vec3): void {
    const c = this.cfg;
    const [lat, lon] = advance(from.latDeg, from.lonDeg, headingDeg, c.initialTowLengthM - 1);
    const alt = groundAtM(lat, lon);
    this.winchGeo = { latDeg: lat, lonDeg: lon, altM: alt };
    this.winchEcef = ecef(lat, lon, alt);
    this.distM = c.initialTowLengthM - 1;
    this.towLengthM = c.initialTowLengthM;
    this.ropeHeadingDeg = headingDeg;
    this.ropeBreakageHeight = c.ropeBreakage === undefined ? undefined : c.ropeBreakage === "random" ? 1 + this.rand() * 300 : c.ropeBreakage;
    this.lossOfPowerHeight = c.lossOfPower === undefined ? undefined : c.lossOfPower === "random" ? 1 + this.rand() * 300 : c.lossOfPower;
    this.say("pilot", "Connected to winch!");
    this.close(hitch);
  }

  /** The winch hitch listener on open → false. */
  private close(hitch: Vec3): void {
    this.open = false;
    const d = dist(hitch, this.winchEcef!);
    if (d > this.towLengthM) {
      this.say("system", "Could not lock hitch (tow length is insufficient) on hitch 0!");
      this.open = true;
      return;
    }
    this.say("system", "Locked hitch winch 0!");
    this.clutched = false;
    this.broken = false;
    this.spoolSpeedMs = 0;
  }

  /** runWinch(): clutch (starts the automatic driver when on the ground) or unclutch. */
  run(aglFt: number, windFromDeg: number, windKt: number): void {
    if (this.open) return;
    if (!this.clutched) {
      this.clutched = true;
      this.say("pilot", "Winch clutched!");
      if (aglFt < 10) {
        this.driverInit(windFromDeg, windKt);
        this.driverRunning = true;
      }
    } else {
      this.clutched = false;
      this.say("pilot", "Winch un-clutched!");
    }
  }

  /** releaseHitch("winch") / releaseWinch(). */
  release(): void {
    if (this.open) return;
    this.open = true;
    this.actualForceN = 0;
    this.phase = 5; // driver: after-tow phase
    if (this.broken) this.say("pilot", "Oh no, the tow is broken");
  }

  /** winch_faster() / winch_slower() (d = 0.1 by default). */
  faster(d = 0.1): void {
    this.changeSpeed(d);
  }
  slower(d = 0.1): void {
    this.changeSpeed(-d);
  }

  private changeSpeed(d: number): void {
    this.say("pilot", d > 0 ? "Faster!" : "Slower!");
    if (this.phase === 2.5) this.phase = 3;
    if (this.phase !== 3) {
      this.say("winch-driver", "Unable!");
      return;
    }
    const c = this.cfg;
    if (d > 0) {
      if ((c.type === 0 && this.forceSetting + d * c.maxForceN <= c.maxForceN) || (c.type === 1 && this.speedSetting + d * c.maxSpoolSpeedMs <= c.maxSpoolSpeedMs)) {
        this.requestedChange = d;
        this.say("winch-driver", "Faster");
      } else {
        if (c.type === 0) this.forceSetting = c.maxForceN;
        else this.speedSetting = c.maxSpoolSpeedMs;
        this.say("winch-driver", "At maximum!");
      }
    } else if ((c.type === 0 && this.forceSetting + d * c.maxForceN >= WINCH_IDLE_FORCE) || (c.type === 1 && this.speedSetting + d * c.maxSpoolSpeedMs >= WINCH_IDLE_SPEED)) {
      this.requestedChange = d;
      this.say("winch-driver", "Slower");
    } else {
      if (c.type === 0) this.forceSetting = WINCH_IDLE_FORCE;
      else this.speedSetting = WINCH_IDLE_SPEED;
      this.say("winch-driver", "At minimum!");
    }
  }

  /** auto_winch_driver_init() */
  private driverInit(windFromDeg: number, windKt: number): void {
    const c = this.cfg;
    this.targetForce = c.typicalTowForceN;
    this.targetSpeed = c.typicalTowSpeedKph / 3.6;
    const rel = this.ropeHeadingDeg - windFromDeg;
    const linear = windKt * Math.cos((rel * Math.PI) / 180); // < 0: tailwind
    const normal = windKt * Math.cos((-(90 - rel) * Math.PI) / 180);
    const linearAdd = Math.max(-0.1, Math.min(0.1, -linear / 150));
    const normalAdd = Math.min(Math.abs(normal) / 150, 0.1);
    this.targetForce += (linearAdd + normalAdd) * c.maxForceN;
    this.targetSpeed += (linearAdd + normalAdd) * c.maxSpoolSpeedMs;
    this.accelerationNs = c.forceAccelerationNs;
    this.accelerationMss = c.spoolAccelerationMss;
    this.phase = 0;
  }

  /** auto_winch_driver() */
  private driver(dt: number, s: WinchInput): void {
    if (!this.driverRunning || !this.clutched) return;
    const c = this.cfg;
    if (this.phase === 3 || this.phase === 4) {
      const d = dist(ecef(s.att.latDeg, s.att.lonDeg, s.att.altM), this.winchEcef!);
      this.alphaDeg = (Math.asin((s.att.altM - this.winchGeo!.altM) / d) * 180) / Math.PI;
    }
    if (this.phase === 0) this.phase = 1;
    if (this.phase === 1) {
      if (c.type === 0) this.forceSetting = WINCH_IDLE_FORCE;
      else this.speedSetting = WINCH_IDLE_SPEED;
      if (s.groundspeedKt > 1) {
        this.phase = 2;
        this.say("launch-signaller", "Ready!");
        this.say("winch-driver", "Ready");
      }
    } else if (this.phase === 2 || this.phase === 2.5) {
      if (c.type === 0) {
        if (this.forceSetting < this.targetForce) this.forceSetting += this.accelerationNs * dt;
        else {
          this.forceSetting = this.targetForce;
          if (this.phase === 2.5) this.phase = 3;
        }
      } else if (this.speedSetting < this.targetSpeed) this.speedSetting += this.accelerationMss * dt;
      else {
        this.speedSetting = this.targetSpeed;
        if (this.phase === 2.5) this.phase = 3;
      }
      if (s.aglFt > 10 && this.phase < 2.5) {
        this.phase = 2.5;
        this.say("launch-signaller", "Clear of ground!");
        this.say("winch-driver", "Clear");
      }
    } else if (this.phase === 3) {
      if (this.requestedChange !== 0) {
        if (c.type === 0) this.forceSetting += this.requestedChange * c.maxForceN * dt;
        else this.speedSetting += this.requestedChange * c.maxSpoolSpeedMs * dt;
        this.requestedChange -= this.requestedChange * dt;
        if (Math.abs(this.requestedChange) < dt) this.requestedChange = 0;
      }
      const thrSpeed = 0.8, thrAngle = 0.5;
      const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
      const fracSpeed = clamp01(0.2 + 1 - (1 / (1 - thrSpeed)) * (this.spoolSpeedMs / c.maxSpoolSpeedMs - thrSpeed) * 0.8);
      const fracAngle = clamp01(0.2 + 1 - (1 / (1 - thrAngle)) * (this.alphaDeg / (c.automaticReleaseAngleDeg - 30) - thrAngle) * 0.8);
      if (c.type === 0) this.forceSetting = this.targetForce * fracSpeed * fracAngle;
      else this.speedSetting = this.targetSpeed * fracSpeed * fracAngle;
      if (this.alphaDeg >= c.automaticReleaseAngleDeg - 10) this.phase = 4;
    } else if (this.phase === 4) {
      if (this.speedSetting > WINCH_IDLE_SPEED) {
        const dec = 3 * Math.max(5, Math.min(this.accelerationMss, (this.speedSetting - WINCH_IDLE_SPEED) / (c.automaticReleaseAngleDeg - 2 - this.alphaDeg)));
        this.speedSetting -= dec * dt;
      } else this.speedSetting = WINCH_IDLE_SPEED;
    } else if (this.phase === 5) {
      if (c.type === 0) this.forceSetting = WINCH_IDLE_FORCE;
      else this.speedSetting = WINCH_IDLE_SPEED;
      this.driverRunning = false;
    }
  }

  /** loss_of_power(): power falls to 1/10 over 2–4 s, then (after 3 s) to 0 over 1–3 s. */
  private updatePowerLoss(dt: number): void {
    if (this.lossT === undefined) return;
    const p0 = this.cfg.maxPowerKW * 1000;
    const t = (this.lossT += dt);
    if (t < 3) this.maxPowerW = p0 + (p0 / 10 - p0) * Math.min(1, t / this.lossDur[0]);
    else {
      if (this.powerAtStage2 === 0) this.powerAtStage2 = this.maxPowerW || 1e-9;
      this.maxPowerW = this.powerAtStage2 * Math.max(0, 1 - (t - 3) / this.lossDur[1]);
    }
  }

  private later(seconds: number, run: () => void): void {
    this.timers.push({ at: this.t + seconds, run });
  }

  /** One update (FG: every frame while the winch hitch is closed). Returns the force on the glider. */
  update(dt: number, s: WinchInput): HitchForce | undefined {
    this.t += dt;
    for (const tm of this.timers.filter((x) => x.at <= this.t)) tm.run();
    this.timers = this.timers.filter((x) => x.at > this.t);
    this.updatePowerLoss(dt);
    this.driver(dt, s);
    if (this.open || !this.winchEcef || dt <= 0) return undefined;
    const c = this.cfg;

    // Training failures (my_height: hitch above the ground under it).
    const myHeight = s.hitchAltM - s.hitchGroundM;
    if (this.ropeBreakageHeight !== undefined && myHeight > this.ropeBreakageHeight) {
      const h = this.ropeBreakageHeight;
      this.ropeBreakageHeight = undefined;
      this.release();
      this.later(5, () => this.say("winch-driver", `Rope broke at ${String(Math.round(h)).padStart(4)}m height`));
      return undefined;
    }
    if (this.lossOfPowerHeight !== undefined && myHeight > this.lossOfPowerHeight) {
      const h = this.lossOfPowerHeight;
      this.lossOfPowerHeight = undefined;
      this.lossT = 0;
      this.lossDur = [2 + 2 * this.rand(), 1 + 2 * this.rand()];
      this.later(15, () => this.say("winch-driver", `Winch lost power at ${String(Math.round(h)).padStart(4)}m height`));
      return undefined; // FG returns for this frame
    }

    const distance = dist(s.hitch, this.winchEcef);
    const { dir } = directionInBody(s.att, s.hitch, this.winchEcef);
    const hAboveWinch = s.hitchAltM - this.winchGeo!.altM;
    this.distM = distance;

    const spoolMax = c.maxSpoolSpeedMs, unspoolMax = c.maxUnspoolSpeedMs;
    const maxForce = c.maxForceN, k = c.elasticConstant;
    const towLength = this.towLengthM;
    let spool = this.spoolSpeedMs;
    let force = this.actualForceN;
    let newLength: number;
    let delta: number;

    if (this.clutched) {
      if (c.type === 0) {
        // Force controlled: the drum accelerates to its maximum speed, the rope stretches.
        newLength = towLength - spool * dt;
        delta = distance - newLength;
        spool = Math.min(spoolMax, spool + c.spoolAccelerationMss * dt);
        force = delta < 0 ? 0 : (k * delta) / newLength;
      } else {
        // Regulate force to reach the target rope speed.
        if (Math.abs(spool - this.speedSetting) > 0.5) {
          if (this.speedSetting > spool) force += this.accelerationNs * dt;
          else if (this.speedSetting < spool) force -= this.accelerationNs * dt;
        }
        newLength = distance;
        delta = -(distance - towLength);
        spool = delta / dt;
      }
    } else {
      // Unclutched ("experimental" in FG): rope pulled out by the glider against drum drag.
      newLength = towLength - spool * dt;
      delta = distance - newLength;
      force = (k * delta) / newLength;
      const ropeDrag = (spool * spool * Math.sqrt(Math.abs(hAboveWinch) * c.maxTowLengthM)) / c.magicConstant;
      const massKg = c.maxTowLengthM * c.weightPerMKg;
      spool = Math.max(-unspoolMax, spool - ((force - ropeDrag) / massKg) * dt);
      force = delta < 0 ? 0 : (k * delta) / newLength;
    }

    if (force > maxForce) {
      force = maxForce;
      newLength = distance / (force / k + 1);
      spool = (towLength - newLength) / dt;
    }
    const power = force * spool;
    if (power > this.maxPowerW) {
      force = this.maxPowerW / spool;
      newLength = towLength - spool * dt;
    }
    this.towLengthM = newLength;
    this.spoolSpeedMs = spool;
    this.actualForceN = force;

    // Rope weight acts along the rope at the higher end.
    const weightN = hAboveWinch < 0 ? 0 : c.weightPerMKg * 9.81 * hAboveWinch;
    const total = force + weightN;

    let out: HitchForce | undefined;
    if (total < c.breakForceN) {
      out = { forceN: total, dirBody: dir };
      const ropeAngleDeg = (Math.atan2(dir[2], dir[0]) * 180) / Math.PI;
      if (ropeAngleDeg > c.automaticReleaseAngleDeg) this.release();
    } else {
      this.broken = true;
      this.release();
      return undefined;
    }
    if (newLength > c.maxTowLengthM) {
      this.say("system", "tow length exceeded!");
      this.release();
    }
    return this.open ? undefined : out;
  }
}
