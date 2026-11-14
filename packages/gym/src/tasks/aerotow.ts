/**
 * Aerotow take-off: standing on Grenchen runway 07 behind FlightGear's drag robot (DR400) on
 * a 60 m rope; take off, follow the tug in high tow until it releases 800 m up.
 *
 * Start (per seed): wind 0–8 kt from any direction, the tug's legs and turns (seeded).
 * Extra action: release (> 0.5 opens the hook).
 *
 * Rewards:
 *   each step  0.1·exp(−(cross² + vertical²)/15²) for holding the high-tow position:
 *              cross = distance from the tug's track line, vertical = glider hitch − (tug
 *              hitch + 8 m) once the tug is airborne; −0.05 when the rope is above 70 % of
 *              its weak link, −0.02 when it is slack (< 85 % of its length)
 *   towed      +100 when the tug releases the glider
 *   released   by the agent: +100·min(1, height gained / 800 m) if ≥ 300 m gained, else −50
 *   failed     −100: weak link broke, structure contact, |roll| > 70°, ground contact again
 *              after being airborne while still on tow
 */
import { Environment, GRENCHEN } from "@webflight/environment";
import { FT_PER_M, type Vec3 } from "@webflight/fdm-core";
import { bodyPointEcef, directionInBody, ecef, geodetic, hitchBodyM, Launch, readAttitude } from "@webflight/launch";
import { applyBaseAction, ASK21_HITCHES, BASE_ACTION, BASE_OBSERVATION, concatSpec, mainWheelOnGround, observeBase, RunwayFrame, structureOnGround, uniform, wrapDeg } from "../common.ts";
import type { BoxSpec, Episode, Evaluation, Task } from "../types.ts";

const FT = 0.3048;

const EXTRA: BoxSpec = {
  names: ["tug_x_body/60", "tug_y_body/60", "tug_z_body/60", "tug_vx_body/10", "tug_vy_body/10", "tug_vz_body/10", "rope_force/weak_link", "rope_distance/length", "tug_roll_rad", "tug_airborne", "sin_tug_heading_rel", "cos_tug_heading_rel", "on_tow"],
  low: [-50, -50, -50, -20, -20, -20, 0, 0, -Math.PI, 0, -1, -1, 0],
  high: [50, 50, 50, 20, 20, 20, 2, 50, Math.PI, 1, 1, 1, 1],
};

interface TowState {
  startAltM: number;
  airborne: boolean;
  prevTug?: Vec3;
  prevGlider?: Vec3;
  rel: Vec3;
  agentReleased: boolean;
  [k: string]: unknown;
}

export class AerotowTask implements Task {
  readonly name = "aerotow";
  readonly observation = concatSpec(BASE_OBSERVATION, EXTRA);
  readonly action: BoxSpec = { names: [...BASE_ACTION.names, "release"], low: [...BASE_ACTION.low, 0], high: [...BASE_ACTION.high, 1] };
  readonly maxSeconds = 600;
  readonly terrainRadiusM = 15000;
  readonly runway = new RunwayFrame(GRENCHEN, GRENCHEN.headingDeg, 1000, 30);
  readonly site = GRENCHEN;

  private st(ep: Episode): TowState {
    return ep.state as TowState;
  }

  setup(ep: Episode): void {
    const r = ep.rand, rw = this.runway, f = ep.fdm;
    const windKt = uniform(r, 0, 8), windFromDeg = uniform(r, 0, 360);
    const tugSeed = Math.floor(r() * 2 ** 31);
    ep.environment = new Environment({ windFromDeg, windKt, ridgeLift: true, thermals: false }, ep.terrain);
    const pos = rw.fromRunway(50, 0);
    const ground = ep.groundAt(pos.latDeg, pos.lonDeg);
    f.set("position/terrain-elevation-asl-ft", ground * FT_PER_M);
    f.setInitialConditions({
      "ic/lat-geod-deg": pos.latDeg,
      "ic/long-gc-deg": pos.lonDeg,
      "ic/terrain-elevation-ft": ground * FT_PER_M,
      "ic/h-agl-ft": 2.4,
      "ic/psi-true-deg": rw.headingDeg,
      "ic/vc-kts": 0,
      "ic/theta-deg": 0,
      "ic/phi-deg": 0,
    });
    // Wing runner (FG /controls/gear/assist-1 → /systems/groundhandling/wingholder).
    f.set("systems/groundhandling/wingholder", 1);
    f.runIc();
    ep.applyControls();
    f.step(Math.round(1 / f.dt)); // settle on the wheels
    ep.launch = new Launch(f, { kind: "aerotow", hitches: ASK21_HITCHES, groundAtM: ep.groundAt, headingDeg: rw.headingDeg, seed: tugSeed });
    ep.launch.start();
    Object.assign(ep.state, { startAltM: f.get("position/geod-alt-ft") * FT, airborne: false, rel: [0, 0, 0], agentReleased: false, start: { windKt, windFromDeg, tugSeed } });
  }

  act(ep: Episode, a: readonly number[]): void {
    applyBaseAction(ep, a);
    if (a[4]! > 0.5 && ep.launch?.connected) {
      ep.launch.release();
      this.st(ep).agentReleased = true;
    }
  }

  physics(ep: Episode, dt: number): void {
    const f = ep.fdm;
    // FG (ASK21 groundhandling.nas): the wing runner lets go above 15 kt.
    if (f.get("velocities/vg-fps") * FT > 15 * 0.514444) f.set("systems/groundhandling/wingholder", 0);
    const c = ep.environment.config;
    ep.launch!.update(dt, { windFromDeg: c.windFromDeg, windKt: c.windKt });
  }

  private gliderHitch(ep: Episode): Vec3 {
    return bodyPointEcef(readAttitude(ep.fdm), hitchBodyM(ep.fdm, ASK21_HITCHES.aerotow!));
  }

  observe(ep: Episode, out: Float64Array): void {
    observeBase(ep, out);
    const s = this.st(ep), l = ep.launch!, tug = l.tug!, att = readAttitude(ep.fdm);
    const g = this.gliderHitch(ep), t = tug.hitchEcef();
    const { dir, distM } = directionInBody(att, g, t);
    // Tug velocity relative to the glider (finite difference over the decision step), body axes.
    if (s.prevTug && s.prevGlider && ep.dt > 0) {
      const dv = [0, 1, 2].map((i) => (t[i]! - s.prevTug![i]! - (g[i]! - s.prevGlider![i]!)) / ep.dt) as Vec3;
      const base = ecef(att.latDeg, att.lonDeg, att.altM);
      const tip = [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]];
      const d = directionInBody(att, base, tip);
      s.rel = [d.dir[0] * d.distM, d.dir[1] * d.distM, d.dir[2] * d.distM];
    }
    s.prevTug = t;
    s.prevGlider = g;
    out[16] = (dir[0] * distM) / 60;
    out[17] = (dir[1] * distM) / 60;
    out[18] = (dir[2] * distM) / 60;
    out[19] = s.rel[0] / 10;
    out[20] = s.rel[1] / 10;
    out[21] = s.rel[2] / 10;
    out[22] = l.rope!.forceN / l.rope!.cfg.breakForceN;
    out[23] = distM / l.rope!.cfg.lengthM;
    out[24] = (tug.rollDeg * Math.PI) / 180;
    out[25] = tug.altM - ep.groundAt(tug.latDeg, tug.lonDeg) > 1 ? 1 : 0;
    const rel = (wrapDeg(tug.headingDeg - ep.fdm.get("attitude/psi-deg")) * Math.PI) / 180;
    out[26] = Math.sin(rel);
    out[27] = Math.cos(rel);
    out[28] = l.connected ? 1 : 0;
  }

  evaluate(ep: Episode): Evaluation {
    const f = ep.fdm, s = this.st(ep), l = ep.launch!, tug = l.tug!, rope = l.rope!;
    const altM = f.get("position/geod-alt-ft") * FT, agl = f.get("position/h-agl-ft") * FT;
    const gain = altM - s.startAltM;
    if (agl > 5) s.airborne = true;
    const info = { gainM: gain, ropeForceN: rope.forceN };
    const fail = (why: string): Evaluation => ({ reward: -100, terminated: true, truncated: false, info: { ...info, outcome: "failed", why } });
    if (rope.broken) return fail("weak link broke");
    if (structureOnGround(f)) return fail("structure contact");
    if (Math.abs(f.get("attitude/phi-deg")) > 70) return fail("excessive bank");
    if (l.connected && s.airborne && mainWheelOnGround(f)) return fail("touched down on tow");
    if (!l.connected) {
      if (!s.agentReleased) return { reward: 100, terminated: true, truncated: false, info: { ...info, outcome: "towed" } };
      return gain >= 300
        ? { reward: 100 * Math.min(1, gain / 800), terminated: true, truncated: false, info: { ...info, outcome: "released" } }
        : { reward: -50, terminated: true, truncated: false, info: { ...info, outcome: "released_low" } };
    }
    // Position keeping in high tow.
    const g = this.gliderHitch(ep), t = tug.hitchEcef();
    const h = (tug.headingDeg * Math.PI) / 180;
    const glider = readAttitude(f);
    const dN = (glider.latDeg - tug.latDeg) * 111_132, dE = (glider.lonDeg - tug.lonDeg) * 111_132 * Math.cos((tug.latDeg * Math.PI) / 180);
    const cross = -dN * Math.sin(h) + dE * Math.cos(h);
    const tugAirborne = tug.altM - ep.groundAt(tug.latDeg, tug.lonDeg) > 1;
    const vertical = tugAirborne ? geodetic(g).altM - (geodetic(t).altM + 8) : 0;
    let reward = 0.1 * Math.exp(-(cross * cross + vertical * vertical) / 225);
    if (rope.forceN > 0.7 * rope.cfg.breakForceN) reward -= 0.05;
    if (rope.distM < 0.85 * rope.cfg.lengthM && s.airborne) reward -= 0.02;
    return { reward, terminated: false, truncated: false, info: { ...info, cross, vertical } };
  }
}
