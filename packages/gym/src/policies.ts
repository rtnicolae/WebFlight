/**
 * Scripted baseline policies that see only the observation vector (no simulator truth):
 * a sanity check that the observations suffice, a reference score for learning curves,
 * and a source of demonstrations. FG conventions: +elevator = nose down, +rudder = yaw right.
 */
const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const D2R = Math.PI / 180;

export type Policy = (obs: Float64Array) => number[];

/** Landing: 5° path to the aim point with the airbrake, 95 km/h with pitch, flare, rollout. */
export function landingBaseline(): Policy {
  let pitchBase = 0;
  let flarePitch: number | undefined;
  return (o) => {
    const ias = o[0]! * 50 * 3.6, climb = o[1]! * 10, agl = o[2]! * 100;
    const phi = o[3]!, theta = o[4]!, p = o[5]!, q = o[6]!, beta = o[9]!;
    const onGround = o[14]! > 0.5;
    const toAim = o[16]! * 1000, cross = o[17]! * 100;
    const hdgErr = Math.atan2(o[18]!, o[19]!);
    const hThr = o[22]! * 100;

    // Lateral: intercept the centreline (crab into wind comes from the cross-track feedback).
    const hdgCmd = clamp(-Math.atan(cross / 120), -25 * D2R, 25 * D2R);
    let bankCmd = clamp(2 * (hdgCmd - hdgErr), -20 * D2R, 20 * D2R);
    if (agl < 6) bankCmd = 0;
    const aileron = clamp(2.5 * (bankCmd - phi) - 0.3 * p);
    const rudder = onGround || agl < 2 ? clamp(-2 * hdgErr - 0.5 * o[7]!) : clamp(6 * beta);

    if (onGround) return [aileron, 0, rudder, 1]; // rollout: stick neutral, airbrake + wheel brake

    // Vertical: speed with pitch (integrator finds the glide attitude), path with airbrake.
    const tgtKmh = 95;
    pitchBase = clamp(pitchBase + 0.0004 * (ias - tgtKmh), -0.3, 0.3);
    let pitchCmd = pitchBase + 0.01 * (ias - tgtKmh);
    if (agl < 8) {
      // Flare: from ~1.5 m/s down to 0.3 m/s at the wheels.
      flarePitch ??= theta;
      const sinkTarget = 0.3 + (1.2 * Math.max(0, agl - 1)) / 7;
      pitchCmd = flarePitch + 0.06 * (-climb - sinkTarget);
    }
    const elevator = clamp(2.5 * (theta - pitchCmd) + 0.6 * q);
    const pathH = Math.max(0, toAim) * Math.tan(5 * D2R);
    const airbrake = agl < 8 ? 0.3 : clamp(0.4 + 0.02 * (hThr - pathH), 0, 1);
    return [aileron, elevator, rudder, airbrake];
  };
}

/**
 * Aerotow: steer at the tug, follow its bank, hold ~8 m above it, airbrake against slack,
 * never release (the tug does).
 */
export function aerotowBaseline(): Policy {
  let dzInt = 0;
  return (o) => {
    const ias = o[0]! * 50 * 3.6, agl = o[2]! * 100;
    const phi = o[3]!, theta = o[4]!, p = o[5]!, q = o[6]!, beta = o[9]!;
    const onGround = agl < 2;
    const x = o[16]! * 60, y = o[17]! * 60, z = o[18]! * 60;
    const vx = o[19]! * 10, vz = o[21]! * 10;
    const ropeDist = o[23]!;
    const tugRoll = o[24]!, tugAirborne = o[25]! > 0.5;
    const bearing = clamp(Math.atan2(y, x), -60 * D2R, 60 * D2R);
    const bankCmd = onGround ? 0 : clamp(2 * bearing + 0.8 * tugRoll, -30 * D2R, 30 * D2R);
    const aileron = clamp(2.9 * (bankCmd - phi) - 0.3 * p);
    const rudder = onGround ? clamp(3 * bearing) : clamp(6 * beta);
    let pitchCmd: number;
    if (!tugAirborne) pitchCmd = ias < 65 ? 0 : agl < 3 ? 4 * D2R : 0;
    else {
      // Tug height below us (NED down component of the body vector), target 8 m.
      const down = -x * Math.sin(theta) + y * Math.sin(phi) * Math.cos(theta) + z * Math.cos(phi) * Math.cos(theta);
      const err = down - 8; // > 0: we are too high
      dzInt = clamp(dzInt - err * 0.1, -30, 30);
      pitchCmd = clamp((-0.5 * err + 0.05 * dzInt - 0.8 * vz) * D2R, -10 * D2R, 15 * D2R);
    }
    const elevator = clamp(3.4 * (theta - pitchCmd) + 0.5 * q);
    // Don't overrun the tug: airbrake when the rope goes slack or the gap closes.
    const airbrake = onGround ? 0 : clamp(4 * (0.97 - ropeDist) - 0.15 * vx, 0, 1);
    return [aileron, elevator, rudder, airbrake, 0];
  };
}

/** Uniformly random actions in the box (seeded). */
export function randomPolicy(low: readonly number[], high: readonly number[], rand: () => number): Policy {
  return () => low.map((lo, i) => lo + (high[i]! - lo) * rand());
}
