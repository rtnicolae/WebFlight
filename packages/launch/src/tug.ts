/**
 * The tow plane ("drag robot"), ported from the ASK21's Nasal/dragrobot.nas (Klaus Kerner,
 * Bea Wolf; GPL-2.0-or-later). As in FlightGear it is kinematic: it does not feel the rope.
 *
 *  leg 0  tauten the rope slowly, then accelerate along the runway to take-off speed
 *  leg 2  straight legs (first 200–400 m, then 100 m), climbing with speed
 *  leg 1  turns of 30–270° left or right (roll in at 5°/s to 20°, turn rate ∝ roll)
 *  exit   800 m above the start: "bye bye", releases 2 s later, then
 *  leg 3  50 m straight, a descending 90° left turn, 1500 m straight, gone
 *
 * Wind drifts it (FG: environment/wind-from-*-fps), vertical air moves it up/down.
 * FG's rand() is a seeded generator here, so a seed reproduces the tow pattern.
 */
import { distanceM } from "@webflight/environment";
import type { Vec3 } from "@webflight/fdm-core";
import { ecef, offset as advance } from "./geo.ts";
import type { MessageSink } from "./types.ts";

const KT = 0.514444;

export interface TugConfig {
  /** glob_min_speed_takeoff_mps etc. (dragrobot initRobotAttributes) */
  minSpeedTakeoffMs: number;
  maxSpeedMs: number;
  maxSpeedLiftMs: number;
  maxSpeedTautenMs: number;
  minAccelerationMss: number;
  maxAccelerationMss: number;
  maxRollDeg: number;
  maxRollRateDegs: number;
  maxTurnRateDegs: number;
  maxLiftHeightM: number;
  maxTautenDistM: number;
  /** Tow hitch in the tug's YASim axes (x fwd, y left, z up) [m]: FG's AI default (−5, 0, 0). */
  hitch: Vec3;
  /** Fraction of the rope length to place the tug at (sim/glider/towing/conf/rope_x1). */
  tautenRelative: number;
}

export const FG_TUG_DEFAULTS: TugConfig = {
  minSpeedTakeoffMs: 20,
  maxSpeedMs: 36,
  maxSpeedLiftMs: 3,
  maxSpeedTautenMs: 3,
  minAccelerationMss: 0.5,
  maxAccelerationMss: 3,
  maxRollDeg: 20,
  maxRollRateDegs: 5,
  maxTurnRateDegs: 3,
  maxLiftHeightM: 800,
  maxTautenDistM: 50,
  hitch: [-5, 0, 0],
  tautenRelative: 0.7,
};

export interface TugAir {
  windFromDeg: number;
  windKt: number;
  /** Vertical air motion [m/s], + up (FG wind-from-down). */
  upMs: number;
}

export class Tug {
  readonly cfg: TugConfig;
  latDeg: number;
  lonDeg: number;
  altM: number;
  headingDeg: number;
  rollDeg = 0;
  /** True airspeed [m/s] and climb [m/s]. */
  speedMs = 0;
  liftMs = 0;
  legType: 0 | 1 | 2 | 3 = 0;
  segment = 0;
  running = false;
  /** Removed after its last leg (stopRobot). */
  gone = false;
  private wp0: { latDeg: number; lonDeg: number; altM: number };
  private anchor: { latDeg: number; lonDeg: number; altM: number };
  private exitHeightM: number;
  private legDistanceM = 2000;
  private legAngleDeg: number;
  private turnRight = true;
  private sent = false;
  private lastLeg = false;
  private releaseIn: number | undefined;
  private maxSpeedLift: number;
  private maxRoll: number;
  private maxTurnRate: number;

  /**
   * createDragRobot(): on the ground `length × (rope_x1 − 0.02)` ahead of the glider along
   * the runway heading.
   */
  constructor(
    glider: { latDeg: number; lonDeg: number; altM: number },
    headingDeg: number,
    ropeLengthM: number,
    private readonly groundAtM: (lat: number, lon: number) => number,
    private readonly rand: () => number,
    private readonly say: MessageSink = () => {},
    /** Called when the tug releases the rope. */
    private readonly onRelease: () => void = () => {},
    cfg: Partial<TugConfig> = {},
  ) {
    this.cfg = { ...FG_TUG_DEFAULTS, ...cfg };
    const [lat, lon] = advance(glider.latDeg, glider.lonDeg, headingDeg, ropeLengthM * (this.cfg.tautenRelative - 0.02));
    this.latDeg = lat;
    this.lonDeg = lon;
    this.altM = groundAtM(lat, lon);
    this.headingDeg = headingDeg;
    this.legAngleDeg = headingDeg;
    this.wp0 = { latDeg: lat, lonDeg: lon, altM: this.altM };
    this.anchor = { ...this.wp0 };
    this.exitHeightM = glider.altM + this.cfg.maxLiftHeightM;
    this.maxSpeedLift = this.cfg.maxSpeedLiftMs;
    this.maxRoll = this.cfg.maxRollDeg;
    this.maxTurnRate = this.cfg.maxTurnRateDegs;
    say("ai-plane", " I will lift you up into the sky.");
  }

  start(): void {
    this.running = true;
  }

  /** The tug's tow hitch [ECEF m]. */
  hitchEcef(): Vec3 {
    // YASim x fwd / y left / z up, rotated by roll (pitch is always 0) and heading.
    const [x, y, z] = this.cfg.hitch;
    const r = (this.rollDeg * Math.PI) / 180;
    const left = y * Math.cos(r) - z * Math.sin(r);
    const up = y * Math.sin(r) + z * Math.cos(r);
    let [lat, lon] = advance(this.latDeg, this.lonDeg, this.headingDeg, x);
    [lat, lon] = advance(lat, lon, this.headingDeg - 90, left);
    return ecef(lat, lon, this.altM + up);
  }

  private dist3(a: { latDeg: number; lonDeg: number; altM: number }): number {
    return Math.hypot(distanceM(this.latDeg, this.lonDeg, a.latDeg, a.lonDeg), this.altM - a.altM);
  }

  private move(courseDeg: number, m: number): void {
    [this.latDeg, this.lonDeg] = advance(this.latDeg, this.lonDeg, courseDeg, m);
  }

  /** Wind drift as dragrobot: apply_course_distance(270, wind_from_east·dt), (180, wind_from_north·dt). */
  private drift(air: TugAir, dt: number): void {
    const w = air.windKt * KT, from = (air.windFromDeg * Math.PI) / 180;
    this.move(270, w * Math.sin(from) * dt);
    this.move(180, w * Math.cos(from) * dt);
  }

  update(dt: number, air: TugAir): void {
    if (this.releaseIn !== undefined) {
      this.releaseIn -= dt;
      if (this.releaseIn <= 0) {
        this.releaseIn = undefined;
        this.legType = 3;
        this.segment = 2;
        this.say("ai-plane", "turn right, I turn left");
        this.onRelease();
      }
    }
    if (!this.running || this.gone || dt <= 0) return;
    if (this.legType === 0) this.leg0(dt, air);
    else if (this.legType === 1) this.leg1(dt, air);
    else if (this.legType === 2) this.leg2(dt, air);
    else this.leg3(dt, air);
  }

  private leg0(dt: number, air: TugAir): void {
    const c = this.cfg;
    let old = this.speedMs;
    const headwind = air.windKt * KT * Math.cos(((air.windFromDeg - this.headingDeg) * Math.PI) / 180);
    let newSpeed: number, d: number;
    if (this.segment === 1) {
      newSpeed = old + c.maxAccelerationMss * dt;
      d = (old - headwind) * dt + 0.5 * c.maxAccelerationMss * dt * dt;
    } else {
      if (old - headwind < c.maxSpeedTautenMs) {
        if (old < headwind) old = headwind;
        newSpeed = c.minAccelerationMss * dt + old;
        d = (old - headwind) * dt + 0.5 * c.minAccelerationMss * dt * dt;
        if (d < 0.01) d = 0; // keep it locked until fast enough
      } else {
        newSpeed = old;
        d = (old - headwind) * dt;
      }
      if (this.dist3(this.wp0) > c.maxTautenDistM) this.segment = 1;
    }
    const ground = this.groundAtM(this.latDeg, this.lonDeg); // FG: elevation before the move
    this.move(this.headingDeg, d);
    this.altM = ground;
    this.speedMs = newSpeed;
    if (old > c.minSpeedTakeoffMs) {
      this.anchor = { latDeg: this.latDeg, lonDeg: this.lonDeg, altM: this.altM };
      this.legType = 2;
      this.legDistanceM = 200 + this.rand() * 200;
      this.say("ai-plane", `straight ahead for ${Math.round(this.legDistanceM)}m`);
    }
  }

  /** Speed, climb and position for legs 1 and 2. */
  private fly(dt: number, air: TugAir, headingDeg: number): void {
    const c = this.cfg;
    const old = this.speedMs;
    let d: number;
    if (old >= c.maxSpeedMs) d = old * dt;
    else {
      this.speedMs = old + c.maxAccelerationMss * dt;
      d = old * dt + 0.5 * c.maxAccelerationMss * dt * dt;
    }
    this.liftMs = (this.maxSpeedLift * (old - c.minSpeedTakeoffMs)) / (c.maxSpeedMs - c.minSpeedTakeoffMs);
    this.move(headingDeg, d);
    this.drift(air, dt);
    this.altM += (this.liftMs + air.upMs) * dt;
  }

  private leg1(dt: number, air: TugAir): void {
    const c = this.cfg;
    const old = this.rollDeg, target = this.legAngleDeg, h = this.headingDeg;
    let roll = old;
    const sign = this.turnRight ? 1 : -1;
    if (this.segment === 2) {
      if (sign * old < this.maxRoll) roll = old + sign * dt * c.maxRollRateDegs;
      else this.segment = 3;
    }
    if (this.segment === 3) {
      roll = old;
      if (this.turnRight ? h > target && h <= target + 5 : h < target && h >= target - 5) this.segment = 4;
    }
    if (this.segment === 4) {
      if (sign * old > 0) roll = old - sign * dt * c.maxRollRateDegs;
      else {
        roll = 0;
        this.anchor = { latDeg: this.latDeg, lonDeg: this.lonDeg, altM: this.altM };
        this.segment = 2;
        this.legType = 2;
        if (!this.lastLeg) {
          this.legDistanceM = 100;
          this.say("ai-plane", "straight ahead for 100m");
        } else {
          this.legDistanceM = 1500;
          this.maxSpeedLift = 0;
        }
      }
    }
    this.rollDeg = roll;
    let heading = h + ((this.maxTurnRate * roll) / this.maxRoll) * dt;
    if (heading > 360) heading -= 360;
    else if (heading < 0) heading += 360;
    this.headingDeg = heading;
    this.fly(dt, air, heading);
  }

  private leg2(dt: number, air: TugAir): void {
    this.fly(dt, air, this.headingDeg);
    if (!this.lastLeg) {
      if (this.altM > this.exitHeightM && !this.sent) {
        this.say("ai-plane", " we have reached max height, bye bye");
        this.sent = true;
        this.releaseIn = 2;
      } else if (this.dist3(this.anchor) > this.legDistanceM) {
        const turn = 30 + this.rand() * 240;
        this.legAngleDeg = (this.headingDeg + turn) % 360;
        this.turnRight = this.rand() > 0.5;
        this.say("ai-plane", `turn ${this.turnRight ? "right" : "left"} ${Math.round(turn)} deg`);
        this.legType = 1;
        this.segment = 2;
      }
    } else if (this.dist3(this.anchor) > this.legDistanceM) {
      this.running = false;
      this.gone = true;
    }
  }

  private leg3(dt: number, air: TugAir): void {
    this.liftMs = 0;
    this.move(this.headingDeg, this.speedMs * dt);
    this.drift(air, dt);
    this.altM += air.upMs * dt;
    if (this.dist3(this.anchor) > 50) {
      this.legType = 1;
      this.segment = 2;
      this.turnRight = false;
      this.maxSpeedLift = -1;
      this.maxRoll = 45;
      this.maxTurnRate = 8;
      this.legAngleDeg = this.headingDeg - 90 <= 0 ? 360 + (this.headingDeg - 90) : this.headingDeg - 90;
      this.lastLeg = true;
    }
  }
}
