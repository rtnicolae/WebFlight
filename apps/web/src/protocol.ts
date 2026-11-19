/** Messages between the main thread and the FDM worker. */
import type { FgControls, InitialConditions } from "@webflight/fdm-core";

export interface StartState {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  aglM: number;
  easKmh: number;
  /** Start standing on the ground (aglM/easKmh ignored), optionally with a launch set up. */
  ground?: { launch?: "winch" | "aerotow"; winchType?: 0 | 1; seed?: number };
}

/** The world the FDM flies in (the worker owns terrain and air motion for physics). */
export interface WorldConfig {
  /** "terrarium": real terrain from Terrarium tiles; "flat": the WGS84 ellipsoid. */
  terrain: "terrarium" | "flat";
  environment: import("@webflight/environment").EnvironmentConfig;
}

/** One thermal as drawn by the renderer. */
export interface ThermalView {
  /** Stable id (the same thermal keeps it while it exists). */
  id: string;
  latDeg: number;
  lonDeg: number;
  /** Cloud base / thermal top [m]. */
  topM: number;
  groundM: number;
  radiusM: number;
  strengthMs: number;
  phase: "forming" | "formed" | "dying" | "dead";
  /** Seconds into its life cycle (FG's cycle timer: forming 0–300, formed –1200, dying –1500, dead –1800). */
  cycleS?: number;
}

export type ToWorker =
  | {
      type: "init";
      bundleUrl: string;
      jsbsimModuleUrl: string;
      jsbsimWasmUrl: string;
      rateHz: number;
      /** JSBSim properties to publish besides the core set. */
      extraProperties: string[];
      start: StartState;
      world: WorldConfig;
      loadout: Record<number, number>;
      /** false forces the postMessage snapshot path (testing). */
      allowShared: boolean;
    }
  | { type: "controls"; controls: FgControls }
  /** Raw JSBSim property writes, e.g. position/terrain-elevation-asl-ft. */
  | { type: "set"; props: Record<string, number> }
  /** Launch: clutch the winch / start the tow plane; open the hook; winch faster/slower. */
  | { type: "launch"; action: "start" | "release" | "faster" | "slower" }
  /** The mountain-wave field round the aircraft (wave-worker.ts), replacing any before. */
  | { type: "waves"; field: import("@webflight/environment").WaveFieldData }
  /** Change the wind (other environment settings stay). */
  | { type: "wind"; fromDeg: number; kt: number }
  | { type: "reset"; start: StartState }
  | { type: "pause"; paused: boolean }
  /** Cockpit interaction: run an <action>/<increase>/<decrease> element's bindings. */
  | { type: "action"; action: import("@webflight/fdm-core").PNode; phase: "down" | "up"; offset?: number }
  /** Write an FG property (e.g. a switch from the UI). */
  | { type: "setprop"; path: string; value: number | boolean | string };

export type FromWorker =
  | { type: "ready"; names: string[]; shared: SharedArrayBuffer | null; trim: { pitchTrim: number; alphaDeg: number; converged: boolean } }
  /** Only when SharedArrayBuffer is unavailable. */
  | { type: "snapshot"; buffer: ArrayBuffer }
  | { type: "stats"; stepsPerSecond: number; simTime: number; lagMs: number }
  | { type: "log"; line: string }
  /** About once a second: thermals and the air at the aircraft. */
  /** windFromDeg/windKt: the wind at the aircraft; surfaceFromDeg/surfaceKt: the 10 m wind. */
  | { type: "environment"; thermals: ThermalView[]; windFromDeg: number; windKt: number; surfaceFromDeg: number; surfaceKt: number; thermalLiftMs: number; ridgeLiftMs: number; waveLiftMs?: number; groundM: number | undefined }
  /** Pilot messages (screen.log / popupTip in FG). */
  | { type: "messages"; lines: string[] }
  | { type: "error"; message: string };

export type IcFromStart = (s: StartState) => InitialConditions;
