/**
 * Fixed-layout snapshot of selected JSBSim properties, published by the FDM thread every
 * step and read by the renderer every frame.
 *
 * Buffer layout: Int32 [seq, count], then `count` Float64 values. With a SharedArrayBuffer
 * the writer uses a sequence lock (seq odd while writing); readers retry on a torn read.
 * Without one the same buffer is copied through postMessage.
 */

/** Properties every snapshot carries (pose, HUD). Checked against the catalog in tests. */
export const SNAPSHOT_CORE = [
  "simulation/sim-time-sec",
  "position/lat-geod-deg",
  "position/long-gc-deg",
  "position/geod-alt-ft",
  "position/h-agl-ft",
  "attitude/phi-rad",
  "attitude/theta-rad",
  "attitude/psi-rad",
  "inertia/cg-x-in",
  "inertia/cg-y-in",
  "inertia/cg-z-in",
  "metrics/visualrefpoint-x-in",
  "metrics/visualrefpoint-y-in",
  "metrics/visualrefpoint-z-in",
  "velocities/vc-kts",
  "velocities/vtrue-kts",
  "velocities/v-down-fps",
  "velocities/vg-fps",
  "aero/alpha-deg",
  "aero/beta-deg",
] as const;

export type CoreName = (typeof SNAPSHOT_CORE)[number];

const HEADER_BYTES = 8;

export function snapshotBytes(count: number): number {
  return HEADER_BYTES + count * 8;
}

export class SnapshotLayout {
  readonly index = new Map<string, number>();
  constructor(readonly names: readonly string[]) {
    names.forEach((n, i) => this.index.set(n, i));
  }
  /** Core properties first, then extras (deduplicated). */
  static withExtras(extra: readonly string[]): SnapshotLayout {
    return new SnapshotLayout([...new Set<string>([...SNAPSHOT_CORE, ...extra])]);
  }
  at(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`snapshot has no ${name}`);
    return i;
  }
}

export class SnapshotWriter {
  private readonly header: Int32Array;
  private readonly values: Float64Array;
  constructor(
    readonly buffer: SharedArrayBuffer | ArrayBuffer,
    readonly layout: SnapshotLayout,
  ) {
    this.header = new Int32Array(buffer, 0, 2);
    this.values = new Float64Array(buffer, HEADER_BYTES, layout.names.length);
    this.header[1] = layout.names.length;
  }

  write(get: (name: string) => number): void {
    const shared = typeof SharedArrayBuffer !== "undefined" && this.buffer instanceof SharedArrayBuffer;
    if (shared) Atomics.add(this.header, 0, 1); // odd: writing
    const names = this.layout.names;
    for (let i = 0; i < names.length; i++) this.values[i] = get(names[i]!);
    if (shared) Atomics.add(this.header, 0, 1); // even: consistent
    else this.header[0]! += 2;
  }
}

export class SnapshotReader {
  private readonly header: Int32Array;
  private readonly values: Float64Array;
  /** Last consistent copy. */
  readonly data: Float64Array;
  private seen = 0; // seq 0 = never written
  constructor(
    buffer: SharedArrayBuffer | ArrayBuffer,
    readonly layout: SnapshotLayout,
  ) {
    this.header = new Int32Array(buffer, 0, 2);
    this.values = new Float64Array(buffer, HEADER_BYTES, layout.names.length);
    this.data = new Float64Array(layout.names.length);
  }

  /** Copy the latest consistent values into `data`. Returns false if nothing new. */
  read(): boolean {
    for (let tries = 0; tries < 8; tries++) {
      const s1 = Atomics.load(this.header, 0);
      if (s1 & 1) continue;
      if (s1 === this.seen) return false;
      this.data.set(this.values);
      if (Atomics.load(this.header, 0) === s1) {
        this.seen = s1;
        return true;
      }
    }
    return false;
  }

  get(name: string): number {
    return this.data[this.layout.at(name)]!;
  }
}
