/**
 * Ridge (slope) lift, ported from FlightGear's FGRidgeLift (src/Environment/ridge_lift.cxx,
 * GPL-2.0+): five terrain probes along the wind (0, 250, 750, 2000 m upwind and 100 m
 * downwind) give four slopes; their shaped sum times the surface wind speed is the lift,
 * scaled by height above ground and low-pass filtered.
 */
import { advance, lowPass } from "./util.ts";

const DIST_PROBE_M = [0, 250, 750, 2000, -100];
const BOUNDARY1_M = 40;
const KT_TO_MPS = 1852 / 3600;
const M_TO_FT = 1 / 0.3048;

export interface RidgeInput {
  latDeg: number;
  lonDeg: number;
  /** Ground elevation under the aircraft [m]. */
  groundElevM: number;
  aglM: number;
  windFromDeg: number;
  windKt: number;
}

export class RidgeLift {
  /** Current ridge lift [ft/s] (FG: /environment/ridge-lift-fps). */
  strengthFps = 0;
  liftFactor = 0;
  readonly probeElevM = [0, 0, 0, 0, 0];
  readonly slope = [0, 0, 0, 0];
  private timer = 0;

  constructor(private readonly heightAt: (latDeg: number, lonDeg: number) => number | undefined) {}

  update(dt: number, s: RidgeInput): number {
    if (dt <= 0) return this.strengthFps;
    this.timer -= dt;
    if (this.timer <= 0) {
      const p = this.probeElevM;
      p[0] = s.groundElevM;
      for (let i = 1; i < 5; i++) {
        const [lat, lon] = advance(s.latDeg, s.lonDeg, s.windFromDeg, DIST_PROBE_M[i]!);
        p[i] = this.heightAt(lat, lon) ?? p[i - 1]!; // no ground found: previous probe (as FG)
      }
      const sl = this.slope;
      sl[0] = (p[0]! - p[1]!) / DIST_PROBE_M[1]!;
      sl[1] = (p[1]! - p[2]!) / DIST_PROBE_M[2]!;
      sl[2] = (p[2]! - p[3]!) / DIST_PROBE_M[3]!;
      sl[3] = (p[4]! - p[0]!) / -DIST_PROBE_M[4]!;
      const adj = sl.map((x) => Math.sin(Math.atan(5 * Math.pow(Math.abs(x), 1.7))) * Math.sign(x));
      adj[0]! *= 0.2;
      adj[1]! *= 0.2;
      adj[2] = adj[2]! < 0 ? adj[2]! * 0.5 : 0;
      if (adj[0]! >= 0 && adj[3]! < 0) adj[3] = 0;
      else adj[3]! *= 0.2;
      this.liftFactor = adj[0]! + adj[1]! + adj[2]! + adj[3]!;
      this.timer = 1;
    }
    const p = this.probeElevM;
    let boundary2 = 130;
    if (this.liftFactor < 0) boundary2 = Math.max(p[1]!, p[2]!, p[3]!) - p[0]!;
    let aglFactor: number;
    if (s.aglM < BOUNDARY1_M) aglFactor = 0.5 + (0.5 * s.aglM) / BOUNDARY1_M;
    else if (s.aglM < boundary2) aglFactor = 1;
    else aglFactor = Math.exp((-(2 + p[0]! / 2000) * (s.aglM - boundary2)) / Math.max(p[0]!, 200));
    const liftMps = this.liftFactor * s.windKt * KT_TO_MPS * aglFactor;
    this.strengthFps = lowPass(this.strengthFps, liftMps * M_TO_FT, dt);
    return this.strengthFps;
  }
}
