/** fgGetLowPass (FlightGear src/Main/util.cxx). */
export function lowPass(current: number, target: number, timeratio: number): number {
  if (timeratio < 0) return timeratio < -1 ? target : current;
  if (timeratio < 0.2) return current * (1 - timeratio) + target * timeratio;
  if (timeratio > 5) return target;
  const keep = Math.exp(-timeratio);
  return current * keep + target * (1 - keep);
}

const R_EARTH_M = 6_371_000;

/** Move `distM` along course `courseDeg` (spherical). Returns [lat, lon] in degrees. */
export function advance(latDeg: number, lonDeg: number, courseDeg: number, distM: number): [number, number] {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180, c = (courseDeg * Math.PI) / 180, d = distM / R_EARTH_M;
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(c));
  const lon2 = lon + Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/** Great-circle distance [m]. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Deterministic PRNG (mulberry32): same seed, same thermals — needed for RL training. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
