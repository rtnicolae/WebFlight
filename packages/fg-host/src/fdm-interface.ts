/**
 * The FlightGear side of the JSBSim interface: publishes FDM state into the FG property
 * tree the way FGJSBsim::copy_from_JSBsim / FGInterface do (src/FDM/JSBSim/JSBSim.cxx,
 * src/FDM/flight.cxx), plus the /environment values FG's environment manager provides,
 * and copies FG controls into JSBSim (copy_to_JSBsim).
 */
import { fgOutputSource } from "@webflight/fdm-core";
import type { PropertyTree, PropRef } from "./props.ts";

/** What fg-host needs from the FDM. `Fdm` from fdm-core satisfies it. */
export interface FdmLike {
  get(property: string): number;
  set(property: string, value: number): void;
}

const R2D = 180 / Math.PI;
const FPS_TO_KT = 0.5924838;
const PSF_TO_INHG = 1 / 70.7262;
const FT_TO_M = 0.3048;

export interface EnvironmentOptions {
  /** Magnetic variation [deg, east positive]. FG uses the World Magnetic Model; default 0. */
  magneticVariationDeg?: number;
}

type Copy = { to: PropRef; from: () => number };

export class FdmInterface {
  private readonly copies: Copy[] = [];
  private readonly controlsIn: { from: PropRef; to: string; scale: number }[] = [];
  private readonly hostIn: { ref: PropRef; path: string }[] = [];
  private readonly hostOut: { ref: PropRef; path: string }[] = [];

  constructor(
    private readonly tree: PropertyTree,
    private readonly fdm: FdmLike,
    private readonly gearCount: number,
    private readonly env: EnvironmentOptions = {},
    hostInputs: readonly string[] = [],
    hostOutputs: readonly string[] = [],
  ) {
    // In FlightGear JSBSim's absolute paths are the FG tree itself; here they are two
    // stores, so FG-owned inputs are copied in before each step and outputs back after.
    for (const p of hostInputs) this.hostIn.push({ ref: tree.node(p), path: p });
    for (const p of hostOutputs) this.hostOut.push({ ref: tree.node(p), path: p });
    const j = (name: string, scale = 1) => () => fdm.get(name) * scale;
    const add = (path: string, from: () => number) => this.copies.push({ to: tree.node(path), from });
    const varDeg = env.magneticVariationDeg ?? 0;
    const heading = () => fdm.get("attitude/psi-deg");

    // /position
    add("/position/latitude-deg", j("position/lat-geod-deg"));
    add("/position/longitude-deg", j("position/long-gc-deg"));
    add("/position/altitude-ft", j("position/geod-alt-ft"));
    add("/position/altitude-agl-ft", j("position/h-agl-ft"));
    add("/position/ground-elev-ft", j("position/terrain-elevation-asl-ft"));
    add("/position/ground-elev-m", j("position/terrain-elevation-asl-ft", FT_TO_M));
    add("/environment/ground-elevation-m", j("position/terrain-elevation-asl-ft", FT_TO_M));
    // /orientation
    add("/orientation/roll-deg", j("attitude/phi-deg"));
    add("/orientation/pitch-deg", j("attitude/theta-deg"));
    add("/orientation/heading-deg", heading);
    add("/orientation/true-heading-deg", heading);
    add("/orientation/heading-magnetic-deg", () => (((heading() - varDeg) % 360) + 360) % 360);
    add("/orientation/track-deg", j("flight-path/psi-gt-rad", R2D));
    add("/orientation/path-deg", j("flight-path/gamma-deg"));
    add("/orientation/roll-rate-degps", j("velocities/phidot-rad_sec", R2D));
    add("/orientation/pitch-rate-degps", j("velocities/thetadot-rad_sec", R2D));
    add("/orientation/yaw-rate-degps", j("velocities/psidot-rad_sec", R2D));
    add("/orientation/p-body", j("velocities/p-rad_sec", R2D));
    add("/orientation/q-body", j("velocities/q-rad_sec", R2D));
    add("/orientation/r-body", j("velocities/r-rad_sec", R2D));
    add("/orientation/alpha-deg", j("aero/alpha-deg"));
    add("/orientation/side-slip-deg", j("aero/beta-deg"));
    add("/orientation/side-slip-rad", j("aero/beta-rad"));
    // /velocities (FG's airspeed-kt is calibrated airspeed)
    add("/velocities/airspeed-kt", j("velocities/vc-kts"));
    add("/velocities/equivalent-kt", j("velocities/ve-kts"));
    add("/velocities/groundspeed-kt", j("velocities/vg-fps", FPS_TO_KT));
    add("/velocities/mach", j("velocities/mach"));
    add("/velocities/speed-north-fps", j("velocities/v-north-fps"));
    add("/velocities/speed-east-fps", j("velocities/v-east-fps"));
    add("/velocities/speed-down-fps", j("velocities/v-down-fps"));
    add("/velocities/uBody-fps", j("velocities/u-fps"));
    add("/velocities/vBody-fps", j("velocities/v-fps"));
    add("/velocities/wBody-fps", j("velocities/w-fps"));
    add("/velocities/vertical-speed-fps", j("velocities/v-down-fps", -1));
    // /accelerations
    add("/accelerations/nlf", j("accelerations/Nz"));
    add("/accelerations/pilot/x-accel-fps_sec", j("accelerations/a-pilot-x-ft_sec2"));
    add("/accelerations/pilot/y-accel-fps_sec", j("accelerations/a-pilot-y-ft_sec2"));
    add("/accelerations/pilot/z-accel-fps_sec", j("accelerations/a-pilot-z-ft_sec2"));
    // pilot-g: load factor at the pilot station, +1 in level flight.
    add("/accelerations/pilot-g", j("accelerations/n-pilot-z-norm", -1));
    // /environment (from JSBSim's atmosphere, which FG would normally drive)
    add("/environment/pressure-inhg", j("atmosphere/P-psf", PSF_TO_INHG));
    add("/environment/pressure-sea-level-inhg", j("atmosphere/P-sl-psf", PSF_TO_INHG));
    add("/environment/temperature-degc", () => ((fdm.get("atmosphere/T-R") - 491.67) * 5) / 9);
    add("/environment/density-slugft3", j("atmosphere/rho-slugs_ft3"));
    add("/environment/wind-speed-kt", () => Math.hypot(fdm.get("atmosphere/wind-north-fps"), fdm.get("atmosphere/wind-east-fps")) * FPS_TO_KT);
    add("/environment/wind-from-heading-deg", () => {
      const n = fdm.get("atmosphere/wind-north-fps"), e = fdm.get("atmosphere/wind-east-fps");
      return n === 0 && e === 0 ? 0 : (((Math.atan2(-e, -n) * R2D) % 360) + 360) % 360;
    });
    add("/environment/magnetic-variation-deg", () => varDeg);
    // Centred-dipole dip (no World Magnetic Model): tan(dip) = 2 tan(magnetic latitude).
    add("/environment/magnetic-dip-deg", () => Math.atan(2 * Math.tan((fdm.get("position/lat-geod-deg") * Math.PI) / 180)) * R2D);

    // /surface-positions and /gear via the fdm-core bridge (same conventions as the renderer).
    for (const s of ["elevator", "left-aileron", "right-aileron", "rudder", "flap", "speedbrake", "spoilers"]) {
      const fg = `/surface-positions/${s}-pos-norm`;
      const src = fgOutputSource(fg);
      if (src) add(fg, j(src.jsbsim, src.scale));
    }
    for (let n = 0; n < gearCount; n++) {
      const base = n === 0 ? "/gear/gear" : `/gear/gear[${n}]`;
      const maxFt = () => {
        const ft = tree.num(`${base}/max-compression-ft`), m = tree.num(`${base}/max-compression-m`);
        return ft > 1e-5 ? ft : m > 1e-5 ? m / FT_TO_M : 1;
      };
      for (const k of ["compression-norm", "compression-m", "compression-ft", "rollspeed-ms", "wow"]) {
        const src = fgOutputSource(`${base}/${k}`, maxFt);
        if (src) add(`${base}/${k}`, k === "compression-norm" ? () => fdm.get(src.jsbsim) / maxFt() : j(src.jsbsim, src.scale));
      }
    }

    // copy_to_JSBsim: FG controls → JSBSim commands (note the rudder sign).
    const ctl = (fg: string, js: string, scale = 1) => this.controlsIn.push({ from: tree.node(fg), to: js, scale });
    ctl("/controls/flight/aileron", "fcs/aileron-cmd-norm");
    ctl("/controls/flight/elevator", "fcs/elevator-cmd-norm");
    ctl("/controls/flight/rudder", "fcs/rudder-cmd-norm", -1);
    ctl("/controls/flight/elevator-trim", "fcs/pitch-trim-cmd-norm");
    ctl("/controls/flight/aileron-trim", "fcs/roll-trim-cmd-norm");
    ctl("/controls/flight/rudder-trim", "fcs/yaw-trim-cmd-norm", -1);
    ctl("/controls/flight/flaps", "fcs/flap-cmd-norm");
    ctl("/controls/flight/speedbrake", "fcs/speedbrake-cmd-norm");
    ctl("/controls/flight/spoilers", "fcs/spoiler-cmd-norm");
  }

  /** FG → JSBSim (before stepping the FDM). Only controls that have been written. */
  toFdm(): void {
    for (const c of this.controlsIn) if (c.from.exists) this.fdm.set(c.to, c.from.num() * c.scale);
    for (const h of this.hostIn) if (h.ref.exists) this.fdm.set(h.path, h.ref.num());
  }

  /** JSBSim → FG (after stepping). */
  fromFdm(): void {
    for (const c of this.copies) c.to.set(c.from());
    for (const h of this.hostOut) h.ref.set(this.fdm.get(h.path));
  }
}
