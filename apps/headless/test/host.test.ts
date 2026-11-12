import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Fdm, loadBundleAircraft, P, trimSteadyGlide } from "@webflight/fdm-core";
import { FgHost, NASAL_PORTS, type HostConfig } from "@webflight/fg-host";
import { ASK21, ensureBundle } from "../src/gliders.ts";
import { START } from "../src/glide.ts";

describe("fg-host with the ASK21 bundle", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await ensureBundle(ASK21, { rebuild: true });
  }, 300_000);

  async function hosted() {
    const { files } = await loadBundleAircraft(async (r) => fs.readFileSync(path.join(dir, r), "utf8"));
    const fdm = await Fdm.create();
    fdm.load(files);
    fdm.set(P.pointmassWeightLbs(1), 0);
    trimSteadyGlide(fdm, { speed: { veKts: 45 }, base: START });
    const host = new FgHost(JSON.parse(fs.readFileSync(path.join(dir, "host.json"), "utf8")) as HostConfig, fdm, { nasalPorts: NASAL_PORTS });
    const run = (s: number) => {
      for (let i = 0; i < s * 120; i += 4) {
        host.preStep();
        fdm.step(4);
        host.update(4 / 120);
      }
    };
    return { fdm, host, run, t: host.tree };
  }

  it("loads the property rules and instruments with no unsupported parts except the radio", async () => {
    const { host } = await hosted();
    expect(host.warnings).toEqual(["instrument <comm-radio> not supported"]);
    expect(host.config.propertyRules.length).toBeGreaterThanOrEqual(6);
  });

  it("instruments read the FDM's state through FG's pitot/static chain and the aircraft's rules", async () => {
    const { fdm, run, t } = await hosted();
    run(20);
    const vc = fdm.get(P.vcKts);
    // ASI from pitot/static pressures, then the aircraft's correction rule.
    expect(t.num("/instrumentation/airspeed-indicator/indicated-speed-kt")).toBeCloseTo(vc, 0);
    expect(t.num("/instrumentation/airspeed-indicator/indicated-corr-speed-kt")).toBeCloseTo(vc, 0);
    // Altimeter (QNE) ≈ geodetic altitude in ISA, lagging slightly in the descent.
    expect(Math.abs(t.num("/instrumentation/altimeter/indicated-altitude-ft") - fdm.get("position/geod-alt-ft"))).toBeLessThan(10);
    expect(t.num("/accelerations/pilot-g")).toBeCloseTo(1, 2);
    expect(Math.abs(t.num("/instrumentation/slip-skid-ball/indicated-slip-skid"))).toBeLessThan(0.05);
    expect(Math.abs(t.num("/instrumentation/magnetic-compass/indicated-heading-deg") - t.num("/orientation/heading-magnetic-deg"))).toBeLessThan(1);
    // JSBSim is visible under /fdm/jsbsim, as in FlightGear.
    expect(t.num("/fdm/jsbsim/velocities/vc-kts")).toBe(vc);
  }, 30_000);

  it("FG controls written to the tree reach JSBSim with FG's conventions", async () => {
    const { fdm, host, t } = await hosted();
    t.set("/controls/flight/rudder", 0.5);
    host.preStep();
    expect(fdm.get("fcs/rudder-cmd-norm")).toBe(-0.5);
  }, 30_000);

  it("runs the ported Nasal and reports what is not ported", async () => {
    const { host } = await hosted();
    const by = (st: string) => host.nasalStatus.filter((n) => n.status === st).map((n) => n.file.split("/").pop());
    expect(by("ported").sort()).toEqual(["ask21.nas", "door.nas", "electrical.nas", "groundhandling.nas", "ilec-sc7.nas", "limits.nas", "te-vario.nas"]);
    expect(by("not-ported").sort()).toEqual(["anemoi.nas", "ar6201.nas", "dragrobot.nas", "flarm.nas", "global.canvas.nas", "walk.nas", "walker-animate.nas"]);
    expect(host.warnings.filter((w) => w.startsWith("script"))).toEqual([]);
  }, 30_000);

  it("battery and turn-slip switches power the turn indicator; its gyro spins up and the OFF flag clears", async () => {
    const { run, t } = await hosted();
    run(2);
    expect(t.num("/systems/electrical/volts")).toBe(0);
    expect(t.num("/instrumentation/turn-indicator/off-flag-pos")).toBe(1);
    t.set("/controls/electric/battery-switch", true);
    t.set("/controls/electric/turn-slip-switch", true);
    run(10);
    expect(t.num("/systems/electrical/volts")).toBeGreaterThan(12);
    expect(t.num("/systems/electrical/outputs/turn-indicator")).toBeGreaterThan(11.6);
    expect(t.num("/controls/electric/battery-switch-pos")).toBe(1);
    expect(t.num("/instrumentation/turn-indicator/gyro/spin")).toBeGreaterThan(0.9);
    expect(t.num("/instrumentation/turn-indicator/off-flag-pos")).toBe(0);
    expect(Math.abs(t.num("/instrumentation/turn-indicator/indicated-turn-rate"))).toBeLessThan(0.5);
  }, 30_000);

  it("the ILEC SC7 TE needle shows the steady sink rate; canopy toggles via its cockpit binding", async () => {
    const { fdm, host, run, t } = await hosted();
    run(15);
    const sinkMs = fdm.get(P.vDownFps) * 0.3048;
    expect(t.num("/instrumentation/ilec-sc7/te-reading-mps")).toBeCloseTo(-sinkMs, 1);
    expect(t.num("/instrumentation/variometer[1]/te-reading-mps")).toBeCloseTo(-sinkMs, 1);
    expect(t.num("/accelerations/pilot-gmax")).toBeGreaterThanOrEqual(1);
    expect(host.runNasal("doors.canopyF.toggle();")).toBe(true);
    run(1);
    expect(t.num("/sim/model/door-positions/canopyF/position-norm")).toBeCloseTo(0.5, 1);
    run(2);
    expect(t.num("/sim/model/door-positions/canopyF/position-norm")).toBe(1);
    expect(host.runNasal("ar6201.modepressed();")).toBe(false);
  }, 30_000);
});
