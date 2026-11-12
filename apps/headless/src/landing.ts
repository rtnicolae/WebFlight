/**
 * Scripted approach and landing on flat (ellipsoid) terrain, used to check the ground
 * contact model: no sinking through the ground, no bouncing, and the glider stops.
 *
 * Autopilot (FG control conventions via the bridge): elevator holds a pitch attitude;
 * the attitude target follows a sink-rate schedule that flares near the ground. Wings are
 * held level with the ailerons. After touchdown: stick neutral, airbrake fully open
 * (on the ASK21 the last 10 % of lever travel is the wheel brake).
 */
import { controlsToJsbsim, FT_PER_M, KMH_PER_KT, M_PER_FT, P, trimSteadyGlide, type AirbrakeRoute, type Fdm, type FgControls } from "@webflight/fdm-core";
import { START } from "./glide.ts";

export interface LandingSample {
  t: number;
  hAglM: number;
  iasKmh: number;
  sinkMs: number;
  pitchDeg: number;
  bankDeg: number;
  groundSpeedMs: number;
  /** Weight on wheels per contact, bit n = gear unit n. */
  wowMask: number;
  mainCompressionM: number;
}

export interface LandingResult {
  samples: LandingSample[];
  touchdown: LandingSample | undefined;
  /** Seconds the main wheel spent off the ground after first touchdown, at > 5 cm. */
  airborneAfterTouchdownS: number;
  maxHeightAfterTouchdownM: number;
  /** Lowest CG height above terrain after touchdown and the resting value. */
  minCgAglM: number;
  restCgAglM: number;
  stoppedAtS: number | undefined;
  rolloutM: number;
}

export function runLanding(fdm: Fdm, airbrake: AirbrakeRoute, opts: { startAglM?: number; easKmh?: number; maxS?: number; contacts?: number; flare?: boolean; approachSinkMs?: number } = {}): LandingResult {
  const contacts = opts.contacts ?? 7;
  const trim = trimSteadyGlide(fdm, { speed: { veKts: (opts.easKmh ?? 85) / KMH_PER_KT }, base: { ...START, "ic/h-agl-ft": (opts.startAglM ?? 40) * FT_PER_M } });
  if (!trim.converged) throw new Error("approach trim failed");
  const ctl: FgControls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: trim.control, airbrake: 0 };
  const apply = () => {
    for (const [p, v] of Object.entries(controlsToJsbsim(ctl, airbrake))) fdm.set(p, v);
  };
  apply();

  const samples: LandingSample[] = [];
  let touchdown: LandingSample | undefined;
  let airborne = 0, maxHAfter = 0, minCg = Infinity, stoppedAt: number | undefined;
  let x0 = 0, dist = 0;
  const steps = Math.round((opts.maxS ?? 90) / fdm.dt);
  const restingCg = { sum: 0, n: 0 };

  for (let i = 0; i < steps; i++) {
    const h = fdm.get(P.hAglFt) * M_PER_FT;
    const sink = fdm.get(P.vDownFps) * M_PER_FT;
    const theta = fdm.get(P.thetaDeg);
    const phi = fdm.get(P.phiDeg);
    const q = fdm.get("velocities/q-rad_sec");
    const p = fdm.get("velocities/p-rad_sec");
    let wow = 0;
    for (let g = 0; g < contacts; g++) if (fdm.get(g === 0 ? "gear/unit/WOW" : `gear/unit[${g}]/WOW`) > 0.5) wow |= 1 << g;
    const mainOnGround = (wow & 2) !== 0;
    const gs = fdm.get(P.vgFps) * M_PER_FT;

    if (!touchdown) {
      // Sink target: steady approach, then flare to ~0.25 m/s through the last metres.
      // The main wheel sits about 0.9 m below the CG.
      const wheelH = h - 0.9;
      const approach = opts.approachSinkMs ?? 1.2;
      const sinkTarget = opts.flare === false || wheelH > 6 ? approach : Math.max(0.2, 0.2 + ((approach - 0.2) / 6) * wheelH);
      const thetaTarget = trim.thetaDeg + 4 * (sink - sinkTarget);
      ctl.elevator = Math.max(-1, Math.min(1, 0.08 * (theta - thetaTarget) + 0.6 * q));
      ctl.aileron = Math.max(-1, Math.min(1, -0.05 * phi - 0.3 * p));
    } else {
      ctl.elevator = 0;
      ctl.aileron = Math.max(-1, Math.min(1, -0.05 * phi - 0.3 * p));
      ctl.airbrake = 1;
    }
    apply();
    fdm.step();
    const t = fdm.simTime;
    const s: LandingSample = {
      t,
      hAglM: fdm.get(P.hAglFt) * M_PER_FT,
      iasKmh: fdm.get(P.vcKts) * KMH_PER_KT,
      sinkMs: fdm.get(P.vDownFps) * M_PER_FT,
      pitchDeg: fdm.get(P.thetaDeg),
      bankDeg: fdm.get(P.phiDeg),
      groundSpeedMs: gs,
      wowMask: wow,
      mainCompressionM: fdm.get("gear/unit[1]/compression-ft") * M_PER_FT,
    };
    if (i % 12 === 0) samples.push(s);
    if (!touchdown && mainOnGround) {
      touchdown = s;
      x0 = 0;
    }
    if (touchdown) {
      dist += gs * fdm.dt;
      minCg = Math.min(minCg, s.hAglM);
      // Main wheel off the ground after touchdown: height of the wheel above its contact.
      if (!mainOnGround) {
        airborne += fdm.dt;
        maxHAfter = Math.max(maxHAfter, fdm.get("gear/unit[1]/AGL-ft") * M_PER_FT);
      }
      if (stoppedAt === undefined && gs < 0.2) stoppedAt = t;
      if (stoppedAt !== undefined && t > stoppedAt + 2) {
        restingCg.sum += s.hAglM;
        restingCg.n++;
        if (t > stoppedAt + 5) {
          samples.push(s);
          break;
        }
      }
    }
  }
  return {
    samples,
    touchdown,
    airborneAfterTouchdownS: airborne,
    maxHeightAfterTouchdownM: maxHAfter,
    minCgAglM: minCg,
    restCgAglM: restingCg.n ? restingCg.sum / restingCg.n : NaN,
    stoppedAtS: stoppedAt,
    rolloutM: dist - x0,
  };
}
