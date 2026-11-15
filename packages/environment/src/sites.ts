/** Places with real terrain used by tests and as browser start positions. */
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

/** An airfield to start from: runway centre/heading/size, typical cloud base, ridge if any. */
export interface Airfield extends Site {
  id: string;
  /** Runway [m] (heading = the low-numbered direction). */
  lengthM: number;
  widthM: number;
  paved: boolean;
  /** Typical summer cloud base [m MSL]. */
  cloudBaseM: number;
  /** Summer time zone offset from UTC [h] (local times in the menu). */
  utcOffsetH: number;
  /** Default wind for scenarios without their own [from deg, kt]. */
  wind: [number, number];
  /** A ridge to soar, if the site has a classic one. */
  ridge?: { crest: Site; faceDeg: number; wind: [number, number] };
}

/**
 * Aerodrom Ghimbav (Brașov, Romania), the IAR field next to the new international airport:
 * runway 03/21 from OpenStreetMap (OpenFreeMap aeroway line 45.69744/25.52629 →
 * 45.70505/25.53430): 1050 m, true heading 36.4°. Width not in the data; 30 m assumed.
 */
export const GHIMBAV: Airfield = {
  id: "ghimbav",
  name: "Ghimbav (Brașov)",
  latDeg: 45.701245,
  lonDeg: 25.530295,
  headingDeg: 36.4,
  lengthM: 1050,
  widthM: 30,
  paved: true,
  cloudBaseM: 2200,
  utcOffsetH: 3,
  wind: [270, 6],
};

export const GRENCHEN_AIRFIELD: Airfield = {
  ...GRENCHEN,
  id: "grenchen",
  lengthM: 1000,
  widthM: 23,
  paved: true,
  cloudBaseM: 1900,
  utcOffsetH: 2,
  wind: [150, 8],
  ridge: { crest: JURA_CREST, faceDeg: 150, wind: [150, 20] },
};

export const AIRFIELDS: Record<string, Airfield> = { ghimbav: GHIMBAV, grenchen: GRENCHEN_AIRFIELD };
/** Home base. */
export const DEFAULT_AIRFIELD = GHIMBAV;
