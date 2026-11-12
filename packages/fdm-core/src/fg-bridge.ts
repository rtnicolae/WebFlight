/**
 * The parts of FlightGear's JSBSim interface (src/FDM/JSBSim/JSBSim.cxx) that a host must
 * reproduce so FlightGear aircraft models and inputs behave the same:
 *
 * copy_to_JSBsim:    FG controls → JSBSim commands. Note the rudder sign flip.
 * copy_from_JSBsim:  JSBSim surface positions → /surface-positions/* (rudder flipped again).
 * update_gear:       gear/unit[n]/* → /gear/gear[n]/*.
 */
import { P } from "./props.ts";

/** Pilot controls with FlightGear's meaning and sign (/controls/flight/*). */
export interface FgControls {
  /** -1..1, + = roll right. */
  aileron: number;
  /** -1..1, + = stick forward (nose down). */
  elevator: number;
  /** -1..1, + = right pedal (yaw right). */
  rudder: number;
  /** -1..1, + = nose-down trim. */
  elevatorTrim: number;
  /** 0..1 airbrake lever; routed by the aircraft's input profile. */
  airbrake: number;
}

export interface AirbrakeRoute {
  /** FG property the lever drives, e.g. /controls/flight/speedbrake. */
  property: string;
  invert: boolean;
}

/** JSBSim property writes for a set of FG controls (FGJSBsim::copy_to_JSBsim). */
export function controlsToJsbsim(c: FgControls, airbrake: AirbrakeRoute): Record<string, number> {
  const out: Record<string, number> = {
    [P.aileronCmd]: c.aileron,
    [P.elevatorCmd]: c.elevator,
    [P.rudderCmd]: -c.rudder, // SetDrCmd(-rudder)
    [P.pitchTrimCmd]: c.elevatorTrim,
  };
  const lever = airbrake.invert ? 1 - c.airbrake : c.airbrake;
  // /controls/flight/speedbrake is copied to fcs/speedbrake-cmd-norm by FG; other
  // properties (e.g. the ASK21's throttle) are read by the aircraft's own JSBSim XML.
  if (airbrake.property === "/controls/flight/speedbrake") out[P.speedbrakeCmd] = lever;
  else out[airbrake.property] = lever;
  return out;
}

/** The FG property tree values implied by the controls (for cockpit animations). */
export function controlsToFgProperties(c: FgControls, airbrake: AirbrakeRoute): Record<string, number> {
  return {
    "/controls/flight/aileron": c.aileron,
    "/controls/flight/elevator": c.elevator,
    "/controls/flight/rudder": c.rudder,
    "/controls/flight/elevator-trim": c.elevatorTrim,
    [airbrake.property]: airbrake.invert ? 1 - c.airbrake : c.airbrake,
  };
}

/** An FG property derived from one JSBSim property: fg = scale * jsbsim. */
export interface FgSource {
  jsbsim: string;
  scale: number;
}

const SURFACES: Record<string, FgSource> = {
  "/surface-positions/elevator-pos-norm": { jsbsim: "fcs/elevator-pos-norm", scale: 1 },
  "/surface-positions/left-aileron-pos-norm": { jsbsim: "fcs/left-aileron-pos-norm", scale: 1 },
  "/surface-positions/right-aileron-pos-norm": { jsbsim: "fcs/right-aileron-pos-norm", scale: 1 },
  "/surface-positions/rudder-pos-norm": { jsbsim: "fcs/rudder-pos-norm", scale: -1 },
  "/surface-positions/flap-pos-norm": { jsbsim: "fcs/flap-pos-norm", scale: 1 },
  "/surface-positions/speedbrake-pos-norm": { jsbsim: "fcs/speedbrake-pos-norm", scale: 1 },
  "/surface-positions/spoilers-pos-norm": { jsbsim: "fcs/spoiler-pos-norm", scale: 1 },
};

const FT_TO_M = 0.3048;

/**
 * JSBSim source for an FG output property, or undefined if the FDM doesn't produce it.
 * `maxCompressionFt(n)` is FG's /gear/gear[n]/max-compression-ft (FG defaults it to 1).
 */
export function fgOutputSource(fgPath: string, maxCompressionFt: (n: number) => number = () => 1): FgSource | undefined {
  const s = SURFACES[fgPath];
  if (s) return s;
  const g = /^\/gear\/gear(?:\[(\d+)\])?\/(compression-norm|compression-m|compression-ft|rollspeed-ms|wow)$/.exec(fgPath);
  if (g) {
    const n = Number(g[1] ?? 0);
    const unit = n === 0 ? "gear/unit" : `gear/unit[${n}]`;
    switch (g[2]) {
      case "compression-norm": return { jsbsim: `${unit}/compression-ft`, scale: 1 / maxCompressionFt(n) };
      case "compression-m": return { jsbsim: `${unit}/compression-ft`, scale: FT_TO_M };
      case "compression-ft": return { jsbsim: `${unit}/compression-ft`, scale: 1 };
      case "rollspeed-ms": return { jsbsim: `${unit}/wheel-speed-fps`, scale: FT_TO_M };
      case "wow": return { jsbsim: `${unit}/WOW`, scale: 1 };
    }
  }
  return undefined;
}
