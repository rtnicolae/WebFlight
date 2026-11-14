import { beforeAll, describe, expect, it } from "vitest";
import { GRENCHEN } from "@webflight/environment";
import { ASK21, ensureAircraft } from "../src/gliders.ts";
import { GroundLaunchSim, grenchenRunwayStart } from "../src/launches.ts";
import { nodeTerrain } from "../src/terrain.ts";

const terrain = nodeTerrain();
const start = grenchenRunwayStart(GRENCHEN);

describe("ASK21 launches from Grenchen (FG hitch.nas / dragrobot.nas ports)", () => {
  beforeAll(async () => {
    await ensureAircraft(ASK21);
    await terrain.load(start.latDeg, start.lonDeg, 9000);
  }, 300_000);

  for (const type of [0, 1] as const) {
    it(`winch launch, winch type ${type}: climbs to a few hundred metres on 1000 m of cable`, async () => {
      const sim = await GroundLaunchSim.create(start, "winch", terrain, { launch: { winch: { type } } });
      try {
        sim.fly({ maxS: 120 });
        const r = sim.releasedAt!;
        expect(r).toBeDefined();
        // The ASK21's hook back-releases when the rope is 70° below the fuselage axis.
        expect(r.aglM).toBeGreaterThan(300);
        expect(r.aglM).toBeLessThan(600);
        expect(r.t).toBeLessThan(45);
        // The weak link (ASK21: 10 kN) holds; IAS stays near the 150 km/h winch limit.
        expect(sim.launch.winch!.broken).toBe(false);
        expect(sim.maxForceN).toBeLessThan(10_000);
        expect(sim.maxIasOnTowKmh).toBeLessThan(type === 1 ? 155 : 170);
        // Wings stay level on the way up.
        expect(Math.max(...sim.samples.filter((s) => s.connected && s.aglM > 5).map((s) => Math.abs(s.bankDeg)))).toBeLessThan(10);
      } finally {
        sim.fdm.destroy();
      }
    }, 60_000);
  }

  it("aerotow: the tug takes off, climbs through its legs and releases 800 m above the start", async () => {
    const sim = await GroundLaunchSim.create(start, "aerotow", terrain, { seed: 1 });
    try {
      const startAlt = sim.fdm.get("position/geod-alt-ft") * 0.3048;
      sim.fly({ maxS: 600 });
      const r = sim.releasedAt!;
      expect(r).toBeDefined();
      expect(r.by).toBe("tow");
      expect(sim.fdm.get("position/geod-alt-ft") * 0.3048 - startAlt).toBeGreaterThan(750);
      expect(sim.launch.rope!.broken).toBe(false);
      expect(sim.maxForceN).toBeLessThan(sim.launch.rope!.cfg.breakForceN);
      // Weak link (ASK21: 6 kN) held; stayed within the ASK21's aerotow limit (175 km/h).
      expect(sim.maxIasOnTowKmh).toBeLessThan(175);
    } finally {
      sim.fdm.destroy();
    }
  }, 120_000);

  it("is reproducible: same seed, same tow pattern", async () => {
    const run = async (seed: number) => {
      const sim = await GroundLaunchSim.create(start, "aerotow", terrain, { seed });
      try {
        sim.fly({ maxS: 120 });
        const t = sim.launch.tug!;
        return [t.latDeg, t.lonDeg, t.headingDeg];
      } finally {
        sim.fdm.destroy();
      }
    };
    expect(await run(7)).toEqual(await run(7));
    expect(await run(7)).not.toEqual(await run(8));
  }, 120_000);
});
