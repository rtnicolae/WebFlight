import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FgResolver } from "../src/resolve.ts";

describe("FgResolver", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-"));
  const ac = path.join(root, "ASK21");
  const fg = path.join(root, "fgdata");
  for (const f of [path.join(ac, "Models/a.xml"), path.join(ac, "x.xml"), path.join(fg, "Aircraft/Generic/g.xml"), path.join(fg, "Aircraft/Instruments-3d/v/v.ac")]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
  }
  const r = new FgResolver(ac, "ASK21", fg);

  it("maps Aircraft/<self> to the aircraft folder and other FG_ROOT paths to FGData", () => {
    expect(r.resolve("Aircraft/ASK21/Models/a.xml", ac)).toBe(path.join(ac, "Models/a.xml"));
    expect(r.resolve("Aircraft/Generic/g.xml", ac)).toBe(path.join(fg, "Aircraft/Generic/g.xml"));
    expect(r.resolve("Models/a.xml", ac)).toBe(path.join(ac, "Models/a.xml")); // aircraft first
  });

  it("resolves relative paths from the including file, then the aircraft root", () => {
    expect(r.resolve("a.xml", path.join(ac, "Models"))).toBe(path.join(ac, "Models/a.xml"));
    expect(r.resolve("x.xml", path.join(ac, "Models"))).toBe(path.join(ac, "x.xml"));
  });

  it("records missing shared files, including relative references from shared files", () => {
    expect(r.resolve("Aircraft/Generic/missing.xml", ac)).toBeUndefined();
    expect(r.resolve("tex.png", path.join(fg, "Aircraft/Instruments-3d/v"))).toBeUndefined();
    expect([...r.missing].sort()).toEqual(["Aircraft/Generic/missing.xml", "Aircraft/Instruments-3d/v/tex.png"]);
    expect(r.sharedUsed.has("Aircraft/Generic/g.xml")).toBe(true);
  });
});
