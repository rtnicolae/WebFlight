/**
 * Corrections to FGAddon flight models, each fitted to published measurements. They are
 * applied where the model's files are read (loadJsbsimFiles: the browser bundle and the Node
 * loader alike), so every runtime flies the same aircraft.
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
  edits: { from: RegExp; to: string }[];
}

export const AERO_FIXES: AeroFix[] = [
  {
    aircraft: "ASK21",
    file: "Systems/ask21-aero.xml",
    why:
      "Speed polar against the measured one (XCSoar's polar store, 468 kg: 0.67 m/s at 74.1 km/h, " +
      "0.90 at 101.9, 2.68 at 166.7; agrees with the flight manual's chart, credited to DFVLR and " +
      "Idaflieg). As shipped (Aeromatic 2018, then hand-tuned) the solo polar was flat: 0.70 m/s " +
      "from 74 to 102 km/h, best glide 42 where Schleicher gives 34; two-up (563 kg) it sank " +
      "0.21 m/s too much at 81 km/h. The cause: a drag term of 0.02 per unit of elevator travel " +
      "(two-up the trim needs -0.77 of it: more drag than the whole airframe), with the profile " +
      "drag (0.007) and induced factor (0.018) tuned to make up for it at the light loading. With " +
      "that term gone, the two remaining numbers fitted to the 468 kg polar: profile drag 0.0098 at " +
      "zero incidence (its rise with incidence kept) and induced factor 0.0222 (span efficiency " +
      "0.89 at aspect ratio 16.1; Aeromatic's own estimate was 0.023). The 563 kg polar, not " +
      "fitted, then agrees within 0.03 m/s (scaled as sqrt(mass)).",
    edits: [
      { from: /(-0\.26\s+)0\.012(\s+0\.00\s+)0\.007(\s+0\.26\s+)0\.012/, to: "$10.0148$20.0098$30.0148" },
      { from: /(<property>aero\/cl-squared<\/property>\s*<value>)0\.018(<\/value>)/, to: "$10.0222$2" },
      { from: /(<abs><property>fcs\/elevator-pos-norm<\/property><\/abs>\s*<value>)0\.02(<\/value>)/, to: "$10$2" },
    ],
  },
];

/** Apply the fixes for `aircraft` to its files in place; returns warnings for edits that no longer match. */
export function applyAeroFixes(aircraft: string, files: Record<string, string>, fixes: readonly AeroFix[] = AERO_FIXES): string[] {
  const warnings: string[] = [];
  for (const fix of fixes) {
    if (fix.aircraft !== aircraft) continue;
    let text = files[fix.file];
    if (text === undefined) continue;
    for (const e of fix.edits) {
      if (!e.from.test(text)) {
        warnings.push(`${fix.aircraft}/${fix.file}: correction not applied (the file changed): ${e.from.source}`);
        continue;
      }
      text = text.replace(e.from, e.to);
    }
    files[fix.file] = text;
  }
  return warnings;
}
