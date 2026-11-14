/** Observation pieces, runway geometry and contact checks shared by the tasks. */
import type { Fdm } from "@webflight/fdm-core";
import { hitchesFromProperties, type Hitches } from "@webflight/launch";
import type { BoxSpec, Episode } from "./types.ts";

const FT = 0.3048;
const KT = 0.514444;
const M_PER_DEG_LAT = 111_132;

/** The first 16 observations of every task. */
export const BASE_OBSERVATION: BoxSpec = {
  names: [
    "ias_mps/50",
    "climb_mps/10",
    "agl_m/100",
    "roll_rad",
    "pitch_rad",
    "p_rad_s",
    "q_rad_s",
    "r_rad_s",
    "alpha_rad",
    "beta_rad",
    "aileron",
    "elevator",
    "rudder",
    "airbrake",
    "main_wheel_on_ground",
    "groundspeed_mps/50",
  ],
  low: [0, -5, 0, -Math.PI, -Math.PI / 2, -10, -10, -10, -Math.PI, -Math.PI, -1, -1, -1, 0, 0, 0],
  high: [5, 5, 10, Math.PI, Math.PI / 2, 10, 10, 10, Math.PI, Math.PI, 1, 1, 1, 1, 1, 5],
};

/** Actions every task has: FG controls (+elevator = nose down, +rudder = yaw right). */
export const BASE_ACTION: BoxSpec = {
  names: ["aileron", "elevator", "rudder", "airbrake"],
  low: [-1, -1, -1, 0],
  high: [1, 1, 1, 1],
};

export function observeBase(ep: Episode, out: Float64Array): void {
  const f = ep.fdm, c = ep.controls;
  out[0] = (f.get("velocities/vc-kts") * KT) / 50;
  out[1] = (-f.get("velocities/v-down-fps") * FT) / 10;
  out[2] = Math.min(10, (f.get("position/h-agl-ft") * FT) / 100);
  out[3] = f.get("attitude/phi-rad");
  out[4] = f.get("attitude/theta-rad");
  out[5] = f.get("velocities/p-rad_sec");
  out[6] = f.get("velocities/q-rad_sec");
  out[7] = f.get("velocities/r-rad_sec");
  out[8] = f.get("aero/alpha-rad");
  out[9] = f.get("aero/beta-rad");
  out[10] = c.aileron;
  out[11] = c.elevator;
  out[12] = c.rudder;
  out[13] = c.airbrake;
  out[14] = mainWheelOnGround(f) ? 1 : 0;
  out[15] = (f.get("velocities/vg-fps") * FT) / 50;
}

export function applyBaseAction(ep: Episode, a: readonly number[]): void {
  ep.controls.aileron = a[0]!;
  ep.controls.elevator = a[1]!;
  ep.controls.rudder = a[2]!;
  ep.controls.airbrake = a[3]!;
}

/** Concatenate box specs. */
export function concatSpec(...specs: BoxSpec[]): BoxSpec {
  return { names: specs.flatMap((s) => s.names), low: specs.flatMap((s) => s.low), high: specs.flatMap((s) => s.high) };
}

/** ASK21 hitches: ask21-jsb-set.xml and ask21-main.xml /sim/hitches (as in the web bundle). */
export const ASK21_HITCHES: Hitches = hitchesFromProperties(
  (p) =>
    ({
      "/sim/hitches/winch/force_name_jsbsim": "winch_hitch",
      "/sim/hitches/aerotow/force_name_jsbsim": "aerotow_hitch",
      "/sim/hitches/winch/typical-tow-speed-kph": "100",
      "/sim/hitches/winch/typical-tow-force-N": "6000",
      "/sim/hitches/winch/automatic-release-angle-deg": "70.",
      "/sim/hitches/winch/tow/break-force": "10000",
      "/sim/hitches/aerotow/tow/break-force": "6000",
    })[p],
);

/** Gear unit indices of the ASK21 (ask21-jsb.xml <contact> order). */
export const ASK21_CONTACTS = { mainWheel: 1, structure: [7, 8] } as const;

const unit = (i: number) => (i === 0 ? "gear/unit" : `gear/unit[${i}]`);
export const mainWheelOnGround = (f: Fdm) => f.get(`${unit(ASK21_CONTACTS.mainWheel)}/WOW`) > 0.5;
export const structureOnGround = (f: Fdm) => ASK21_CONTACTS.structure.some((i) => f.get(`${unit(i)}/WOW`) > 0.5);

/** A runway: along-track from the threshold [m] (positive towards the far end), cross-track [m] (positive right). */
export class RunwayFrame {
  readonly thresholdLatDeg: number;
  readonly thresholdLonDeg: number;
  private readonly sin: number;
  private readonly cos: number;
  private readonly mLon: number;

  constructor(
    centre: { latDeg: number; lonDeg: number },
    readonly headingDeg: number,
    readonly lengthM: number,
    readonly widthM: number,
  ) {
    const h = (headingDeg * Math.PI) / 180;
    this.sin = Math.sin(h);
    this.cos = Math.cos(h);
    this.mLon = M_PER_DEG_LAT * Math.cos((centre.latDeg * Math.PI) / 180);
    this.thresholdLatDeg = centre.latDeg - ((lengthM / 2) * this.cos) / M_PER_DEG_LAT;
    this.thresholdLonDeg = centre.lonDeg - ((lengthM / 2) * this.sin) / this.mLon;
  }

  toRunway(latDeg: number, lonDeg: number): { along: number; cross: number } {
    const n = (latDeg - this.thresholdLatDeg) * M_PER_DEG_LAT, e = (lonDeg - this.thresholdLonDeg) * this.mLon;
    return { along: n * this.cos + e * this.sin, cross: -n * this.sin + e * this.cos };
  }

  fromRunway(along: number, cross: number): { latDeg: number; lonDeg: number } {
    const n = along * this.cos - cross * this.sin, e = along * this.sin + cross * this.cos;
    return { latDeg: this.thresholdLatDeg + n / M_PER_DEG_LAT, lonDeg: this.thresholdLonDeg + e / this.mLon };
  }

  onRunway(p: { along: number; cross: number }): boolean {
    return p.along >= 0 && p.along <= this.lengthM && Math.abs(p.cross) <= this.widthM / 2;
  }
}

/** Uniform in [a, b). */
export const uniform = (rand: () => number, a: number, b: number) => a + (b - a) * rand();
export const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
