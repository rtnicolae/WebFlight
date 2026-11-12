/** Messages between the main thread and the FDM worker. */
import type { FgControls, InitialConditions } from "@webflight/fdm-core";

export interface StartState {
  latDeg: number;
  lonDeg: number;
  headingDeg: number;
  aglM: number;
  easKmh: number;
  /** Ground height ASL under the start point [m] (terrain sampled by the renderer). */
  terrainM: number;
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
      loadout: Record<number, number>;
      /** false forces the postMessage snapshot path (testing). */
      allowShared: boolean;
    }
  | { type: "controls"; controls: FgControls }
  /** Raw JSBSim property writes, e.g. position/terrain-elevation-asl-ft. */
  | { type: "set"; props: Record<string, number> }
  | { type: "reset"; start: StartState }
  | { type: "pause"; paused: boolean };

export type FromWorker =
  | { type: "ready"; names: string[]; shared: SharedArrayBuffer | null; trim: { pitchTrim: number; alphaDeg: number; converged: boolean } }
  /** Only when SharedArrayBuffer is unavailable. */
  | { type: "snapshot"; buffer: ArrayBuffer }
  | { type: "stats"; stepsPerSecond: number; simTime: number; lagMs: number }
  | { type: "log"; line: string }
  | { type: "error"; message: string };

export type IcFromStart = (s: StartState) => InitialConditions;
