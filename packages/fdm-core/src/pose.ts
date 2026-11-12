/**
 * Aircraft pose → ECEF model matrix for the visual model (glTF written in AC3D axes).
 *
 * Matches FlightGear: the model origin is JSBSim's visual reference point (VRP), and the
 * attitude is JSBSim's Euler angles in the local NED frame, which JSBSim defines with the
 * geodetic latitude on the WGS84 ellipsoid (math/FGLocation.cpp). ECEF axes are the same
 * as Cesium's (x through 0°N 0°E, z north).
 */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
const E2 = WGS84_F * (2 - WGS84_F);
const FT = 0.3048;

export type Vec3 = [number, number, number];

export function geodeticToEcef(latRad: number, lonRad: number, hM: number): Vec3 {
  const sl = Math.sin(latRad), cl = Math.cos(latRad);
  const n = WGS84_A / Math.sqrt(1 - E2 * sl * sl);
  return [(n + hM) * cl * Math.cos(lonRad), (n + hM) * cl * Math.sin(lonRad), (n * (1 - E2) + hM) * sl];
}

/** Row-major 3x3. */
type M3 = number[];
const mul = (a: M3, b: M3): M3 => {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
};
const apply = (m: M3, v: readonly number[]): Vec3 => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
];

/** NED (geodetic) → ECEF; columns are N, E, D. Same as JSBSim's Tl2ec. */
export function nedToEcef(latRad: number, lonRad: number): M3 {
  const sf = Math.sin(latRad), cf = Math.cos(latRad), sl = Math.sin(lonRad), cl = Math.cos(lonRad);
  return [-sf * cl, -sl, -cf * cl, -sf * sl, cl, -cf * sl, cf, 0, -sf];
}

/** Body → NED from 3-2-1 Euler angles (psi, theta, phi). */
export function bodyToNed(phi: number, theta: number, psi: number): M3 {
  const cph = Math.cos(phi), sph = Math.sin(phi), cth = Math.cos(theta), sth = Math.sin(theta), cps = Math.cos(psi), sps = Math.sin(psi);
  return [
    cth * cps, sph * sth * cps - cph * sps, cph * sth * cps + sph * sps,
    cth * sps, sph * sth * sps + cph * cps, cph * sth * sps - sph * cps,
    -sth, sph * cth, cph * cth,
  ];
}

/**
 * glTF/AC3D axes → JSBSim body axes. AC (x aft, y up, z left) → FG model (x aft, y right,
 * z up) = (x, -z, y) → body (x fwd, y right, z down) = (-x, y, -z) of FG.
 */
export const AC_TO_BODY: M3 = [-1, 0, 0, 0, 0, -1, 0, -1, 0];

/** Structural (inches, x aft, y right, z up) offset → body frame (feet), as FGMassBalance::StructuralToBody. */
export function structuralToBodyFt(point: readonly number[], cg: readonly number[]): Vec3 {
  return [-(point[0]! - cg[0]!) / 12, (point[1]! - cg[1]!) / 12, -(point[2]! - cg[2]!) / 12];
}

export interface PoseInput {
  latGeodRad: number;
  lonRad: number;
  geodAltFt: number;
  phiRad: number;
  thetaRad: number;
  psiRad: number;
  /** VRP relative to the CG in body axes [ft]. */
  vrpBodyFt: readonly number[];
}

/**
 * Column-major 4x4 (Cesium/glTF order) mapping glTF model coordinates [m] to ECEF [m].
 */
export function modelMatrixEcef(p: PoseInput, out: Float64Array = new Float64Array(16)): Float64Array {
  const rEN = nedToEcef(p.latGeodRad, p.lonRad);
  const rEB = mul(rEN, bodyToNed(p.phiRad, p.thetaRad, p.psiRad));
  const r = mul(rEB, AC_TO_BODY);
  const cg = geodeticToEcef(p.latGeodRad, p.lonRad, p.geodAltFt * FT);
  const off = apply(rEB, p.vrpBodyFt.map((v) => v * FT));
  const t = [cg[0] + off[0], cg[1] + off[1], cg[2] + off[2]];
  for (let c = 0; c < 3; c++) {
    for (let rr = 0; rr < 3; rr++) out[c * 4 + rr] = r[rr * 3 + c]!;
    out[c * 4 + 3] = 0;
  }
  out[12] = t[0]!;
  out[13] = t[1]!;
  out[14] = t[2]!;
  out[15] = 1;
  return out;
}
