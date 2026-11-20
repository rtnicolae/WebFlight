import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { advance, Environment, RidgeLift, strengthFactor, TerrariumTerrain, Thermal, ThermalField, ThermalSky, tileToLonLat } from "../src/index.ts";

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

  it("leans the column upwind below its top in a wind either side of north (FG's angle average flipped it)", () => {
    // From 350° at the ground and 010° aloft: the air goes south, so below the top the column is to the north.
    const th = new Thermal({ ...spec }, () => 0);
    th.cycleTimer = 10 * 60;
    th.run(0.1, { latDeg: 47, lonDeg: 8, altFt: 3500 }, { groundFromDeg: 350, groundKt: 10, aloftFromDeg: 10, aloftKt: 10 });
    expect(th.sliceLatDeg).toBeGreaterThan(47 + 100 / 111_132);
    expect(Math.abs(th.sliceLonDeg - 8) * 111_320 * Math.cos((47 * Math.PI) / 180)).toBeLessThan(5);
  });

  it("with the day's wind, leans as its air is carried: u/w metres downwind per metre risen", () => {
    // 10 kt from the west at every height, a 10 ft/s (3.05 m/s) thermal, 5,000 ft deep.
    const west = () => ({ fromDeg: 270, kt: 10 });
    const th = new Thermal({ ...spec }, () => 0, undefined, west);
    th.cycleTimer = 10 * 60;
    const mPerDegLon = 111_320 * Math.cos((47 * Math.PI) / 180);
    const at = (aglFt: number) => (th.run(0.1, { latDeg: 47, lonDeg: 8, altFt: 1000 + aglFt }, wind), (th.sliceLonDeg - 8) * mPerDegLon);
    const slope = (10 * 1852) / 3600 / (10 * 0.3048); // 1.69: about 59° from the vertical
    expect(at(5000)).toBeCloseTo(0, 6); // the top is the thermal's position
    expect(at(2500)).toBeCloseTo(-2500 * 0.3048 * slope, 0);
    const [footLat, footLon] = th.footLatLon;
    expect(footLat).toBeCloseTo(47, 9);
    expect((footLon - 8) * mPerDegLon).toBeCloseTo(-5000 * 0.3048 * slope, 0);
    // Placed by its foot, the top moves downwind.
    th.standOn(47, 8);
    expect((th.spec.lonDeg - 8) * mPerDegLon).toBeCloseTo(5000 * 0.3048 * slope, 0);
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

  it("flies in the day's wind at its height, slowing towards the ground below 10 m", () => {
    const profile = { elevationM: 0, windFromDeg: 270, windKt: 8, boundary: [{ aglM: 180, fromDeg: 280, kt: 12 }], aloft: [{ altM: 1500, fromDeg: 300, kt: 20 }] };
    const env = new Environment({ windFromDeg: 270, windKt: 8, profile, ridgeLift: false, thermals: false });
    const at = (altM: number) => env.update(0.1, { latDeg: 47, lonDeg: 8, altFt: altM / 0.3048 });
    // (No terrain: the ground is at 0 m, so the near-ground levels are at 10 and 180 m.)
    expect(at(10).windKt).toBeCloseTo(8, 9);
    expect(at(180).windKt).toBeCloseTo(12, 9);
    expect(at(1500).windFromDeg).toBeCloseTo(300, 9);
    expect(at(1500).windKt).toBeCloseTo(20, 9);
    expect(at(1).windKt).toBeCloseTo(8 * 0.6, 1);
    const o = at(1500);
    expect(Math.hypot(o.windNorthFps, o.windEastFps)).toBeCloseTo(20 * 1.6878099, 6);
    expect(o.windEastFps).toBeGreaterThan(0); // from 300°: blowing to the south-east
    expect(o.windNorthFps).toBeLessThan(0);
  });

  it("drives ridge lift with the wind at the glider's height, not the valley's 10 m wind", () => {
    // A north–south crest at 2,000 m, its west face 1 in 2.5; the model's ground a basin at 620 m.
    const mLon = 111_320 * Math.cos((45.5 * Math.PI) / 180);
    const crest = { heightAt: (_la: number, lo: number) => Math.max(800, 2000 - 0.4 * Math.abs((lo - 25.2) * mLon)) } as unknown as ConstructorParameters<typeof Environment>[1];
    const profile = { elevationM: 620, windFromDeg: 270, windKt: 2, aloft: [{ altM: 1500, fromDeg: 270, kt: 15 }, { altM: 3000, fromDeg: 270, kt: 40 }] };
    const lift = (withProfile: boolean) => {
      const env = new Environment({ windFromDeg: 270, windKt: 2, ...(withProfile ? { profile } : {}), ridgeLift: true, thermals: false }, crest);
      const at = { latDeg: 45.5, lonDeg: 25.2 - 300 / mLon, altFt: (1880 + 150) / 0.3048 }; // 300 m west of the crest, 150 m up
      let o = env.update(10, at);
      for (let i = 0; i < 5; i++) o = env.update(10, at);
      return o.ridgeLiftFps * 0.3048;
    };
    expect(lift(false)).toBeLessThan(0.5);
    expect(lift(true)).toBeGreaterThan(3);
  });

  it("over terrain far above the weather model's ground, flies in the free air's wind at that height", () => {
    // Model ground 620 m (a basin), its near-ground winds weak; 40 kt at 3 km. A crest at 2,000 m.
    const profile = { elevationM: 620, windFromDeg: 285, windKt: 2, boundary: [{ aglM: 80, fromDeg: 280, kt: 5 }, { aglM: 180, fromDeg: 280, kt: 9 }], aloft: [{ altM: 1500, fromDeg: 280, kt: 10 }, { altM: 3000, fromDeg: 280, kt: 40 }] };
    const crest = { heightAt: () => 2000 } as unknown as ConstructorParameters<typeof Environment>[1];
    const env = new Environment({ windFromDeg: 285, windKt: 2, profile, ridgeLift: false, thermals: false }, crest);
    const o = env.update(0.1, { latDeg: 45.5, lonDeg: 25.2, altFt: 2150 / 0.3048 });
    expect(o.windKt).toBeCloseTo(10 + (30 * 650) / 1500, 1); // between 1,500 and 3,000 m, not the basin's 9 kt
  });
});

describe("TerrariumTerrain when a download fails", () => {
  // An airfield 530 m up; the first request for its tile fails (server hiccup), later ones work.
  const flaky = () => {
    let calls = 0;
    return { calls: () => calls, fetchTile: async () => (calls++ === 0 ? Promise.reject(new Error("HTTP 503")) : terrariumPng(() => 530)) };
  };
  it("tries the tile again and finds the ground, not sea level", async () => {
    const f = flaky();
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: f.fetchTile, retryMs: 5 });
    expect(await t.heightAtAsync(45.7, 25.53)).toBeCloseTo(530, 3);
    expect(f.calls()).toBe(2);
  });
  it("lets heightAt try a failed tile again later", async () => {
    const f = flaky();
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: f.fetchTile });
    await t.load(45.7, 25.53, 50);
    expect(t.heightAt(45.7, 25.53)).toBeUndefined();
    await t.load(45.7, 25.53, 50, 10, true);
    expect(t.heightAt(45.7, 25.53)).toBeCloseTo(530, 3);
  });
  it("rejects when the ground can't be had", async () => {
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: () => Promise.reject(new Error("offline")), retryMs: 1 });
    await expect(t.heightAtAsync(45.7, 25.53)).rejects.toThrow(/terrain unavailable/);
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

describe("TerrariumTerrain.heightGrid", () => {
  it("returns a tile's own pixels (with neighbour borders) and upsamples deeper zooms", async () => {
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: async (_z, x) => terrariumPng((px, py) => (x - 499) * 1000 + px + py / 1000) });
    const g = await t.heightGrid(10, 500, 300);
    const pad = 258;
    expect(g[1 * pad + 1]).toBeCloseTo(1000, 3); // pixel (0, 0)
    expect(g[1 * pad + 256]).toBeCloseTo(1255, 3);
    expect(g[1 * pad + 257]).toBeCloseTo(2000, 3); // east neighbour's first column
    expect(g[1 * pad + 0]).toBeCloseTo(255, 3);
    // Zoom 11 child (1000, 600) = north-west quarter: its pixel (1,0)'s centre lies between parent pixels 0 and 1.
    const c = await t.heightGrid(11, 1000, 600);
    expect(c[1 * pad + 2]).toBeCloseTo(1000.25 + 0.255 * 0.25, 3); // and a quarter pixel into the tile to the north;
  });
});

describe("TerrariumTerrain.mercatorHeightmap", () => {
  it("samples tile edges evenly in Mercator and agrees with heightAt", async () => {
    const t = new TerrariumTerrain({ zoom: 10, fetchTile: async (_z, x, y) => terrariumPng((px, py) => (x - 499) * 300 + (y - 299) * 50 + px + py * 0.5) });
    const n = 65;
    const g = await t.mercatorHeightmap(11, 1000, 600, n);
    await t.load(...(() => { const [lon, lat] = tileToLonLat(500.25, 300.25, 10); return [lat, lon, 20000] as [number, number, number]; })());
    for (const [r, c] of [[0, 0], [32, 32], [64, 64], [10, 50]] as const) {
      const [lon, lat] = tileToLonLat(1000 + c / (n - 1), 600 + r / (n - 1), 11);
      expect(g[r * n + c]).toBeCloseTo(t.heightAt(lat, lon, 10)!, 1);
    }
  });
});

describe("ThermalSky (cross-country)", () => {
  const wind = { groundFromDeg: 0, groundKt: 0, aloftFromDeg: 0, aloftKt: 0 };
  it("generates the same thermals per cell from a seed, around wherever the aircraft is", () => {
    const a = new ThermalSky({ seed: 5 }), b = new ThermalSky({ seed: 5 }), c = new ThermalSky({ seed: 6 });
    const pos = (s: ThermalSky) => s.thermalsAround(47.2, 7.4, 10_000).map((t) => [t.id, t.spec.latDeg, t.spec.lonDeg]);
    expect(pos(a)).toEqual(pos(b));
    expect(pos(a)).not.toEqual(pos(c));
    expect(pos(a).length).toBeGreaterThan(5);
  });

  it("streams cells along a flight and drops the ones left behind", () => {
    const sky = new ThermalSky({ seed: 1, radiusCells: 2 });
    sky.update(1, { latDeg: 47.2, lonDeg: 7.4, altFt: 5000 }, wind);
    const first = new Set(sky.thermals.map((t) => t.id));
    expect(first.size).toBeGreaterThan(10);
    // Fly 100 km east: new cells, old ones gone, lift still computed.
    for (let k = 1; k <= 100; k++) sky.update(1, { latDeg: 47.2, lonDeg: 7.4 + (k * 1000) / 75_900, altFt: 5000 }, wind);
    const now = sky.thermals.map((t) => t.id);
    expect(now.some((id) => first.has(id))).toBe(false);
    expect(now.length).toBeGreaterThan(10);
    expect(Number.isFinite(sky.strengthFps)).toBe(true);
    // A cell's thermals are the same when generated again.
    const id = now[0]!;
    const [cx, cy, k] = id.split(":").map(Number) as [number, number, number];
    const again = sky.cellThermals(cx, cy)![k]!;
    const live = sky.thermals.find((t) => t.id === id)!;
    expect([again.spec.latDeg, again.spec.lonDeg]).toEqual([live.spec.latDeg, live.spec.lonDeg]);
  });
});
