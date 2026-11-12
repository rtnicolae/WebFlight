/**
 * The ASK21's Nasal (FGAddon Aircraft/ASK21/Nasal, GPL-2.0+) rewritten in TypeScript, plus
 * the shared FGData instrument scripts it loads. Each export ports one .nas file and keeps
 * its property names and timing.
 */
import type { AircraftScript } from "../host.ts";
import { Averager, Dampener, Door, InputSwitcher, PropertyReader, SoundPitchController, TotalEnergyProbe, updateLoop, updateProp, YawString } from "./lib.ts";

/** Aircraft/ASK21/Nasal/ask21.nas: g-meter min/max, switch animations, trim jump, yaw string. */
export const ask21Main: AircraftScript = {
  name: "ask21.nas",
  init(api) {
    const g = api.tree.init("/accelerations/pilot-g", 1);
    const gmin = api.tree.init("/accelerations/pilot-gmin", 1);
    const gmax = api.tree.init("/accelerations/pilot-gmax", 1);
    api.maketimer(0, () => {
      const v = g.num();
      if (v < gmin.num()) gmin.set(Math.max(v, -6));
      else if (v > gmax.num()) gmax.set(Math.min(v, 10));
    }).start();
    for (const sw of ["battery-switch", "turn-slip-switch"]) {
      api.setlistener(`/controls/electric/${sw}`, (v) => api.interpolate(`/controls/electric/${sw}-pos`, api.tree.bool(`/controls/electric/${sw}`) || v === true ? 1 : 0, 0.25));
    }
    api.setlistener("/controls/flight/elevator", () => {
      const e = api.num("/controls/flight/elevator");
      api.setprop("/controls/flight/elevator-trim-jump", e < -0.9 ? -1 : e > 0.9 ? 1 : 0);
    });
    api.maketimer(0.1, () => {
      const a = Math.sqrt(Math.min(api.num("/velocities/airspeed-kt"), 120) / 120);
      api.setprop("/environment/aircraft-effects/splash-vector-x", -0.1 - 2 * a);
      api.setprop("/environment/aircraft-effects/splash-vector-y", 0);
      api.setprop("/environment/aircraft-effects/splash-vector-z", 1 - 1.35 * a);
    }).start();
    updateLoop(api, [new YawString(api, updateProp(api, "/instrumentation/yawstring"))], 0);
  },
};

/** Aircraft/ASK21/Nasal/limits.nas: overspeed, g-load and airbrake-speed warnings. */
export const ask21Limits: AircraftScript = {
  name: "limits.nas",
  init(api) {
    const n = (p: string) => (api.tree.node(p).exists ? api.num(p) : undefined);
    api.setlistener("/controls/engines/engine/throttle", () => {
      const s = api.num("/controls/engines/engine/throttle");
      const max = n("/limits/max-spoiler-extension-speed");
      if (s < 1 && max !== undefined && api.num("/velocities/airspeed-kt") > max) api.message("Spoilers extended above maximum spoiler extension speed!");
    });
    const checkG = () => {
      const ias = api.num("/velocities/airspeed-kt"), vmo = n("/limits/vmo") ?? Infinity;
      const g = api.num("/accelerations/pilot-g") || 1;
      const pv = n("/limits/max-positive-g-vmo"), nv = n("/limits/max-negative-g-vmo"), pe = n("/limits/max-positive-g-vne"), ne = n("/limits/max-negative-g-vne");
      let msg = "";
      if (pv !== undefined && ias <= vmo && g > pv) msg = "Airframe structural positive-g load under manoeuvering speed limit exceeded!";
      else if (pe !== undefined && ias > vmo && g > pe) msg = "Airframe structural positive-g load above manoeuvering speed limit exceeded!";
      if (nv !== undefined && ias <= vmo && g < nv) msg = "Airframe structural negative-g load under manoeuvering speed limit exceeded!";
      else if (ne !== undefined && ias > vmo && g < ne) msg = "Airframe structural negative-g load above manoeuvering speed limit exceeded!";
      if (msg) api.message(msg);
      api.settimer(checkG, msg ? 5 : 1);
    };
    const checkVne = () => {
      const ias = api.num("/velocities/airspeed-kt"), vne = n("/limits/vne"), vmo = n("/limits/vmo");
      let msg = "";
      if (vne !== undefined && ias > vne) msg = "Airspeed exceeds Vne!";
      else if (vmo !== undefined && ias > vmo) msg = "Caution: Airspeed exceeds Vmo!";
      if (msg) api.message(msg);
      api.settimer(checkVne, msg ? 5 : 1);
    };
    api.settimer(checkG, 1);
    api.settimer(checkVne, 1);
  },
};

/** Aircraft/Instruments-3d/glider/vario/ilec-sc7/ilec-sc7.nas (FGData): TE vario, LCD, audio pitch. */
export const ilecSc7: AircraftScript = {
  name: "ilec-sc7.nas",
  init(api, module) {
    const base = "/instrumentation/ilec-sc7";
    for (const [k, v] of [["volume", 0.8], ["audio", 2], ["mode", 1], ["sensitivity", 3], ["lcd-digits-abs", 0], ["lcd-digits-sgn", 0], ["te-reading-mps", 0], ["sound-pitch", 1]] as const) api.setprop(`${base}/${k}`, v);
    api.setprop("/instrumentation/variometer/te-reading-mps", 0);
    const probe = new TotalEnergyProbe(api);
    api.ns(module)["probe"] = probe;
    const needle = new Dampener(probe, 3, 1, updateProp(api, `${base}/te-reading-mps`));
    const sound = new SoundPitchController(needle, 5, 2, updateProp(api, `${base}/sound-pitch`));
    const extra = new Dampener(probe, 2.7, 1, updateProp(api, "/instrumentation/variometer/te-reading-mps"));
    const averager = new Averager(probe, 25);
    const battery = new PropertyReader(api, "/systems/electrical/volts", 0.1);
    const temperature = new PropertyReader(api, "/environment/temperature-degc", 0.1);
    const lcd = new InputSwitcher([battery, averager, temperature], 1, (v) => {
      api.setprop(`${base}/lcd-digits-abs`, Math.abs(v));
      api.setprop(`${base}/lcd-digits-sgn`, v < 0 ? 0 : 1);
    });
    api.setlistener(`${base}/mode`, (v) => lcd.select(Number(v)), { changedOnly: true });
    api.setlistener(`${base}/sensitivity`, (v) => (needle.dampening = Number(v) || 3), { changedOnly: true });
    updateLoop(api, [probe, needle, sound, extra], 0);
    updateLoop(api, [battery, averager, temperature, lcd], 1);
    // Panel button binding "ilec.cycle_display()": not defined in FGData; cycle the LCD mode.
    api.command("ilec.cycle_display();", () => api.setprop(`${base}/mode`, (api.num(`${base}/mode`) + 1) % 3));
  },
};

/** Aircraft/ASK21/Nasal/te-vario.nas: rear-seat TE vario on the shared probe. */
export const ask21TeVario: AircraftScript = {
  name: "te-vario.nas",
  init(api, module) {
    const probe = api.ns(module)["probe"] as TotalEnergyProbe | undefined;
    if (!probe) throw new Error("te-vario.nas needs the TE probe from ilec-sc7.nas in the same module");
    updateLoop(api, [new Dampener(probe, 2.3, 1, updateProp(api, "/instrumentation/variometer[1]/te-reading-mps"))], 0);
  },
};

/** Aircraft/ASK21/Nasal/groundhandling.nas: assist gear release, altimeter setting check. */
export const ask21GroundHandling: AircraftScript = {
  name: "groundhandling.nas",
  init(api) {
    const gh = "/controls/gear/assist-1";
    api.setlistener("/velocities/groundspeed-kt", (v) => {
      if (Number(v) > 15 && api.num(gh) === 1) api.setprop(gh, 0);
    });
    api.setlistener("/gear/gear[1]/wow", (v) => {
      if (Number(v) !== 1 && v !== true && api.num(gh) === 1) api.setprop(gh, 0);
    });
    api.maketimer(0, () => {
      const d = api.num("/instrumentation/altimeter/setting-inhg") - api.num("/environment/pressure-sea-level-inhg");
      api.setprop("/instrumentation/altimeter/setting-mismatch", Math.abs(d) > 0.05 ? 1 : 0);
    }).start();
  },
};

/** Aircraft/ASK21/Nasal/electrical.nas: 12 V battery, one bus, instrument outputs. */
export const ask21Electrical: AircraftScript = {
  name: "electrical.nas",
  init(api) {
    const e = "/systems/electrical";
    api.tree.init(`${e}/serviceable`, true);
    api.tree.init("/controls/electric/battery-switch", false);
    api.tree.init("/controls/electric/turn-slip-switch", false);
    const outputs = ["ilec-sc7", "comm", "turn-indicator", "flarm", "wind-compass"];
    for (const o of outputs) api.tree.init(`${e}/outputs/${o}`, 0);
    // BatteryClass.new(12.0, 0.325, 6.5, 25, 0)
    const idealVolts = 12, ampHours = 6.5, chargeAmps = 25;
    let charge = api.getprop(`${e}/battery/charge`) !== undefined && !api.tree.bool(`${e}/save-battery-charge`) ? 1 : 1;
    api.setprop(`${e}/battery/charge`, charge);
    let ammeterAve = 0;
    let vbus = 0;
    const factor = () => (Math.pow(-(3 * (1 - charge) - 1), 5) + 32) / 32;
    api.maketimer(0, () => {
      const dt = api.num("/sim/time/delta-sec");
      const batteryVolts = api.tree.bool(`${e}/serviceable`) ? idealVolts * factor() : 0;
      let busVolts = api.tree.bool("/controls/electric/battery-switch") ? batteryVolts : 0;
      // electrical_bus_1 (uses last frame's bus voltage, as the Nasal does)
      let load = 0;
      if (vbus > 9) {
        api.setprop(`${e}/outputs/ilec-sc7`, vbus);
        load += 0.06 / vbus;
        const aud = api.num("/instrumentation/ilec-sc7/audio");
        if (aud === 2 || (aud === 1 && api.num("/instrumentation/ilec-sc7/te-reading-mps") > 0)) load += (api.num("/instrumentation/ilec-sc7/volume") * 0.66) / vbus;
        api.setprop(`${e}/outputs/comm`, vbus);
        load += api.tree.bool("/instrumentation/comm/ptt") && api.num("/instrumentation/comm/start") === 1 ? 19.2 / vbus : (1.02 * api.num("/instrumentation/comm/start")) / vbus;
        if (api.tree.bool("/controls/electric/turn-slip-switch")) {
          api.setprop(`${e}/outputs/turn-indicator`, vbus);
          load += (api.num("/instrumentation/turn-indicator/spin") > 0.99 ? 7.8 : 9.9) / vbus;
        } else api.setprop(`${e}/outputs/turn-indicator`, 0);
        api.setprop(`${e}/outputs/flarm`, vbus);
        load += 0.78 / vbus;
        if (api.tree.bool("/sim/model/windcompass")) {
          api.setprop(`${e}/outputs/wind-compass`, vbus);
          load += 1.2 / vbus;
        } else api.setprop(`${e}/outputs/wind-compass`, 0);
      } else for (const o of outputs) api.setprop(`${e}/outputs/${o}`, 0);
      if (load > 55) busVolts = 0;
      const ammeter = busVolts > 1 ? -load : 0;
      // battery.apply_load(load, dt)
      if (dt > 0) charge = Math.max(0, Math.min(charge - (load * dt) / 3600 / ampHours, 1));
      api.setprop(`${e}/battery/charge`, charge);
      ammeterAve = 0.8 * ammeterAve + 0.2 * ammeter;
      api.setprop(`${e}/amps`, ammeterAve);
      api.setprop(`${e}/volts`, busVolts);
      api.setprop(`${e}/load`, load);
      vbus = busVolts > 9 ? busVolts : 0;
      void chargeAmps;
    }).start();
  },
};

/** Aircraft/ASK21/Nasal/door.nas: canopies (aircraft.door), toggled from the cockpit. */
export const ask21Doors: AircraftScript = {
  name: "door.nas",
  init(api, module) {
    const doors = {
      canopyF: new Door(api, "/sim/model/door-positions/canopyF", 2, 0),
      canopyB: new Door(api, "/sim/model/door-positions/canopyB", 2, 0),
      canopyFJ: new Door(api, "/sim/model/door-positions/canopyFJ", 2, 0),
    };
    Object.assign(api.ns(module), doors);
    for (const [name, d] of Object.entries(doors)) api.command(`${module}.${name}.toggle();`, () => d.toggle());
  },
};

/** Aircraft/ASK21/Nasal/immat.nas: registration letters as glyph indices for the immat model. */
export const ask21Immat: AircraftScript = {
  name: "immat.nas",
  init(api) {
    if (!api.tree.node("/sim/model/immat").exists) api.setprop("/sim/model/immat", "D-1234");
    const refresh = () => {
      const s = String(api.getprop("/sim/model/immat") ?? "").toUpperCase();
      for (let i = 0; i < 6; i++) {
        const ch = s[i];
        let glyph: number;
        if (ch === undefined) glyph = -1;
        else if (ch >= "A" && ch <= "Z") glyph = ch.charCodeAt(0) - 65;
        else if (ch >= "0" && ch <= "9") glyph = ch.charCodeAt(0) - 48 + 26;
        else glyph = 36;
        api.setprop(`/sim/multiplay/generic/int[${i}]`, glyph + 1);
      }
    };
    refresh();
    api.setlistener("/sim/model/immat", refresh, { changedOnly: true });
  },
};
