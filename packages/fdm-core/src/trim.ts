/**
 * Steady, wings-level glide trim for unpowered aircraft.
 *
 * JSBSim's tLongitudinal trim drives udot to zero with the throttle, so it reports
 * "udot doesn't appear to be trimmable" for a glider. Here the flight-path angle is a
 * free variable instead: solve
 *     udot = wdot = qdot = 0
 * for (alpha, gamma, pitch control) at a given airspeed with Newton's method,
 * evaluating JSBSim's own derivatives via RunIC (FCS in trim mode).
 */
import type { Fdm } from "./fdm.ts";
import { P, type InitialConditions } from "./props.ts";

export interface GlideTrimOptions {
  /** Airspeed to trim at. Exactly one of these. */
  speed: { veKts: number } | { vcKts: number } | { vtKts: number };
  /** Position, altitude, heading, wind. Speed/angles are set by the trim. */
  base: InitialConditions;
  /** Control solved for. Default fcs/pitch-trim-cmd-norm (stick stays neutral). */
  control?: string;
  controlRange?: readonly [number, number];
  /** Initial guess. */
  guess?: { alphaDeg?: number; gammaDeg?: number; control?: number };
  maxIterations?: number;
  /** Convergence on |udot|,|wdot| [ft/s²] and |qdot| [rad/s²]. */
  tolerance?: number;
}

export interface GlideTrimResult {
  converged: boolean;
  iterations: number;
  alphaDeg: number;
  gammaDeg: number;
  thetaDeg: number;
  control: number;
  /** Control hit its range limit. */
  saturated: boolean;
  residual: { udot: number; wdot: number; qdot: number };
  /** Steady-glide values from the trimmed state. */
  vcKts: number;
  veKts: number;
  vtrueKts: number;
  sinkFps: number;
  glideRatio: number;
}

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-14) throw new Error("singular trim Jacobian");
    for (let r = c + 1; r < 3; r++) {
      const f = m[r]![c]! / d;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = m[r]![3]!;
    for (let k = r + 1; k < 3; k++) s -= m[r]![k]! * x[k]!;
    x[r] = s / m[r]![r]!;
  }
  return x;
}

export function trimSteadyGlide(fdm: Fdm, opts: GlideTrimOptions): GlideTrimResult {
  const control = opts.control ?? P.pitchTrimCmd;
  const [cMin, cMax] = opts.controlRange ?? [-1, 1];
  const tol = opts.tolerance ?? 1e-5;
  const maxIt = opts.maxIterations ?? 30;
  const speedIc: InitialConditions =
    "veKts" in opts.speed ? { "ic/ve-kts": opts.speed.veKts }
    : "vcKts" in opts.speed ? { "ic/vc-kts": opts.speed.vcKts }
    : { "ic/vt-kts": opts.speed.vtKts };

  const evaluate = (x: readonly number[]): [number, number, number] => {
    fdm.setInitialConditions({ ...opts.base, ...speedIc, "ic/phi-deg": 0, "ic/beta-deg": 0, "ic/alpha-deg": x[0]!, "ic/gamma-deg": x[1]! });
    fdm.set(control, x[2]!);
    fdm.runIc();
    return [fdm.get(P.udot), fdm.get(P.wdot), fdm.get(P.qdot)];
  };
  // qdot is in rad/s²; weight it so the three residuals are comparable.
  const norm = (f: readonly number[]) => Math.max(Math.abs(f[0]!), Math.abs(f[1]!), Math.abs(f[2]!) * 10);

  let x = [opts.guess?.alphaDeg ?? 2, opts.guess?.gammaDeg ?? -2, opts.guess?.control ?? 0];
  let f: [number, number, number] = [0, 0, 0];
  let it = 0;
  let saturated = false;
  fdm.setTrimStatus(true);
  try {
    f = evaluate(x);
    for (; it < maxIt && norm(f) > tol; it++) {
      const h = [1e-3, 1e-3, 1e-4];
      const J: number[][] = [[], [], []]; // J[i][j] = d f_i / d x_j
      for (let j = 0; j < 3; j++) {
        const xp = [...x];
        xp[j]! += h[j]!;
        const fp = evaluate(xp);
        for (let i = 0; i < 3; i++) J[i]![j] = (fp[i]! - f[i]!) / h[j]!;
      }
      const dx = solve3(J, f.map((v) => -v));
      // Damped step with backtracking on the residual norm.
      let lambda = 1;
      let next = x;
      let fNext = f;
      for (let k = 0; k < 8; k++) {
        next = x.map((v, i) => v + lambda * dx[i]!);
        next[0] = Math.min(Math.max(next[0]!, -10), 25);
        next[1] = Math.min(Math.max(next[1]!, -60), 10);
        next[2] = Math.min(Math.max(next[2]!, cMin), cMax);
        fNext = evaluate(next);
        if (norm(fNext) < norm(f)) break;
        lambda /= 2;
      }
      x = next;
      f = fNext;
    }
    saturated = x[2]! <= cMin + 1e-9 || x[2]! >= cMax - 1e-9;
  } finally {
    fdm.setTrimStatus(false);
  }
  // Leave the FDM at the trimmed state with the FCS out of trim mode.
  f = evaluate(x);
  const sink = fdm.get(P.vDownFps);
  return {
    converged: norm(f) <= tol * 10 && !saturated,
    iterations: it,
    alphaDeg: fdm.get(P.alphaDeg),
    gammaDeg: fdm.get(P.gammaDeg),
    thetaDeg: fdm.get(P.thetaDeg),
    control: x[2]!,
    saturated,
    residual: { udot: f[0], wdot: f[1], qdot: f[2] },
    vcKts: fdm.get(P.vcKts),
    veKts: fdm.get(P.veKts),
    vtrueKts: fdm.get(P.vtrueKts),
    sinkFps: sink,
    glideRatio: fdm.get(P.vgFps) / sink,
  };
}
