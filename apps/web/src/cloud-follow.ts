/**
 * The clouds as drawn, following their thermals' gradually: clouds don't jump or pop in or out.
 *
 * What the thermals give changes in steps: when the weather moves on (every simulated minute
 * near, five far, or the weather grid moves) a column's lean and top change at once, and the
 * clouds stepped 40–70 m; FG's thermals restart part-way through their cycle, so a full cloud
 * appeared in one frame; a cloud handed from the page's far sky to the flight model's (~18 km
 * round the glider) came with its cycle elsewhere. Measured in a 5-minute flight over ~600
 * drawn clouds: 231 appeared at full size, 461 stepped. The thermals and their lift are left
 * as they are; only what is drawn follows.
 */
import type { CloudSpec } from "./clouds.ts";

/** Place, base, width and height follow the thermal's with this time constant [s]. */
export const FOLLOW_S = 20;
/**
 * How fast a drawn cloud may grow in or dissolve [s for opacity 0↔1, and for size]. A thermal's
 * own cycle stays within these (a cumulus grows over 3 minutes and dies over 5: scene.ts
 * cloudLife), so they only slow what would otherwise be at once.
 */
export const GROW_S = 90;
export const GROW_SIZE_S = 120;
export const DISSOLVE_S = 120;
export const SHRINK_S = 200;
/**
 * Farther than this from what is drawn, a thermal's cloud is another cloud [m]: the page's far
 * sky and the flight model's place some thermals apart (their terrain detail and the sun when
 * each first had the cell pick another of its candidates), ~2 km. Gliding there would be a
 * cloud racing across the sky: the one drawn dissolves where it is and this one grows in.
 */
export const OTHER_CLOUD_M = 300;

/** Towards `to` by at most `up` (rising) or `down` (falling). */
const approach = (v: number, to: number, up: number, down: number) => (to > v ? Math.min(to, v + up) : Math.max(to, v - down));

/** A thermal's cloud now, and whether the thermal is in the end of its cycle. */
export interface CloudTarget {
  c: CloudSpec;
  dying: boolean;
}

export class DrawnClouds {
  /** By thermal (or, left to dissolve, a name of its own). `hidden`: met dying, no cloud this cycle. */
  private readonly drawn = new Map<string, { c: CloudSpec; hidden: boolean }>();
  /** Clouds left to dissolve where they were drawn: a count to name them. */
  private others = 0;

  get size(): number {
    return this.drawn.size;
  }

  /**
   * The clouds to draw after `dt` seconds, given the thermals' clouds now. `snap`: draw them as
   * they are (the sky being made: loading, a jump of the camera).
   */
  update(targets: CloudTarget[], dt: number, snap: boolean): CloudSpec[] {
    const a = 1 - Math.exp(-dt / FOLLOW_S), ease = (v: number, to: number) => v + (to - v) * a;
    const seen = new Set<string>();
    for (const { c, dying } of targets) {
      seen.add(c.id);
      let d = this.drawn.get(c.id);
      if (d && !snap && Math.hypot((c.latDeg - d.c.latDeg) * 111_195, (c.lonDeg - d.c.lonDeg) * 111_195 * Math.cos((c.latDeg * Math.PI) / 180)) > OTHER_CLOUD_M) {
        // Another cloud: the one drawn stays to dissolve (not seen: below), under its own name.
        this.drawn.set(`${c.id}~${++this.others}`, d);
        d = undefined;
      }
      if (snap || !d) {
        // New: as it is while the sky is being made; else from nothing (and none for one met
        // dying: it would form only to dissolve). Named apart from one left dissolving, so each
        // keeps its own shape (vclouds.ts cloudGeometry).
        this.drawn.set(c.id, snap ? { c: { ...c }, hidden: false } : { c: { ...c, id: `${c.id}/${this.others}`, size: Math.min(c.size, 0.2), opacity: 0 }, hidden: dying });
        continue;
      }
      if (d.hidden && !dying) d.hidden = false;
      const g = d.c;
      g.latDeg = ease(g.latDeg, c.latDeg);
      g.lonDeg = ease(g.lonDeg, c.lonDeg);
      g.baseM = ease(g.baseM, c.baseM);
      g.radiusM = ease(g.radiusM, c.radiusM);
      if (c.groundM !== undefined) g.groundM = g.groundM === undefined ? c.groundM : ease(g.groundM, c.groundM);
      if (c.tall !== undefined) g.tall = g.tall === undefined ? c.tall : ease(g.tall, c.tall);
      g.opacity = approach(g.opacity, d.hidden ? 0 : c.opacity, dt / GROW_S, dt / DISSOLVE_S);
      if (!d.hidden) g.size = approach(g.size, c.size, dt / GROW_SIZE_S, dt / SHRINK_S);
    }
    // Gone from the thermals (its cell out of the sky's reach, a thermal dropped): dissolves.
    for (const [id, d] of this.drawn)
      if (!seen.has(id)) {
        d.c.opacity = snap ? 0 : Math.max(0, d.c.opacity - dt / DISSOLVE_S);
        if (d.c.opacity <= 0) this.drawn.delete(id);
      }
    const out: CloudSpec[] = [];
    for (const d of this.drawn.values()) if (d.c.size > 0 && d.c.opacity > 0) out.push({ ...d.c });
    return out;
  }
}
