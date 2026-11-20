import { describe, expect, it } from "vitest";
import { tileUrl } from "../src/tile-url.ts";

describe("tileUrl", () => {
  it("fills a Bing quadkey", () => {
    // Bing's documented example: tile 3, 5 at level 3 is quadkey 213.
    expect(tileUrl("https://t0/a{quadkey}.jpeg?g=1", 3, 5, 3)).toBe("https://t0/a213.jpeg?g=1");
  });

  it("fills z/y/x (Esri) and z/x/y (Google) templates", () => {
    expect(tileUrl("https://e/tile/{z}/{y}/{x}?token=k", 74842, 46782, 17)).toBe("https://e/tile/17/46782/74842?token=k");
    expect(tileUrl("https://g/2dtiles/{z}/{x}/{y}", 1, 2, 3)).toBe("https://g/2dtiles/3/1/2");
  });
});
