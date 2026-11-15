/** Fixed places used by tests and the gym (the sim takes airfields from data: airfields.ts). */
export interface Site {
  name: string;
  latDeg: number;
  lonDeg: number;
  /** Runway or reference heading [deg true]. */
  headingDeg: number;
}

/**
 * Grenchen (LSZG), asphalt runway 07/25 at the foot of the Jura: centre and true heading of
 * the runway polygon in swisstopo's base vector tiles (aeroway, class runway): 1002 m × 23 m.
 */
export const GRENCHEN: Site = { name: "Grenchen LSZG", latDeg: 47.18162, lonDeg: 7.41718, headingDeg: 65.6 };
/** A point on the Weissenstein crest of the Jura, NE of Grenchen; the face looks SE. */
export const JURA_CREST: Site = { name: "Jura, Weissenstein crest", latDeg: 47.2536, lonDeg: 7.5097, headingDeg: 70 };

/** The old flat test field on the plain ellipsoid. */
export const FLAT_TEST: Site = { name: "Flat test field", latDeg: 47.0, lonDeg: 8.0, headingDeg: 0 };
