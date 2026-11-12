import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_FIXED_PROPERTIES, Fdm, FdmError, P, TrimMode, trimSteadyGlide } from "@webflight/fdm-core";
import { aircraftFiles, ASK21, createGlider, ensureAircraft } from "../src/gliders.ts";
import { START } from "../src/glide.ts";

const IC_NAMES = [
  "ic/lat-geod-deg", "ic/long-gc-deg", "ic/h-sl-ft", "ic/h-agl-ft", "ic/terrain-elevation-ft", "ic/vc-kts", "ic/ve-kts",
  "ic/vt-kts", "ic/gamma-deg", "ic/alpha-deg", "ic/beta-deg", "ic/theta-deg", "ic/phi-deg", "ic/psi-true-deg",
  "ic/vw-north-fps", "ic/vw-east-fps", "ic/vw-down-fps",
];

describe("fdm-core with the ASK21", () => {
  let fdm: Fdm;
  beforeAll(async () => {
    await ensureAircraft(ASK21);
    fdm = (await createGlider(ASK21, "solo")).fdm;
  }, 300_000);
  afterAll(() => fdm?.destroy());

  it("every property name the project uses exists in JSBSim's catalog", () => {
    const catalog = new Set(fdm.propertyCatalog().map((l) => l.replace(/\s*\(.*\)$/, "")));
    const wanted = [...ALL_FIXED_PROPERTIES, ...IC_NAMES, P.pointmassWeightLbs(1), "simulation/do_simple_trim",
      "external_reactions/winch_hitch/magnitude", "external_reactions/aerotow_hitch/magnitude",
      "external_reactions/aerotow_hitch/x", "external_reactions/aerotow_hitch/y", "external_reactions/aerotow_hitch/z"];
    expect(wanted.filter((p) => !catalog.has(p))).toEqual([]);
  });

  it("terrain elevation and vertical wind are writable", () => {
    fdm.set(P.terrainElevationAslFt, 123);
    expect(fdm.get(P.terrainElevationAslFt)).toBeCloseTo(123, 6); // stored as a radius internally
    fdm.set(P.windDownFps, -5);
    expect(fdm.get(P.windDownFps)).toBe(-5);
    fdm.set(P.terrainElevationAslFt, 0);
    fdm.set(P.windDownFps, 0);
  });

  it("JSBSim's longitudinal trim cannot trim a glider (needs thrust), as documented", () => {
    fdm.setInitialConditions({ ...START, "ic/ve-kts": 42, "ic/gamma-deg": -2 });
    fdm.runIc();
    expect(() => fdm.doTrim(TrimMode.tLongitudinal)).toThrow(FdmError);
  });

  it("glide trim zeroes udot, wdot and qdot with the airbrakes closed", () => {
    const t = trimSteadyGlide(fdm, { speed: { veKts: 45 }, base: START });
    expect(t.converged).toBe(true);
    expect(Math.abs(t.residual.udot)).toBeLessThan(1e-4);
    expect(Math.abs(t.residual.wdot)).toBeLessThan(1e-4);
    expect(Math.abs(t.residual.qdot)).toBeLessThan(1e-5);
    expect(fdm.get("fcs/speedbrake-pos-norm")).toBe(0);
    expect(t.veKts).toBeCloseTo(45, 3);
  });
});

describe("aircraft files", () => {
  it("collects the JSBSim closure and host-property defaults from the -set.xml", async () => {
    const dir = await ensureAircraft(ASK21);
    const ac = aircraftFiles(dir, ASK21);
    expect(ac.model).toBe("ask21-jsb");
    expect(Object.keys(ac.files).sort()).toEqual(["Systems/ask21-aero.xml", "Systems/ask21-fcs.xml", "ask21-jsb.xml"]);
    // ASK21 airbrake lever is the FlightGear throttle, 1.0 = closed (ask21-main.xml).
    expect(ac.hostProperties?.["/controls/engines/engine/throttle"]).toBe(1);
  }, 300_000);
});
