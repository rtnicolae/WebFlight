import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { advance, Environment, RidgeLift, strengthFactor, TerrariumTerrain, Thermal, ThermalField, tileToLonLat } from "../src/index.ts";

/** Terrarium PNG (RGB) for a height function of pixel coordinates. */
function terrariumPng(h: (px: number, py: number) => number): Uint8Array {
  const raw = Buffer.alloc(256 * (256 * 3 + 1));
  for (let y = 0; y < 256; y++) {
    raw[y * 769] = 0;
    for (let x = 0; x < 256; x++) {
      const v = h(x, y) + 32768;
      const o = y * 769 + 1 + x * 3;
      raw[o] = Math.floor(v / 256);
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = Math.round((v - Math.floor(v)) * 256) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0);
  ihdr.writeUInt32BE(256, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("TerrariumTerrain", () => {
  it("decodes Terrarium tiles and interpolates bilinearly between pixel centres", async () => {
    // A ramp: height = 10 m per pixel column in every tile.
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: async () => terrariumPng((x) => x * 10) });
    const [lon0, lat0] = tileToLonLat(500 + 100.5 / 256, 300 + 50.5 / 256, 10); // centre of pixel (100, 50)
    expect(t.heightAt(lat0, lon0)).toBeUndefined(); // starts loading
    expect(await t.heightAtAsync(lat0, lon0)).toBeCloseTo(1000, 3);
    const [lon1] = tileToLonLat(500 + 101 / 256, 300 + 50.5 / 256, 10); // halfway to the next pixel
    expect(t.heightAt(lat0, lon1)).toBeCloseTo(1005, 3);
  });
});

describe("FG ridge lift", () => {
  // A 30 % slope rising towards the south, i.e. into a southerly wind.
  const slopeTerrain = (lat: number) => Math.max(0, (47 - lat) * 111_132 * 0.3);

  it("gives lift on the windward face, scaled by wind speed, and sink on the lee side", () => {
    const at = (lat: number) => slopeTerrain(lat);
    const ridge = new RidgeLift((lat) => at(lat));
    // Wind from the south (180°): the probes go south (upwind), where the ground is higher?
    // No — upwind of the windward face is lower ground; put the aircraft on the face:
    const [lat, lon] = advance(46.99, 8, 0, 0);
    let fps = 0;
    for (let i = 0; i < 300; i++) fps = ridge.update(0.1, { latDeg: lat, lonDeg: lon, groundElevM: at(lat), aglM: 80, windFromDeg: 0, windKt: 20 });
    // Wind from the north blows up a slope that rises to the south: lift.
    expect(ridge.liftFactor).toBeGreaterThan(0);
    expect(fps * 0.3048).toBeGreaterThan(1);
    const lee = new RidgeLift((l) => at(l));
    for (let i = 0; i < 300; i++) fps = lee.update(0.1, { latDeg: lat, lonDeg: lon, groundElevM: at(lat), aglM: 80, windFromDeg: 180, windKt: 20 });
    expect(fps).toBeLessThan(0);
  });
});

describe("FG thermals", () => {
  const wind = { groundFromDeg: 0, groundKt: 0, aloftFromDeg: 0, aloftKt: 0 };
  const spec = { latDeg: 47, lonDeg: 8, heightMslFt: 6000, strengthFps: 10, diameterFt: 2000, groundElevFt: 1000 };

  it("has FG's vertical profile: weak near the ground, growing to cloud base, nothing above the cloud", () => {
    expect(strengthFactor(0.05)).toBeLessThan(0.01);
    expect(strengthFactor(0.5)).toBeCloseTo(0.7703, 4);
    expect(strengthFactor(1)).toBeCloseTo(1, 9);
    expect(strengthFactor(1.2)).toBe(0);
  });

  it("lifts in the core of a formed thermal and sinks in the ring around it", () => {
    const th = new Thermal(spec, () => 0);
    th.cycleTimer = 10 * 60; // formed (5–20 min)
    const core = th.run(0.1, { latDeg: 47, lonDeg: 8, altFt: 3500 }, wind);
    expect(th.phase).toBe("formed");
    expect(core).toBeCloseTo(10 * 0.7703, 2); // altRel 0.5, at the slice centre
    const ring = th.run(0.1, { latDeg: 47 + 900 / 111_132 / 3.28 * 1.05, lonDeg: 8, altFt: 3500 }, wind);
    expect(ring).toBeLessThan(0);
    expect(th.run(0.1, { latDeg: 47.2, lonDeg: 8, altFt: 3500 }, wind)).toBe(-1); // global sink
  });

  it("is reproducible from a seed", () => {
    const make = (seed: number) => new ThermalField({ seed, centerLatDeg: 47, centerLonDeg: 8, count: 5 }).thermals.map((t) => [t.spec.latDeg, t.spec.strengthFps, t.cycleTimer]);
    expect(make(42)).toEqual(make(42));
    expect(make(42)).not.toEqual(make(43));
  });
});

describe("Environment", () => {
  it("turns wind-from and lift into JSBSim's NED air velocity", () => {
    const env = new Environment({ windFromDeg: 90, windKt: 10, ridgeLift: false, thermals: false });
    const o = env.update(0.1, { latDeg: 47, lonDeg: 8, altFt: 3000 });
    expect(o.windEastFps).toBeCloseTo(-16.878, 2); // from the east = blowing west
    expect(Math.abs(o.windNorthFps)).toBeLessThan(1e-9);
    expect(o.windDownFps === 0 || Object.is(o.windDownFps, -0)).toBe(true);
  });
});

describe("TerrariumTerrain.heightmap", () => {
  it("samples a north-first grid at the matching zoom, equal to heightAt at full zoom", async () => {
    const zooms = new Set<number>();
    const t = new TerrariumTerrain({ zoom: 13, fetchTile: async (z) => (zooms.add(z), terrariumPng((x, y) => x + 2 * y)) });
    // ~10 m spacing → zoom 13; check corners against heightAt.
    const w = 33, west = 7.4, east = 7.4 + 32 * 0.0001, north = 47.2, south = 47.2 - 32 * 0.0001;
    const g = await t.heightmap(west, south, east, north, w, w);
    expect([...zooms]).toEqual([13]);
    expect(g[0]).toBeCloseTo(t.heightAt(north, west)!, 3);
    expect(g[w * w - 1]).toBeCloseTo(t.heightAt(south, east)!, 3);
    // A coarse tile uses a coarse zoom.
    zooms.clear();
    await t.heightmap(0, 40, 10, 50, 33, 33);
    expect(Math.max(...zooms)).toBeLessThan(13);
  });
});
