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

  it("keeps a long runway whole when its first piece is short (Bucharest 08L/26R: 3.5 km in six pieces)", () => {
    const P = (a: [number, number], b: [number, number]) => ({ ref: "08L/26R", a, b });
    const m = mergeRunwayPieces([
      P([44.57661, 26.0841], [44.57668, 26.08516]),
      P([44.57668, 26.08516], [44.5779, 26.10107]),
      P([44.5779, 26.10107], [44.57801, 26.10242]),
      P([44.57801, 26.10242], [44.57812, 26.10386]),
      P([44.57807, 26.10317], [44.57836, 26.10718]),
      P([44.57836, 26.10718], [44.57978, 26.12583]),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ ref: "08L/26R", a: [44.57661, 26.0841], b: [44.57978, 26.12583] });
  });
});
