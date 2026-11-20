import { describe, expect, it } from "vitest";
import { hazeVisibilityKm } from "../src/atmosphere.ts";

const humid = (rh: number) => Math.min(160, Math.max(20, 130 * Math.pow(1 - rh, 0.9)));

describe("hazeVisibilityKm", () => {
  it("reads ICON's clear-air figure (35 km and up) as a lower bound", () => {
    expect(hazeVisibilityKm(0.38, 43.2)).toBeCloseTo(humid(0.38), 6);
    expect(hazeVisibilityKm(0.55, 40.9)).toBeCloseTo(humid(0.55), 6);
    // Moist: the forecast is the clearer.
    expect(hazeVisibilityKm(0.8, 36)).toBe(36);
  });
  it("takes murkier air as the forecast says", () => {
    expect(hazeVisibilityKm(0.88, 9.6)).toBe(9.6);
    expect(hazeVisibilityKm(0.85, 27)).toBe(27);
    expect(hazeVisibilityKm(0.99, 0.04)).toBe(1);
  });
  it("reads GFS's 24.14 km as a lower bound", () => {
    expect(hazeVisibilityKm(0.35, 24.14)).toBeCloseTo(humid(0.35), 6);
    expect(hazeVisibilityKm(0.9, 24.14)).toBe(24.14);
  });
  it("falls back to the humidity without one", () => {
    expect(hazeVisibilityKm(0.6)).toBeCloseTo(humid(0.6), 6);
    expect(hazeVisibilityKm(0.99)).toBe(20);
  });
});
