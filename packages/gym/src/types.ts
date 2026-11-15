import type { Environment, TerrariumTerrain } from "@webflight/environment";
import type { Fdm, FgControls } from "@webflight/fdm-core";
import type { Launch } from "@webflight/launch";
import type { RunwayFrame } from "./common.ts";
import type { GymSite } from "./sites.ts";

/** A box: one entry per dimension. */
export interface BoxSpec {
  names: readonly string[];
  low: readonly number[];
  high: readonly number[];
}

export interface StepResult {
  obs: Float64Array;
  reward: number;
  /** The episode ended in a terminal state (landed, crashed, released …). */
  terminated: boolean;
  /** The episode was cut short (time limit, out of bounds). */
  truncated: boolean;
  info: Record<string, unknown>;
}

/** Everything a task can touch during an episode. */
export interface Episode {
  readonly fdm: Fdm;
  /** The episode's airfield, runway in use and weather (from data). */
  readonly site: GymSite;
  /** The runway in use as a frame (threshold of the into-wind direction). */
  readonly runway: RunwayFrame;
  environment: Environment;
  readonly terrain: TerrariumTerrain | undefined;
  /** Ground elevation [m] (frozen terrain; fallback: the site's elevation). */
  groundAt(latDeg: number, lonDeg: number): number;
  /** Controls in FG conventions (+elevator = nose down, +rudder = yaw right, airbrake 0..1). */
  readonly controls: FgControls;
  /** Write ep.controls to JSBSim now (FG → JSBSim mapping). */
  applyControls(): void;
  launch: Launch | undefined;
  /** Episode RNG (seeded by reset). */
  readonly rand: () => number;
  /** Seconds since reset, and decision steps taken. */
  t: number;
  steps: number;
  /** Seconds per decision (action repeat × FDM dt). */
  readonly dt: number;
  /** Task-specific state. */
  state: Record<string, unknown>;
}

export interface Evaluation {
  reward: number;
  terminated: boolean;
  truncated: boolean;
  info: Record<string, unknown>;
}

export interface Task {
  readonly name: string;
  readonly observation: BoxSpec;
  readonly action: BoxSpec;
  /** Maximum episode length [s] (truncation). */
  readonly maxSeconds: number;
  /** Terrain to preload (and freeze) around the episode's runway [m]. */
  readonly terrainRadiusM: number;
  /** Set up a new episode: initial conditions, launch … (FDM is fresh, site and weather set). */
  setup(ep: Episode): void;
  /** Apply an action (already clipped to the action box) to ep.controls / the launch. */
  act(ep: Episode, action: readonly number[]): void;
  /** Called every physics batch (e.g. to update a launch). */
  physics?(ep: Episode, dt: number): void;
  observe(ep: Episode, out: Float64Array): void;
  /** Reward and termination after a decision step. */
  evaluate(ep: Episode): Evaluation;
}
