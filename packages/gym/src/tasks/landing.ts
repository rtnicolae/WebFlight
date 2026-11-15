/**
 * Landing: from a randomized final approach to Grenchen runway 07 (real terrain), land on
 * the runway and stop.
 *
 * Start (per seed): 600–2500 m before the threshold, on a 3–8° path ±20 m (≥ 40 m above
 * the threshold), up to ±60 m (scaled with distance) off the centreline, heading ±15° off
 * the runway, 80–110 km/h, wind 0–12 kt from any direction, ridge lift on.
 *
 * Rewards:
 *   shaping   Φ(s') − Φ(s) with Φ = −(|along − aim| + 2·|cross|)/500 (aim point 150 m past
 *             the threshold): potential-based, so it doesn't change the optimal policy.
 *   landed    +50, +50 more on the runway, −20·|cross|/15 (on the runway),
 *             −10 per m/s of touchdown sink rate above 1 m/s
 *   crashed   −100 (wing/fuselage structure contact, touchdown sink > 3 m/s,
 *             nose strike: pitch < −15° on the ground, |roll| > 60° below 20 m)
 *   out of bounds (> 1.5 km off the centreline, > 600 m AGL, 1 km past the runway end
 *             still airborne): truncated, no extra reward
 */
import { Environment, GRENCHEN } from "@webflight/environment";
import { FT_PER_M, KMH_PER_KT, trimSteadyGlide } from "@webflight/fdm-core";
import { applyBaseAction, BASE_ACTION, BASE_OBSERVATION, concatSpec, mainWheelOnGround, observeBase, RunwayFrame, structureOnGround, uniform, wrapDeg } from "../common.ts";
import type { BoxSpec, Episode, Evaluation, Task } from "../types.ts";

const FT = 0.3048;
const AIM_M = 150;

const EXTRA: BoxSpec = {
  names: ["to_aim_km", "cross_track_m/100", "sin_heading_err", "cos_heading_err", "headwind_mps/10", "crosswind_from_right_mps/10", "height_above_threshold_m/100"],
  low: [-5, -20, -1, -1, -5, -5, -1],
  high: [5, 20, 1, 1, 5, 5, 10],
};

interface LandingState {
  touchdownSinkMs?: number;
  /** Sink rate at the last physics batch while airborne [m/s]. */
  airSinkMs: number;
  prevPhi: number;
  thresholdElevM: number;
  [k: string]: unknown;
}

export class LandingTask implements Task {
  readonly name = "landing";
  readonly observation = concatSpec(BASE_OBSERVATION, EXTRA);
  readonly action = BASE_ACTION;
  readonly maxSeconds = 300;
  readonly terrainRadiusM = 7000;
  readonly runway = new RunwayFrame(GRENCHEN, GRENCHEN.headingDeg, 1000, 23);
  readonly site = GRENCHEN;

  private st(ep: Episode): LandingState {
    return ep.state as LandingState;
  }

  private phi(ep: Episode): number {
    const f = ep.fdm;
    const p = this.runway.toRunway(f.get("position/lat-geod-deg"), f.get("position/long-gc-deg"));
    return -(Math.abs(p.along - AIM_M) + 2 * Math.abs(p.cross)) / 500;
  }

  setup(ep: Episode): void {
    const r = ep.rand, rw = this.runway;
    const dist = uniform(r, 600, 2500);
    const slope = (uniform(r, 3, 8) * Math.PI) / 180;
    const cross = uniform(r, -60, 60) * (dist / 2500);
    const headingDeg = rw.headingDeg + uniform(r, -15, 15);
    const easKmh = uniform(r, 80, 110);
    const windKt = uniform(r, 0, 12), windFromDeg = uniform(r, 0, 360);
    const thrElev = ep.groundAt(rw.thresholdLatDeg, rw.thresholdLonDeg);
    const heightAboveThr = Math.max(40, dist * Math.tan(slope) + uniform(r, -20, 20));
    const pos = rw.fromRunway(-dist, cross);
    const ground = ep.groundAt(pos.latDeg, pos.lonDeg);
    const agl = Math.max(30, thrElev + heightAboveThr - ground);

    ep.environment = new Environment({ windFromDeg, windKt, ridgeLift: true, thermals: false }, ep.terrain);
    ep.fdm.set("position/terrain-elevation-asl-ft", ground * FT_PER_M);
    const trim = trimSteadyGlide(ep.fdm, {
      speed: { veKts: easKmh / KMH_PER_KT },
      base: { "ic/lat-geod-deg": pos.latDeg, "ic/long-gc-deg": pos.lonDeg, "ic/terrain-elevation-ft": ground * FT_PER_M, "ic/h-agl-ft": agl * FT_PER_M, "ic/psi-true-deg": headingDeg },
    });
    ep.controls.elevatorTrim = trim.control;
    Object.assign(ep.state, { prevPhi: 0, airSinkMs: 0, thresholdElevM: thrElev, start: { distM: dist, crossM: cross, headingDeg, easKmh, windKt, windFromDeg, aglM: agl } });
    this.st(ep).prevPhi = this.phi(ep);
  }

  act(ep: Episode, a: readonly number[]): void {
    applyBaseAction(ep, a);
  }

  /** Touchdown sink rate: the last airborne value before the main wheel first touches. */
  physics(ep: Episode): void {
    const s = this.st(ep), f = ep.fdm;
    if (s.touchdownSinkMs !== undefined) return;
    if (mainWheelOnGround(f)) s.touchdownSinkMs = Math.max(0, s.airSinkMs);
    else s.airSinkMs = f.get("velocities/v-down-fps") * FT;
  }

  observe(ep: Episode, out: Float64Array): void {
    observeBase(ep, out);
    const f = ep.fdm, rw = this.runway;
    const p = rw.toRunway(f.get("position/lat-geod-deg"), f.get("position/long-gc-deg"));
    const err = (wrapDeg(f.get("attitude/psi-deg") - rw.headingDeg) * Math.PI) / 180;
    const c = ep.environment.config;
    const rel = ((c.windFromDeg - rw.headingDeg) * Math.PI) / 180;
    const w = c.windKt * 0.514444;
    out[16] = (AIM_M - p.along) / 1000;
    out[17] = p.cross / 100;
    out[18] = Math.sin(err);
    out[19] = Math.cos(err);
    out[20] = (w * Math.cos(rel)) / 10;
    out[21] = (w * Math.sin(rel)) / 10;
    out[22] = (f.get("position/geod-alt-ft") * FT - this.st(ep).thresholdElevM) / 100;
  }

  evaluate(ep: Episode): Evaluation {
    const f = ep.fdm, s = this.st(ep), rw = this.runway;
    const p = rw.toRunway(f.get("position/lat-geod-deg"), f.get("position/long-gc-deg"));
    const phi = this.phi(ep);
    let reward = phi - s.prevPhi;
    s.prevPhi = phi;
    const agl = f.get("position/h-agl-ft") * FT;
    const onGround = mainWheelOnGround(f);
    const info = { along: p.along, cross: p.cross, touchdownSinkMs: s.touchdownSinkMs };

    const crash = (why: string): Evaluation => ({ reward: reward - 100, terminated: true, truncated: false, info: { ...info, outcome: "crashed", why } });
    if (structureOnGround(f)) return crash("structure contact");
    if (s.touchdownSinkMs !== undefined && s.touchdownSinkMs > 3) return crash("hard touchdown");
    if (onGround && f.get("attitude/theta-deg") < -15) return crash("nose strike");
    if (agl < 20 && Math.abs(f.get("attitude/phi-deg")) > 60) return crash("bank near the ground");

    if (onGround && f.get("velocities/vg-fps") * FT < 1) {
      const onRunway = rw.onRunway(p);
      reward += 50;
      if (onRunway) reward += 50 - (20 * Math.abs(p.cross)) / 15;
      reward -= 10 * Math.max(0, (s.touchdownSinkMs ?? 0) - 1);
      return { reward, terminated: true, truncated: false, info: { ...info, outcome: onRunway ? "landed" : "landed_off_runway" } };
    }
    if (Math.abs(p.cross) > 1500 || agl > 600 || (!onGround && p.along > rw.lengthM + 1000)) return { reward, terminated: false, truncated: true, info: { ...info, outcome: "out_of_bounds" } };
    return { reward, terminated: false, truncated: false, info };
  }
}
