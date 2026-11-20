/**
 * Dynamic resolution. Cesium renders at CSS pixels × `viewer.resolutionScale`; on a Retina
 * screen (2 device pixels per CSS pixel) its default 1.0 is a quarter of the screen's pixels,
 * upscaled: everything soft. The scale follows the frame time between 1.0 and 1.5 (or the
 * screen's pixel ratio if lower), aiming at 60 fps. Measured on the M1 Pro (Brave, clouds on,
 * vsync off): 1.25× costs 8–20% of the frame rate, 1.5× 15–36%, 2× (native) 40–60%; on the
 * runway with grass 1.0× is already about all there is.
 *
 * Frames are judged against 60 fps whatever the display (60 or 120 Hz): one is late past
 * 19 ms (with vsync at 60 Hz, any missed refresh), a visible hitch. More than 4 late frames in
 * the last 2 s: a step down. At most one for 4 s: a step up, probing; a level that just failed
 * is not tried again for 30 s. Counts, not fractions: at 120 fps two tile-streaming hitches
 * were already "1%" and the scale never rose. At most one change every 3 s; each reallocates
 * the frame buffers, a small hitch, so the second after a change is not judged. ?dynres=0:
 * fixed at 1.0; ?dynres=<scale>: fixed at that scale.
 */
import type { Viewer } from "cesium";

const STEP = 0.125;
const LATE_MS = 19;

export class DynamicResolution {
  private readonly frames: { t: number; late: boolean }[] = [];
  private last = 0;
  private changed = 0;
  private calmSince = 0;
  /** Lowest scale that failed recently, and until when it counts. */
  private ceiling = { scale: Infinity, until: 0 };
  readonly max: number;
  readonly min = 1;

  constructor(
    private readonly viewer: Viewer,
    /** Fixed scale instead (no adapting). */
    private readonly fixed?: number,
  ) {
    this.max = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
    viewer.resolutionScale = fixed ?? 1;
  }

  get scale(): number {
    return this.viewer.resolutionScale;
  }

  /** Every frame. `active` false (loading, paused menus): the clock is reset, nothing changes. */
  update(now: number, active: boolean): void {
    const dt = now - this.last;
    this.last = now;
    if (this.fixed !== undefined) return;
    if (!active || dt > 500) {
      this.frames.length = 0;
      this.calmSince = now;
      return;
    }
    // The change itself makes a few late frames (buffers reallocated): not counted against it.
    if (now - this.changed < 1000) return;
    this.frames.push({ t: now, late: dt > LATE_MS });
    while (this.frames.length && now - this.frames[0]!.t > 2000) this.frames.shift();
    if (now - this.changed < 3000 || this.frames.length < 30) return;
    const late = this.frames.reduce((n, f) => n + (f.late ? 1 : 0), 0);
    const sc = this.viewer.resolutionScale;
    if (late > 4) {
      this.calmSince = now;
      if (sc > this.min + 1e-6) {
        this.ceiling = { scale: sc, until: now + 30_000 };
        this.set(Math.max(this.min, sc - STEP), now);
      }
      return;
    }
    if (late > 1) {
      this.calmSince = now;
      return;
    }
    const up = Math.min(this.max, sc + STEP);
    const blocked = up >= this.ceiling.scale - 1e-6 && now < this.ceiling.until;
    if (up > sc + 1e-6 && !blocked && now - this.calmSince > 4000) this.set(up, now);
  }

  private set(scale: number, now: number): void {
    this.viewer.resolutionScale = scale;
    this.changed = now;
    this.calmSince = now;
    this.frames.length = 0;
  }

  reset(): void {
    this.viewer.resolutionScale = 1;
  }
}
