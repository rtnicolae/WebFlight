/**
 * Corrections to FGAddon flight models, each from published measurements or the model's own
 * geometry. They are applied where the model's files are read (loadJsbsimFiles: the browser
 * bundle and the Node loader alike), so every runtime flies the same aircraft.
 *
 * Each edit replaces exact text. If FGAddon changes a file the edit no longer matches: the
 * loader then warns and leaves the file as it is, since a fit belongs to the text it was made on.
 */

export interface AeroFix {
  /** FGAddon folder, e.g. "ASK21". */
  aircraft: string;
  /** File relative to the JSBSim aircraft directory. */
  file: string;
  /** What the data showed, and the data. */
  why: string;
  edits: { from: RegExp; to: string | ((match: string, ...groups: string[]) => string) }[];
}

/**
 * The ASK 21's numbers (FGAddon's model: Aeromatic 2018, then hand-tuned). Lengths along the
 * fuselage are JSBSim x [m], aft positive; the datum, the wing-root leading edge, is at x = -1.64
 * in the model's own 3D geometry (Models/ask21.ac, wing.L1/R1; the XML comment's "315 mm aft of
 * the leading edge" for the empty CG would put it at -1.215, which the geometry contradicts).
 */
export const ASK21_FIT = {
  datumX: -1.64,
  /** An ASK 21's weighing record (JA2747): 379.9 kg, CG 771 mm aft of the datum. FGAddon: 360.15 kg at 740 mm. */
  emptyKg: 379.9,
  emptyCgAftM: 0.771,
  /** Schleicher's weight and balance sheet: front seat 1,185-1,250 mm ahead of the datum (the middle), rear 80 mm. FGAddon: 1,160 and 160. */
  frontSeatAheadM: 1.2175,
  rearSeatAheadM: 0.08,
  /**
   * The lift table is wing-section (2D) data: slope ~6.9 per radian. A wing of aspect ratio 16.1
   * has a = a0 / (1 + a0 / (pi e AR)) (lifting line; e 0.89 from the drag fit): 0.867 of it.
   * Applied to the whole table, its peak becomes 1.31; the flight manual's stall speed solo
   * (65 km/h at 470 kg) needs 1.29 (not fitted: a check).
   */
  liftScale: 0.867,
  /**
   * Pitch: the elevator's lift (0.2 per radian, the model's) times the tail arm (13.78 ft over
   * the 3.46 ft chord, the model's metrics) is a moment of -0.80 per radian; the model had -0.5.
   */
  cmElevator: -0.8,
  /**
   * Static stability about the wing's aerodynamic centre (the model's reference point, 300 mm aft
   * of the datum): the tail, -eta a_t (S_t/S)(l_t/c)(1 - de/da) = -0.9 x 4.29 x 0.099 x 3.98 x
   * 0.764 = -1.16 (tail aspect ratio 5.1 from the 3D model, downwash 2 a / (pi AR)), plus the
   * fuselage, +0.11 (Raymer's K_f W^2 L / (c S), width 0.70 m, length 8.06 m). -1.06 puts the
   * neutral point 486 mm aft of the datum, behind the certified aft limit (469 mm, EASA TCDS);
   * the model's -0.7 put it at 423 mm: unstable at CGs the glider is certified for.
   */
  cmAlpha: -1.06,
  /**
   * Lift lost with the airbrakes out, per unit of their travel (model: -0.05): fitted so the
   * stall solo rises by the flight manual's 3 km/h (65 to 68 km/h at 470 kg); two-up it then
   * rises 2.75 km/h (manual: 3).
   */
  airbrakeLift: -0.12,
  /** Drag, fitted to the measured polar at 468 kg with the above in place (polar-reference test). */
  profileDrag: 0.0099,
  inducedK: 0.0214,
};

type Fit = typeof ASK21_FIT;

/** The ASK 21's corrections for a set of numbers (ASK21_FIT; experiments pass others). */
export function ask21Fixes(f: Fit = ASK21_FIT): AeroFix[] {
  const x = (aheadOfDatumM: number) => (f.datumX - aheadOfDatumM).toFixed(4);
  const n = (v: number) => v.toFixed(4);
  return [
    {
      aircraft: "ASK21",
      file: "ask21-jsb.xml",
      why:
        "Mass and balance on the wing-root leading edge (x -1.64 in the model's 3D geometry): an " +
        "ASK 21's weighing record (JA2747: 379.9 kg, 771 mm aft) and Schleicher's seat arms (front " +
        "1,185-1,250 mm ahead, rear 80 mm). Loaded to the flight manual's stall-test masses (470 kg " +
        "solo, 600 kg two-up, 110/110) the CG is 390 and 250 mm aft, inside the certified 234-469 mm; " +
        "with FGAddon's numbers two-up at 600 kg sat at 180 mm, ahead of the forward limit.",
      edits: [
        { from: /<emptywt unit="LBS">\s*794\s*<\/emptywt>/, to: `<emptywt unit="KG"> ${f.emptyKg} </emptywt>` },
        { from: /(<location name="CG" unit="M">\s*<x>)\s*-0\.9\s*(<\/x>)/, to: `$1 ${x(-f.emptyCgAftM)} $2` },
        { from: /(<pointmass name="Pilot">[\s\S]*?<x>)\s*-2\.8\s*(<\/x>)/, to: `$1 ${x(f.frontSeatAheadM)} $2` },
        { from: /(<pointmass name="Copilot">[\s\S]*?<x>)\s*-1\.8\s*(<\/x>)/, to: `$1 ${x(f.rearSeatAheadM)} $2` },
      ],
    },
    {
      aircraft: "ASK21",
      file: "Systems/ask21-aero.xml",
      why:
        "Lift, pitch and drag. The lift table is a wing section's: scaled to the wing by lifting-line " +
        "theory. Pitch: the elevator's moment from the model's own elevator lift and tail arm; static " +
        "stability from the tail volume (neutral point aft of the certified aft CG limit). Then the " +
        "speed polar: as shipped, a drag term of 0.02 per unit of elevator travel (two-up near minimum " +
        "sink the trim needed -0.77 of it: more drag than the airframe) with profile drag 0.007 and " +
        "induced factor 0.018 tuned round it gave a flat solo polar (best glide 42; Schleicher: 34) and " +
        "0.21 m/s too much sink two-up. No drag numbers fit the measured polar with that term in. " +
        "Without it, profile drag (its rise with incidence kept) and the induced factor are fitted to " +
        "XCSoar's ASK-21 polar at 468 kg (it matches the flight manual's chart, DFVLR and Idaflieg); " +
        "at 563 kg, not fitted, it agrees too. Checks: apps/headless/test/polar-reference.test.ts.",
      edits: [
        {
          from: /(<function name="aero\/force\/Lift_alpha">[\s\S]*?<tableData>)([\s\S]*?)(<\/tableData>)/,
          to: (_m, head: string, rows: string, tail: string) =>
            head + rows.replace(/^(\s*-?\d+\.\d+\s+)(-?\d+\.\d+)/gm, (_r, a: string, cl: string) => `${a}${n(Number(cl) * f.liftScale)}`) + tail,
        },
        { from: /(<property>aero\/alpha-rad<\/property>\s*<value>)-0\.7(<\/value>)/, to: `$1${f.cmAlpha}$2` },
        { from: /(<property>fcs\/speedbrake-pos-norm<\/property>\s*<value>)-0\.05(<\/value>)/, to: `$1${n(f.airbrakeLift)}$2` },
        { from: /(<independentVar lookup="row">velocities\/mach<\/independentVar>\s*<tableData>\s*0\.0\s+)-0\.500(\s+2\.0\s+)-0\.300/, to: `$1${n(f.cmElevator)}$2${n(f.cmElevator * 0.6)}` },
        { from: /(-0\.26\s+)0\.012(\s+0\.00\s+)0\.007(\s+0\.26\s+)0\.012/, to: `$1${n(f.profileDrag + 0.005)}$2${n(f.profileDrag)}$3${n(f.profileDrag + 0.005)}` },
        { from: /(<property>aero\/cl-squared<\/property>\s*<value>)0\.018(<\/value>)/, to: `$1${n(f.inducedK)}$2` },
        { from: /(<abs><property>fcs\/elevator-pos-norm<\/property><\/abs>\s*<value>)0\.02(<\/value>)/, to: "$10$2" },
      ],
    },
  ];
}

export const AERO_FIXES: AeroFix[] = ask21Fixes();

/** Apply the fixes for `aircraft` to its files in place; returns warnings for edits that no longer match. */
export function applyAeroFixes(aircraft: string, files: Record<string, string>, fixes: readonly AeroFix[] = AERO_FIXES): string[] {
  const warnings: string[] = [];
  for (const fix of fixes) {
    if (fix.aircraft !== aircraft) continue;
    let text = files[fix.file];
    if (text === undefined) continue;
    for (const e of fix.edits) {
      if (!e.from.test(text)) {
        warnings.push(`${fix.aircraft}/${fix.file}: correction not applied (the file changed): ${e.from.source.slice(0, 80)}`);
        continue;
      }
      text = typeof e.to === "string" ? text.replace(e.from, e.to) : text.replace(e.from, e.to as (m: string, ...g: string[]) => string);
    }
    files[fix.file] = text;
  }
  return warnings;
}
