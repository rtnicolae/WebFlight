import { beforeAll, describe, expect, it } from "vitest";
import { controlsToJsbsim, fgOutputSource, SNAPSHOT_CORE, trimSteadyGlide, type AirbrakeRoute } from "@webflight/fdm-core";
import { ASK21, createGlider, ensureAircraft } from "../src/gliders.ts";
import { runLanding } from "../src/landing.ts";
import { START } from "../src/glide.ts";

// ASK21 input profile (as written to the bundle manifest by the converter).
const AIRBRAKE: AirbrakeRoute = { property: "/controls/engines/engine/throttle", invert: true };

describe("ASK21 landing on flat terrain", () => {
  beforeAll(() => ensureAircraft(ASK21), 300_000);

  for (const c of [
    { name: "flared", opts: {} },
    { name: "firm, unflared", opts: { flare: false, approachSinkMs: 2 } },
  ]) {
    it(`${c.name}: touches down, does not sink through or bounce, and stops`, async () => {
      const { fdm } = await createGlider(ASK21, "solo");
      try {
        const r = runLanding(fdm, AIRBRAKE, c.opts);
        expect(r.touchdown).toBeDefined();
        // The main wheel never leaves the ground again after first contact.
        expect(r.airborneAfterTouchdownS).toBeLessThan(0.1);
        expect(r.maxHeightAfterTouchdownM).toBeLessThan(0.05);
        // CG never more than 5 cm below its resting height (gear compression only).
        expect(r.restCgAglM).toBeGreaterThan(0.5);
        expect(r.minCgAglM).toBeGreaterThan(r.restCgAglM - 0.05);
        expect(r.stoppedAtS).toBeDefined();
        expect(r.rolloutM).toBeLessThan(300);
      } finally {
        fdm.destroy();
      }
    }, 30_000);
  }
});

describe("FlightGear control conventions on the ASK21", () => {
  beforeAll(() => ensureAircraft(ASK21), 300_000);

  /** Trim, apply one FG control for 1 s, return body rates [p, q, r] (rad/s). */
  async function response(ctl: Partial<{ aileron: number; elevator: number; rudder: number }>) {
    const { fdm } = await createGlider(ASK21, "solo");
    const t = trimSteadyGlide(fdm, { speed: { veKts: 45 }, base: START });
    const writes = controlsToJsbsim({ aileron: 0, elevator: 0, rudder: 0, elevatorTrim: t.control, airbrake: 0, ...ctl }, AIRBRAKE);
    for (const [k, v] of Object.entries(writes)) fdm.set(k, v);
    fdm.step(60);
    const out = {
      p: fdm.get("velocities/p-rad_sec"),
      q: fdm.get("velocities/q-rad_sec"),
      r: fdm.get("velocities/r-rad_sec"),
      surfaces: Object.fromEntries(
        ["/surface-positions/left-aileron-pos-norm", "/surface-positions/elevator-pos-norm", "/surface-positions/rudder-pos-norm", "/surface-positions/speedbrake-pos-norm"].map((fg) => {
          const s = fgOutputSource(fg)!;
          return [fg, fdm.get(s.jsbsim) * s.scale];
        }),
      ),
      airbrake: fdm.get("fcs/speedbrake-pos-norm"),
    };
    fdm.destroy();
    return out;
  }

  it("+aileron rolls right, +elevator pitches down, +rudder yaws right", async () => {
    expect((await response({ aileron: 0.5 })).p).toBeGreaterThan(0.02);
    expect((await response({ elevator: 0.5 })).q).toBeLessThan(-0.02);
    expect((await response({ rudder: 0.5 })).r).toBeGreaterThan(0.01);
  }, 30_000);

  it("FG surface positions follow FG controls with FG's signs", async () => {
    const a = await response({ aileron: 0.5, elevator: 0.5, rudder: 0.5 });
    expect(a.surfaces["/surface-positions/left-aileron-pos-norm"]).toBeGreaterThan(0.1);
    expect(a.surfaces["/surface-positions/elevator-pos-norm"]).toBeGreaterThan(0.1);
    expect(a.surfaces["/surface-positions/rudder-pos-norm"]).toBeGreaterThan(0.1);
    expect(a.airbrake).toBe(0);
  }, 30_000);

  it("the airbrake lever opens the ASK21 airbrakes through the inverted throttle", async () => {
    const { fdm } = await createGlider(ASK21, "solo");
    for (const [k, v] of Object.entries(controlsToJsbsim({ aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0.5 }, AIRBRAKE))) fdm.set(k, v);
    fdm.runIc();
    expect(fdm.get("fcs/speedbrake-pos-norm")).toBeGreaterThan(0.4);
    fdm.destroy();
  }, 30_000);

  it("all snapshot core properties exist", async () => {
    const { fdm } = await createGlider(ASK21, "solo");
    const catalog = new Set(fdm.propertyCatalog().map((l) => l.replace(/\s*\(.*\)$/, "")));
    expect(SNAPSHOT_CORE.filter((p) => !catalog.has(p))).toEqual([]);
    fdm.destroy();
  }, 30_000);
});
