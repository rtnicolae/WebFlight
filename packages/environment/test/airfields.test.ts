import { describe, expect, it } from "vitest";
import { designatorDeg, distanceM, finalFix, HOME_AIRFIELD, loadAirfields, nearestAirfields, resolveRunway, searchAirfields } from "../src/index.ts";

describe("airfields (OurAirports)", async () => {
  const all = await loadAirfields();
  const ghimbav = all.find((a) => a.ident === HOME_AIRFIELD)!;

  it("loads Europe, with the home base and its grass runway", () => {
    expect(all.length).toBeGreaterThan(2500);
    expect(ghimbav.name).toBe("Ghimbav Aerodrome");
    expect(ghimbav.runways[0]).toMatchObject({ le: "04", he: "22", surface: "grass", lengthM: 1050 });
  });

  it("finds fields by name, town or ident, accents ignored", () => {
    expect(searchAirfields(all, "ghimbav").map((a) => a.ident)).toContain("RO-0010");
    expect(searchAirfields(all, "brasov").map((a) => a.ident)).toContain("LRBV");
    expect(searchAirfields(all, "LSZG")[0]!.ident).toBe("LSZG");
    expect(nearestAirfields(all, 45.7, 25.53, 3).map((a) => a.ident)).toContain("RO-0010");
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

  it("falls back to OurAirports' ends, then to the designator", () => {
    const lrbv = all.find((a) => a.ident === "LRBV")!;
    const r1 = resolveRunway(lrbv, lrbv.runways[0]!);
    expect(r1.source).toBe("ourairports");
    expect(r1.paved).toBe(true);
    expect(r1.headingDeg).toBeGreaterThan(30);
    expect(r1.headingDeg).toBeLessThan(45);
    const r2 = resolveRunway(ghimbav, ghimbav.runways[0]!);
    expect(r2.source).toBe("designator");
    expect(r2.headingDeg).toBe(40);
    // Final fix 2 km before the 04 threshold, south-west of the field.
    const [lat, lon] = finalFix(r2, 2000);
    expect(distanceM(lat, lon, ghimbav.latDeg, ghimbav.lonDeg)).toBeCloseTo(2525, -1);
    expect(lat).toBeLessThan(ghimbav.latDeg);
  });

  it("reads designators", () => {
    expect(designatorDeg("04")).toBe(40);
    expect(designatorDeg("36L")).toBe(360);
    expect(designatorDeg("9")).toBe(90);
    expect(designatorDeg("N")).toBeUndefined();
  });
});
