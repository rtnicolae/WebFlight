import { describe, expect, it } from "vitest";
import { hazeVisibilityKm } from "../src/atmosphere.ts";

describe("hazeVisibilityKm", () => {
  it("takes the forecast's visibility", () => {
    expect(hazeVisibilityKm(0.35, 44)).toBe(44);
    expect(hazeVisibilityKm(0.88, 9.6)).toBe(9.6);
  });
  it("reads GFS's 24.14 km as a lower bound, and fog as 1 km", () => {
    expect(hazeVisibilityKm(0.35, 24.14)).toBeCloseTo(130 * Math.pow(0.65, 0.9), 6);
    expect(hazeVisibilityKm(0.9, 24.14)).toBe(24.14);
    expect(hazeVisibilityKm(0.99, 0.04)).toBe(1);
  });
  it("falls back to the humidity without one", () => {
    expect(hazeVisibilityKm(0.6)).toBeCloseTo(130 * Math.pow(0.4, 0.9), 6);
    expect(hazeVisibilityKm(0.99)).toBe(20);
  });
});
