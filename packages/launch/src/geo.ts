/**
 * Geometry for tow ropes: positions as ECEF [m] (WGS84, the same frame as fdm-core's pose),
 * hitch points from body offsets, and rope directions expressed in JSBSim body axes
 * (x nose, y right wing, z down).
 *
 * FlightGear's hitch.nas builds the force direction from course/elevation angles and then
 * rotates by pitch and roll; that is the 3-2-1 Euler rotation used here, done with the full
 * direction cosine matrix from the ECEF rope vector.
 */
import { bodyToNed, geodeticToEcef, nedToEcef, type Vec3 } from "@webflight/fdm-core";

const D2R = Math.PI / 180;
const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F), B = A * (1 - F);

export interface Attitude {
  /** Geodetic position of the reference point (JSBSim: the CG) [deg, deg, m above ellipsoid]. */
  latDeg: number;
  lonDeg: number;
  altM: number;
  /** Euler angles [rad] in the local NED frame. */
  phiRad: number;
  thetaRad: number;
  psiRad: number;
}

export function ecef(latDeg: number, lonDeg: number, altM: number): Vec3 {
  return geodeticToEcef(latDeg * D2R, lonDeg * D2R, altM);
}

/** ECEF → geodetic (Bowring, one iteration is plenty near the surface). */
export function geodetic(p: readonly number[]): { latDeg: number; lonDeg: number; altM: number } {
  const [x, y, z] = p as Vec3;
  const r = Math.hypot(x, y);
  const ep2 = (A * A - B * B) / (B * B);
  const th = Math.atan2(z * A, r * B);
  const lat = Math.atan2(z + ep2 * B * Math.sin(th) ** 3, r - E2 * A * Math.cos(th) ** 3);
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return { latDeg: lat / D2R, lonDeg: Math.atan2(y, x) / D2R, altM: r / Math.cos(lat) - n };
}

/** Body → ECEF rotation (row-major 3×3). */
export function bodyToEcef(a: Attitude): number[] {
  const n = nedToEcef(a.latDeg * D2R, a.lonDeg * D2R);
  const b = bodyToNed(a.phiRad, a.thetaRad, a.psiRad);
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += n[i * 3 + k]! * b[k * 3 + j]!;
  return r;
}

/** A point given in body axes [m] relative to the reference point, in ECEF. */
export function bodyPointEcef(a: Attitude, bodyM: readonly number[]): Vec3 {
  const r = bodyToEcef(a);
  const o = ecef(a.latDeg, a.lonDeg, a.altM);
  return [0, 1, 2].map((i) => o[i]! + r[i * 3]! * bodyM[0]! + r[i * 3 + 1]! * bodyM[1]! + r[i * 3 + 2]! * bodyM[2]!) as Vec3;
}

/** Unit vector from `from` towards `to` (ECEF), in body axes; and the distance [m]. */
export function directionInBody(a: Attitude, from: readonly number[], to: readonly number[]): { dir: Vec3; distM: number } {
  const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const r = bodyToEcef(a);
  // body = Rᵀ · ecef
  const dir = [0, 1, 2].map((j) => (r[j]! * d[0]! + r[3 + j]! * d[1]! + r[6 + j]! * d[2]!) / (len || 1)) as Vec3;
  return { dir, distM: len };
}

/** Unit vector `to - from` in the local NED frame at `at`. */
export function directionInNed(at: { latDeg: number; lonDeg: number }, from: readonly number[], to: readonly number[]): Vec3 {
  const n = nedToEcef(at.latDeg * D2R, at.lonDeg * D2R);
  const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  return [0, 1, 2].map((j) => (n[j]! * d[0]! + n[3 + j]! * d[1]! + n[6 + j]! * d[2]!) / len) as Vec3;
}

export const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * Move `distM` along `courseDeg` on the WGS84 ellipsoid (meridian/prime-vertical radii of
 * curvature), so the result agrees with ECEF distances to within millimetres over a
 * kilometre (a spherical step is off by up to 0.3 %, enough to fail FG's rope-length check).
 */
export function offset(latDeg: number, lonDeg: number, courseDeg: number, distM: number): [number, number] {
  const lat = latDeg * D2R, c = courseDeg * D2R;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  const m = (A * (1 - E2)) / (w * w * w), n = A / w;
  // Midpoint latitude for the second-order step.
  const dLat1 = (distM * Math.cos(c)) / m;
  const latMid = lat + dLat1 / 2;
  const sm = Math.sin(latMid), wm = Math.sqrt(1 - E2 * sm * sm);
  const mm = (A * (1 - E2)) / (wm * wm * wm), nm = A / wm;
  void n;
  return [(lat + (distM * Math.cos(c)) / mm) / D2R, lonDeg + (distM * Math.sin(c)) / (nm * Math.cos(latMid)) / D2R];
}
