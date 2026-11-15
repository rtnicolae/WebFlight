import { describe, expect, it } from "vitest";
import { mergeRunwayPieces } from "../src/index.ts";

describe("runway lines", () => {
  it("joins a runway cut at a tile edge (overlapping buffers) and keeps parallels apart", () => {
    const m = mergeRunwayPieces([
      { ref: "03/21", a: [45.69744, 25.52629], b: [45.70341, 25.53257] },
      { ref: "03/21", a: [45.7031, 25.53224], b: [45.70505, 25.5343] },
      { ref: "03/21", a: [45.696, 25.51282], b: [45.71487, 25.53257] },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ ref: "03/21", a: [45.69744, 25.52629], b: [45.70505, 25.5343] });
  });
});
