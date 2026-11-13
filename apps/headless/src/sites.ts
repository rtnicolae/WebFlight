/** Places with real terrain used by tests and as browser start positions. */
export interface Site {
  name: string;
  latDeg: number;
  lonDeg: number;
  /** Runway or reference heading [deg true]. */
  headingDeg: number;
}

/** Grenchen (LSZG), runway 07/25, at the foot of the Jura. */
export const GRENCHEN: Site = { name: "Grenchen LSZG", latDeg: 47.1817, lonDeg: 7.4172, headingDeg: 67 };
/** A point on the Weissenstein crest of the Jura, NE of Grenchen; the face looks SE. */
export const JURA_CREST: Site = { name: "Jura, Weissenstein crest", latDeg: 47.2536, lonDeg: 7.5097, headingDeg: 70 };
