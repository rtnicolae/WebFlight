/**
 * Aerotow rope, ported from FlightGear's Nasal/towing/hitch.nas aerotow() (the glider is the
 * "master" and computes the rope force; GPL-2.0-or-later): a massless elastic rope,
 *   F = k · (distance − length) / length   when stretched, 0 when slack,
 * broken above the weak link's break force, acting at the glider's aerotow hitch towards
 * the tow plane's hitch.
 */
import type { Vec3 } from "@webflight/fdm-core";
import { directionInBody, dist, type Attitude } from "./geo.ts";
import type { HitchForce, MessageSink } from "./types.ts";

export interface AerotowConfig {
  /** aerotow/tow/elastic-constant [N] */
  elasticConstant: number;
  /** aerotow/tow/length [m] */
  lengthM: number;
  /** aerotow/tow/break-force [N] */
  breakForceN: number;
}

export const FG_AEROTOW_DEFAULTS: AerotowConfig = { elasticConstant: 9111, lengthM: 60, breakForceN: 12345 };

export class AerotowRope {
  readonly cfg: AerotowConfig;
  open = true;
  broken = false;
  distM = 0;
  forceN = 0;

  constructor(cfg: Partial<AerotowConfig> = {}, private readonly say: MessageSink = () => {}) {
    this.cfg = { ...FG_AEROTOW_DEFAULTS, ...cfg };
  }

  /** findBestAIObject() + the hitch-closed handler: lock if the rope reaches. */
  connect(gliderHitch: Vec3, tugHitch: Vec3, callsign = "dragger"): boolean {
    const d = dist(gliderHitch, tugHitch);
    if (d >= this.cfg.lengthM) {
      this.say("system", "Sorry, no aircraft for aerotow!");
      return false;
    }
    this.say("pilot", `${callsign}, I am on your hook, distance ${d.toFixed(3)} meter.`);
    this.open = false;
    this.broken = false;
    this.distM = d;
    this.say("system", "Locked hitch aerotow 0!");
    return true;
  }

  /** releaseHitch("aerotow") */
  release(byTug = false): void {
    if (this.open) return;
    this.open = true;
    this.forceN = 0;
    if (byTug) this.say("remote-ac", "dragger: I have released the tow!");
    else if (this.broken) this.say("pilot", "Oh no, the tow is broken");
    else this.say("pilot", "Opened hitch aerotow 0!");
  }

  update(att: Attitude, gliderHitch: Vec3, tugHitch: Vec3): HitchForce | undefined {
    if (this.open) return undefined;
    const { dir, distM } = directionInBody(att, gliderHitch, tugHitch);
    this.distM = distM;
    const c = this.cfg;
    const stretch = distM - c.lengthM;
    const f = stretch < 0 ? 0 : (c.elasticConstant * stretch) / c.lengthM;
    this.forceN = f;
    if (f >= c.breakForceN) {
      this.broken = true;
      this.release();
      return undefined;
    }
    return { forceN: f, dirBody: dir };
  }
}
