/**
 * JSBSim property names used by this project, checked against the JSBSim v1.2.4 source
 * (file noted per group) and against the runtime property catalog in tests
 * (apps/headless/test/properties.test.ts).
 */
export const P = {
  // FGFDMExec.cpp
  simTime: "simulation/sim-time-sec",

  // models/FGPropagate.cpp
  hSlFt: "position/h-sl-ft",
  hAglFt: "position/h-agl-ft",
  latDeg: "position/lat-geod-deg",
  lonDeg: "position/long-gc-deg",
  /** Read/write: the host writes sampled terrain height here every step. */
  terrainElevationAslFt: "position/terrain-elevation-asl-ft",
  vNorthFps: "velocities/v-north-fps",
  vEastFps: "velocities/v-east-fps",
  vDownFps: "velocities/v-down-fps",
  phiDeg: "attitude/phi-deg",
  thetaDeg: "attitude/theta-deg",
  psiDeg: "attitude/psi-deg",

  // models/FGAuxiliary.cpp
  vcKts: "velocities/vc-kts",
  veKts: "velocities/ve-kts",
  vtrueKts: "velocities/vtrue-kts",
  vgFps: "velocities/vg-fps",
  alphaDeg: "aero/alpha-deg",
  betaDeg: "aero/beta-deg",
  gammaDeg: "flight-path/gamma-deg",

  // models/FGAccelerations.cpp (body-frame derivatives, used as trim residuals)
  udot: "accelerations/udot-ft_sec2",
  wdot: "accelerations/wdot-ft_sec2",
  qdot: "accelerations/qdot-rad_sec2",

  // models/FGAtmosphere.cpp
  sigma: "atmosphere/sigma",

  // models/atmosphere/FGWinds.cpp (read/write; thermals/ridge lift go into wind-down)
  windNorthFps: "atmosphere/wind-north-fps",
  windEastFps: "atmosphere/wind-east-fps",
  windDownFps: "atmosphere/wind-down-fps",

  // models/FGMassBalance.cpp
  weightLbs: "inertia/weight-lbs",
  /** Indexed by <pointmass> order in the aircraft file. */
  pointmassWeightLbs: (i: number) => `inertia/pointmass-weight-lbs[${i}]`,

  // models/FGFCS.cpp
  elevatorCmd: "fcs/elevator-cmd-norm",
  aileronCmd: "fcs/aileron-cmd-norm",
  rudderCmd: "fcs/rudder-cmd-norm",
  pitchTrimCmd: "fcs/pitch-trim-cmd-norm",
  speedbrakeCmd: "fcs/speedbrake-cmd-norm",
} as const;

/**
 * Initial-condition properties (initialization/FGInitialCondition.cpp, bound in
 * FGInitialCondition::bind). Units are in the names.
 */
export type IcProperty =
  | "ic/lat-geod-deg"
  | "ic/long-gc-deg"
  | "ic/h-sl-ft"
  | "ic/h-agl-ft"
  | "ic/terrain-elevation-ft"
  | "ic/vc-kts"
  | "ic/ve-kts"
  | "ic/vt-kts"
  | "ic/gamma-deg"
  | "ic/alpha-deg"
  | "ic/beta-deg"
  | "ic/theta-deg"
  | "ic/phi-deg"
  | "ic/psi-true-deg"
  | "ic/vw-north-fps"
  | "ic/vw-east-fps"
  | "ic/vw-down-fps";

export type InitialConditions = Partial<Record<IcProperty, number>>;

/** Every fixed property name above, for catalog checks. */
export const ALL_FIXED_PROPERTIES: readonly string[] = (Object.values(P) as unknown[]).filter(
  (v): v is string => typeof v === "string",
);

export const FT_PER_M = 1 / 0.3048;
export const M_PER_FT = 0.3048;
export const KMH_PER_KT = 1.852;
export const LBS_PER_KG = 2.2046226218;
