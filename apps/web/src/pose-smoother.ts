/**
 * Smooth motion on screen from the flight model's steps. The FDM steps at 120 Hz in its worker
 * (setTimeout pacing, catching up in batches), the page draws at whatever the display and GPU
 * allow (60–120 Hz, uneven): drawing the latest snapshot each frame moved the glider by 0, 1 or
 * 2 steps from one frame to the next. Its speed on screen jumped by 13–17 m/s every frame at
 * 29 m/s, and the chase camera, fixed to it, shook the whole world.
 *
 * Here every frame records the snapshot's simulation time and the pose channels (positions and
 * attitudes: the glider's, the tug's, the rope's ends), and the frame is drawn at a render clock
 * that runs with the wall clock and is pulled gently towards the newest simulation time less a
 * small lag, so it always has two samples round it: the pose channels are interpolated there
 * (angles the short way round). Everything else (controls, wheels, hitches, instruments) is the
 * newest value. The glider is drawn ~20 ms behind the flight model: not noticeable at 29 m/s.
 */
import type { SnapshotLayout } from "@webflight/fdm-core";

/** Channels moved smoothly: positions, and angles in radians or degrees (unwrapped). */
const LINEAR = [
  "position/lat-geod-deg",
  "position/long-gc-deg",
  "position/geod-alt-ft",
  "position/h-agl-ft",
  "attitude/theta-rad",
  "/ai/models/dragger/position/latitude-deg",
  "/ai/models/dragger/position/longitude-deg",
  "/ai/models/dragger/position/altitude-ft",
  "/sim/hitches/rope/start-lat-deg",
  "/sim/hitches/rope/start-lon-deg",
  "/sim/hitches/rope/start-alt-m",
  "/sim/hitches/rope/end-lat-deg",
  "/sim/hitches/rope/end-lon-deg",
  "/sim/hitches/rope/end-alt-m",
];
const ANGLES_RAD = ["attitude/phi-rad", "attitude/psi-rad"];
const ANGLES_DEG = ["/ai/models/dragger/orientation/true-heading-deg", "/ai/models/dragger/orientation/roll-deg"];
const TIME = "simulation/sim-time-sec";
/** The render clock trails the newest sample by this [s] (about a frame and a half). */
const LAG_S = 0.025;
/** Samples kept [count]: half a second at 120 frames a second. */
const KEEP = 64;

export class PoseSmoother {
  private readonly idx: { i: number; kind: 0 | 1 | 2 }[] = [];
  private readonly timeIdx: number | undefined;
  private readonly times: number[] = [];
  private readonly vals: Float64Array[] = [];
  private renderT = Number.NaN;
  private readonly out: Float64Array;

  constructor(layout: SnapshotLayout) {
    this.timeIdx = layout.index.get(TIME);
    const add = (names: string[], kind: 0 | 1 | 2) => {
      for (const n of names) {
        const i = layout.index.get(n);
        if (i !== undefined) this.idx.push({ i, kind });
      }
    };
    add(LINEAR, 0);
    add(ANGLES_RAD, 1);
    add(ANGLES_DEG, 2);
    this.out = new Float64Array(layout.names.length);
  }

  /** The snapshot to draw this frame: the newest, with the pose channels at the render clock. */
  frame(data: Float64Array, dtS: number): Float64Array {
    this.out.set(data);
    if (this.timeIdx === undefined) return this.out;
    const t = data[this.timeIdx]!;
    const last = this.times.length ? this.times[this.times.length - 1]! : Number.NaN;
    // A reset (time back) or a long gap: start over from here.
    if (!(t >= last - 1e-9) || t - last > 1) {
      this.times.length = 0;
      this.vals.length = 0;
      this.renderT = Number.NaN;
    }
    if (!this.times.length || t > this.times[this.times.length - 1]! + 1e-9) {
      this.times.push(t);
      this.vals.push(Float64Array.from(this.idx, ({ i }) => data[i]!));
      if (this.times.length > KEEP) {
        this.times.shift();
        this.vals.shift();
      }
    }
    // The render clock: the wall clock's pace, drawn towards (newest - lag) within ~0.2 s.
    const target = this.times[this.times.length - 1]! - LAG_S;
    if (Number.isNaN(this.renderT) || Math.abs(target - this.renderT) > 0.5) this.renderT = target;
    else this.renderT += dtS + (target - this.renderT) * Math.min(1, dtS * 5);
    const rt = Math.min(this.renderT, this.times[this.times.length - 1]!);
    // The two samples round it (the newest if it is past them, the oldest if before).
    let k = this.times.length - 1;
    while (k > 0 && this.times[k - 1]! > rt) k--;
    if (k === 0 || this.times[k]! <= rt) return this.out;
    const ta = this.times[k - 1]!, tb = this.times[k]!, f = (rt - ta) / (tb - ta);
    const a = this.vals[k - 1]!, b = this.vals[k]!;
    this.idx.forEach(({ i, kind }, j) => {
      let d = b[j]! - a[j]!;
      if (kind === 1) d = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      else if (kind === 2) d = ((((d + 180) % 360) + 360) % 360) - 180;
      this.out[i] = a[j]! + f * d;
    });
    return this.out;
  }
}
