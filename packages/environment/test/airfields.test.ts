import { describe, expect, it } from "vitest";
import { airfieldAt, airfieldsAround, designatorDeg, HOME_AIRFIELD, loadAirfieldIndex, resolveRunway, searchAirfields } from "../src/index.ts";

describe("airfields (OurAirports)", async () => {
  const ghimbav = (await airfieldAt(HOME_AIRFIELD.ident, HOME_AIRFIELD.latDeg, HOME_AIRFIELD.lonDeg))!;

  it("loads the airfields around a point from the data tiles, with the home base's grass runway", async () => {
    const near = await airfieldsAround(45.7, 25.53, 30_000);
    expect(near.map((a) => a.ident)).toEqual(expect.arrayContaining(["RO-0010", "LRBV"]));
    expect(near.every((a) => Math.abs(a.latDeg - 45.7) < 0.3)).toBe(true);
    expect(ghimbav.name).toBe("Ghimbav Aerodrome");
    expect(ghimbav.runways[0]).toMatchObject({ le: "04", he: "22", surface: "grass", lengthM: 1050 });
  });

  it("finds fields in the search index by name, town or ident, accents ignored", async () => {
    const all = await loadAirfieldIndex();
    expect(all.length).toBeGreaterThan(2500);
    expect(searchAirfields(all, "ghimbav").map((a) => a.ident)).toContain("RO-0010");
    expect(searchAirfields(all, "brasov").map((a) => a.ident)).toContain("LRBV");
    expect(searchAirfields(all, "LSZG")[0]!.ident).toBe("LSZG");
  });

  it("takes the matching OSM runway line nearest the field, oriented along the designator", () => {
    // The two parallel runways at Ghimbav in OpenStreetMap: the aerodrome's and LRBV's.
    const osm = [
      { ref: "03/21", a: [45.70505, 25.5343] as [number, number], b: [45.69744, 25.52629] as [number, number] },
      { ref: "03/21", a: [45.696, 25.51282] as [number, number], b: [45.71487, 25.53257] as [number, number] },
    ];
    const rw = resolveRunway(ghimbav, ghimbav.runways[0]!, osm);
    expect(rw.source).toBe("osm");
    expect(rw.headingDeg).toBeCloseTo(36.4, 0); // NE-bound = the 04 direction
    expect(rw.lengthM).toBeCloseTo(1050, -1);
    expect(rw.latDeg).toBeCloseTo(45.70125, 4);
    expect(rw.paved).toBe(false);
    expect(rw.widthM).toBe(40);
  });

  it("falls back to OurAirports' ends, then to the designator", async () => {
    const lrbv = (await airfieldAt("LRBV", 45.7, 25.52))!;
    const r1 = resolveRunway(lrbv, lrbv.runways[0]!);
    expect(r1.source).toBe("ourairports");
    expect(r1.paved).toBe(true);
    expect(r1.headingDeg).toBeGreaterThan(30);
    expect(r1.headingDeg).toBeLessThan(45);
    const r2 = resolveRunway(ghimbav, ghimbav.runways[0]!);
    expect(r2.source).toBe("designator");
    expect(r2.headingDeg).toBe(40);
  });

  it("reads designators", () => {
    expect(designatorDeg("04")).toBe(40);
    expect(designatorDeg("36L")).toBe(360);
    expect(designatorDeg("9")).toBe(90);
    expect(designatorDeg("N")).toBeUndefined();
  });
});
