/**
 * FlightGear path resolution for aircraft data.
 *
 *   "Aircraft/<this aircraft>/x"   → <aircraftDir>/x
 *   "Aircraft/<other>/x", "Models/x", "Textures/x", ... (FG_ROOT relative)
 *                                  → <fgdataDir>/x  (FGData, fetched on demand)
 *   relative "x"                   → <including file's dir>/x, then <aircraftDir>/x
 *
 * Shared files that are referenced but not in the FGData cache are recorded in
 * `missing` (FG_ROOT-relative), so a caller can fetch them and convert again.
 */
import fs from "node:fs";
import path from "node:path";

const FG_ROOT_PREFIXES = ["Aircraft/", "Models/", "Textures/", "Effects/", "Shaders/", "Nasal/", "Sounds/", "gui/", "Materials/", "Input/"];

export class FgResolver {
  readonly missing = new Set<string>();
  readonly sharedUsed = new Set<string>();

  constructor(
    readonly aircraftDir: string,
    readonly aircraftName: string,
    /** Local FGData cache root, or undefined to ignore shared files. */
    readonly fgdataDir?: string,
  ) {}

  private exists(p: string): boolean {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  }

  /** FG_ROOT-relative path of a file inside the FGData cache, if it is one. */
  sharedPathOf(abs: string): string | undefined {
    if (!this.fgdataDir) return undefined;
    const rel = path.relative(this.fgdataDir, abs);
    return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join("/");
  }

  private shared(rel: string): string | undefined {
    if (!this.fgdataDir) return undefined;
    const p = path.join(this.fgdataDir, rel);
    if (this.exists(p)) {
      this.sharedUsed.add(rel);
      return p;
    }
    this.missing.add(rel);
    return undefined;
  }

  resolve(ref: string, fromDir: string): string | undefined {
    const r = ref.trim().replace(/^\/+/, "");
    const own = `Aircraft/${this.aircraftName}/`;
    if (r.startsWith(own)) {
      const p = path.join(this.aircraftDir, r.slice(own.length));
      return this.exists(p) ? p : undefined;
    }
    if (FG_ROOT_PREFIXES.some((pre) => r.startsWith(pre))) {
      // FG looks in the aircraft dir first for relative-looking paths like "Models/x".
      if (!r.startsWith("Aircraft/")) {
        for (const c of [path.join(fromDir, r), path.join(this.aircraftDir, r)]) if (this.exists(c)) return c;
      }
      return this.shared(r);
    }
    for (const c of [path.join(fromDir, r), path.join(this.aircraftDir, r)]) if (this.exists(c)) return c;
    // Relative reference from a shared file: resolve inside FGData.
    const sharedFrom = this.sharedPathOf(path.join(fromDir, r));
    if (sharedFrom) return this.shared(sharedFrom);
    return undefined;
  }
}
