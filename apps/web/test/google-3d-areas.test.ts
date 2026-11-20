import { describe, expect, it } from "vitest";
import { inGoogle3d, tileInGoogle3d } from "../src/google-3d-areas.ts";

describe("Google 3D areas", () => {
  it("has Brașov's city in and the towns round it (drawn flat by Google) out", () => {
    // Central Brașov, the Schei slope, Tractorul, Răcădău.
    for (const [lat, lon] of [[45.6427, 25.5887], [45.6355, 25.576], [45.67, 25.57], [45.633, 25.613]]) expect(inGoogle3d(lat!, lon!)).toBe(true);
    // Ghimbav, its airfield, Cristian, Săcele, Codlea, Râșnov.
    for (const [lat, lon] of [[45.663, 25.505], [45.648, 25.503], [45.625, 25.48], [45.62, 25.69], [45.7, 25.45], [45.59, 25.465]]) expect(inGoogle3d(lat!, lon!)).toBe(false);
  });

  it("skips a whole tile only when all of it is inside", () => {
    expect(tileInGoogle3d(45.6427, 25.5887)).toBe(true);
    // Near Brașov's western edge, a tile reaching over into Ghimbav's fields.
    expect(tileInGoogle3d(45.655, 25.515)).toBe(false);
  });
});
