/// <reference lib="webworker" />
/**
 * FDM worker: JSBSim at a fixed rate, independent of the render frame rate.
 * Steps are scheduled from wall-clock time (catching up after stalls, capped), the latest
 * controls are applied before each batch, and a snapshot is published after it.
 */
import { FgHost, NASAL_PORTS, type HostConfig } from "@webflight/fg-host";
import {
  controlsToFgProperties,
  Fdm,
  FT_PER_M,
  KMH_PER_KT,
  LBS_PER_KG,
  M_PER_FT,
  loadBundleAircraft,
  P,
  SnapshotLayout,
  SnapshotWriter,
  snapshotBytes,
  trimSteadyGlide,
  type AirbrakeRoute,
  type FgControls,
} from "@webflight/fdm-core";
import { airAt, applyAir, applyEnvironment, Environment, qnhHpa, TerrariumTerrain, WeatherClock, type EnvironmentOutput } from "@webflight/environment";
import { hitchesFromProperties, Launch, type LaunchView } from "@webflight/launch";
import type { FromWorker, StartState, ThermalView, ToWorker, WorldConfig } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let fdm: Fdm | undefined;
let writer: SnapshotWriter | undefined;
let layout: SnapshotLayout | undefined;
let shared = false;
let airbrake: AirbrakeRoute = { property: "/controls/flight/speedbrake", invert: false };
let controls: FgControls | undefined;
/** Controls as last applied to the FG tree (stick/rudder edge-triggered, levers as deltas). */
let applied: FgControls | undefined;
let host: FgHost | undefined;
let rateHz = 120;
// Paused until the page says go (it does once the ground under the glider is in): the step loop
// starts at "init", and running it while the page still loaded the 3D model and the terrain flew
// the glider away from its start (up to 150 m in tests).
let paused = true;
let t0 = 0;
let stepsSinceT0 = 0;
let statSteps = 0;
let statT = 0;
let lastLag = 0;
let terrain: TerrariumTerrain | undefined;
let env: Environment | undefined;
let envOut: EnvironmentOutput | undefined;
let envPostT = 0;
let prefetchAt: { lat: number; lon: number } | undefined;
let launch: Launch | undefined;
/** Values published under FG-style paths when there is no fg-host tree (and alongside it). */
const extras = new Map<string, number>();
const pendingMessages: string[] = [];

let pendingWaves: import("@webflight/environment").WaveFieldData | undefined;

function setupWorld(w: WorldConfig): void {
  terrain = w.terrain === "terrarium" ? new TerrariumTerrain({ zoom: 13 }) : undefined;
  env = new Environment(w.environment, terrain);
  if (pendingWaves) env.waves = pendingWaves;
  weatherClock = w.weather?.series.length ? new WeatherClock(w.weather.series, w.weather.startUtc, Math.max(1, w.weather.rate ?? 1), 60, w.weather.grid) : undefined;
}

/**
 * Weather over time: the flight's clock is the start's time plus the simulated time since the
 * start (paused, it stands still; a reset starts it again). Every simulated minute the air
 * takes the weather of that moment between the forecast's hours (weatherAt): the wind by
 * height and the thermals (environment.ts, thermals.ts); the page hears of it too.
 */
let weatherClock: WeatherClock | undefined;
/** A wind set by hand (the "wind" message) stays; the weather's thermals still change. */
let windFixed = false;
function stepWeather(dt: number, at?: { latDeg: number; lonDeg: number }): void {
  // With the weather by place: the weather where the glider is (or `at`: a start not yet flown to).
  const w = env && fdm ? weatherClock?.step(dt, at ?? { latDeg: fdm.get("position/lat-geod-deg"), lonDeg: fdm.get("position/long-gc-deg") }) : undefined;
  if (!w || !env) return;
  env.setWeather(w, { winds: !windFixed });
  post({ type: "weather", weather: w });
}

/** Keep the tiles around the aircraft (and the ridge probes upwind) loaded ahead of time. */
function prefetch(lat: number, lon: number): void {
  if (!terrain) return;
  const p = prefetchAt;
  if (p && Math.hypot((lat - p.lat) * 111_132, (lon - p.lon) * 111_320 * Math.cos((lat * Math.PI) / 180)) < 1500) return;
  prefetchAt = { lat, lon };
  void terrain.load(lat, lon, 4000);
}

/** Environment → JSBSim (terrain height, wind incl. lift) and → FG tree (/environment/*). */
function stepEnvironment(dt: number): void {
  if (!env || !fdm) return;
  envOut = applyEnvironment(env, fdm, dt);
  prefetch(fdm.get("position/lat-geod-deg"), fdm.get("position/long-gc-deg"));
  if (host) {
    const t = host.tree;
    t.set("/environment/thermal-lift-fps", envOut.thermalLiftFps);
    t.set("/environment/ridge-lift-fps", envOut.ridgeLiftFps);
    t.set("/environment/wave-lift-fps", envOut.waveLiftFps ?? 0); // (a WebFlight addition)
    // At the aircraft, as FG's environment gives them.
    t.set("/environment/wind-from-heading-deg", envOut.windFromDeg);
    t.set("/environment/wind-speed-kt", envOut.windKt);
  }
}

/**
 * Launch state for the renderer, under FlightGear's property names where FG has them
 * (/ai/models/dragger/*, /sim/hitches/*); the rope ends are WebFlight additions.
 */
function publishLaunch(): void {
  const v: LaunchView | undefined = launch?.view();
  const put = (k: string, x: number) => {
    extras.set(k, x);
    host?.tree.set(k, x);
  };
  put("/sim/hitches/rope/exist", v?.rope ? 1 : 0);
  if (v?.rope) {
    const r = v.rope;
    put("/sim/hitches/rope/start-lat-deg", r.from.latDeg);
    put("/sim/hitches/rope/start-lon-deg", r.from.lonDeg);
    put("/sim/hitches/rope/start-alt-m", r.from.altM);
    put("/sim/hitches/rope/end-lat-deg", r.to.latDeg);
    put("/sim/hitches/rope/end-lon-deg", r.to.lonDeg);
    put("/sim/hitches/rope/end-alt-m", r.to.altM);
    put("/sim/hitches/rope/slack-m", r.slack);
  }
  put("/sim/hitches/rope/force-N", v?.forceN ?? 0);
  put("/sim/hitches/winch/open", launch?.winch ? (launch.winch.open ? 1 : 0) : 1);
  put("/sim/hitches/aerotow/open", launch?.rope ? (launch.rope.open ? 1 : 0) : 1);
  put("/sim/hitches/winch/winch/exist", v?.winch ? 1 : 0);
  if (v?.winch) {
    put("/sim/hitches/winch/winch/latitude-deg", v.winch.latDeg);
    put("/sim/hitches/winch/winch/longitude-deg", v.winch.lonDeg);
    put("/sim/hitches/winch/winch/altitude-m", v.winch.altM);
    put("/sim/hitches/winch/winch/heading-deg", launch!.winch!.ropeHeadingDeg + 180);
    put("/sim/hitches/winch/winch/actual-spool-speed-m-s", launch!.winch!.spoolSpeedMs);
    put("/sim/hitches/winch/winch/rel-speed", launch!.winch!.spoolSpeedMs / launch!.winch!.cfg.maxSpoolSpeedMs);
    put("/sim/hitches/winch/tow/length", launch!.winch!.towLengthM);
  }
  put("/ai/models/dragger/valid", v?.tug && !v.tug.gone ? 1 : 0);
  if (v?.tug) {
    const t = launch!.tug!;
    put("/ai/models/dragger/position/latitude-deg", t.latDeg);
    put("/ai/models/dragger/position/longitude-deg", t.lonDeg);
    put("/ai/models/dragger/position/altitude-ft", t.altM / M_PER_FT);
    put("/ai/models/dragger/orientation/true-heading-deg", t.headingDeg);
    put("/ai/models/dragger/orientation/roll-deg", t.rollDeg);
    put("/ai/models/dragger/orientation/pitch-deg", 0);
    put("/ai/models/dragger/velocities/true-airspeed-kt", t.speedMs / 0.514444);
  }
}

function stepLaunch(dt: number): void {
  if (!launch || !env) return;
  const c = env.config;
  launch.update(dt, { windFromDeg: c.windFromDeg, windKt: c.windKt, upMs: envOut ? (envOut.thermalLiftFps + envOut.ridgeLiftFps) * M_PER_FT : 0 });
}

function postEnvironment(): void {
  if (!env || !envOut) return;
  const thermals: ThermalView[] = (env.thermals?.thermals ?? []).map((th, i) => ({
    id: th.id || String(i),
    latDeg: th.spec.latDeg,
    lonDeg: th.spec.lonDeg,
    topM: th.spec.heightMslFt * M_PER_FT,
    groundM: th.spec.groundElevFt * M_PER_FT,
    radiusM: (th.spec.diameterFt * M_PER_FT) / 2,
    strengthMs: th.spec.strengthFps * M_PER_FT,
    phase: th.phase,
    cycleS: th.cycleTimer,
  }));
  post({
    type: "environment",
    thermals,
    windFromDeg: envOut.windFromDeg,
    windKt: envOut.windKt,
    surfaceFromDeg: env.config.windFromDeg,
    surfaceKt: env.config.windKt,
    thermalLiftMs: envOut.thermalLiftFps * M_PER_FT,
    ridgeLiftMs: envOut.ridgeLiftFps * M_PER_FT,
    ...(envOut.waveLiftFps !== undefined ? { waveLiftMs: envOut.waveLiftFps * M_PER_FT } : {}),
    groundM: envOut.groundElevFt === undefined ? undefined : envOut.groundElevFt * M_PER_FT,
  });
}

async function applyStart(s: StartState): Promise<{ pitchTrim: number; alphaDeg: number; converged: boolean }> {
  const f = fdm!;
  // The ground under the start point must be known before trimming at a height above it.
  let groundM = 0;
  if (terrain) {
    await terrain.load(s.latDeg, s.lonDeg, 4000);
    try {
      groundM = await terrain.heightAtAsync(s.latDeg, s.lonDeg);
    } catch (e) {
      // No terrain here (offline, server down): the weather model's own ground, not sea level.
      groundM = env?.config.profile?.elevationM ?? 0;
      post({ type: "log", line: `warn: ${e instanceof Error ? e.message : e}; starting over the weather model's ground, ${groundM.toFixed(0)} m` });
    }
  }
  const base = {
    "ic/terrain-elevation-ft": groundM * FT_PER_M,
    "ic/lat-geod-deg": s.latDeg,
    "ic/long-gc-deg": s.lonDeg,
    "ic/h-agl-ft": s.aglM * FT_PER_M,
    "ic/psi-true-deg": s.headingDeg,
  };
  f.set(P.terrainElevationAslFt, groundM * FT_PER_M);
  launch = undefined;
  // The flight's clock starts again, and the weather as at the start is applied now: the air's
  // temperature and pressure at the start's height go into the trim (its airspeed → true airspeed).
  weatherClock?.restart();
  stepWeather(0, { latDeg: s.latDeg, lonDeg: s.lonDeg });
  if (env) applyAir(env, f, groundM + (s.ground ? 0 : s.aglM));
  let t: { control: number; alphaDeg: number; converged: boolean };
  if (s.ground) {
    // Standing on the runway, wings held by the wing runner (FG: /controls/gear/assist-1).
    f.set("systems/groundhandling/wingholder", 1);
    f.setInitialConditions({ ...base, "ic/h-agl-ft": 2.4, "ic/vc-kts": 0, "ic/theta-deg": 0, "ic/phi-deg": 0 });
    f.runIc();
    // Settle onto the wheels first: FG's ground handling (groundhandling.nas) drops the wing
    // runner as soon as the main wheel is off the ground.
    f.step(Math.round(rateHz));
    t = { control: 0, alphaDeg: 0, converged: true };
  } else {
    t = trimSteadyGlide(f, { speed: { veKts: s.easKmh / KMH_PER_KT }, base });
    // Faster than the trim reaches (the ASK 21's, full forward, ~155 km/h): it starts trimmed with
    // the stick held forward; once the pilot's stick takes over it slows towards the trim's speed.
    if ((t as { stick?: number }).stick) post({ type: "log", line: `start at ${s.easKmh} km/h: beyond the trim's reach, stick ${((t as { stick?: number }).stick ?? 0).toFixed(2)} needed` });
  }
  controls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: t.control, airbrake: 0 };
  applied = { ...controls };
  if (host) {
    for (const [p, v] of Object.entries(controlsToFgProperties(controls, airbrake))) host.tree.set(p, v);
    host.reinit();
    if (s.ground) host.tree.set("/controls/gear/assist-1", true);
    // The altimeter set to the day's QNH, as before take-off (with the standard setting it would
    // read the pressure altitude: metres off on a day of high or low pressure).
    if (env?.config.air) {
      const qnh = qnhHpa(env.config.air, groundM), a = airAt(env.config.air, groundM);
      for (const alt of ["altimeter", "altimeter[1]"]) host.tree.set(`/instrumentation/${alt}/setting-inhg`, qnh / 33.8639); // front and rear seat
      post({ type: "log", line: `air at the start's ground (${groundM.toFixed(0)} m): ${a.tempC.toFixed(1)} °C, dew point ${a.dewPointC.toFixed(1)} °C, ${a.hPa.toFixed(1)} hPa${a.pressureEstimated ? " (estimated: standard at sea level)" : ""}, QNH ${qnh.toFixed(1)}` });
    }
  }
  if (s.ground?.launch) {
    const g = groundM;
    launch = new Launch(f, {
      kind: s.ground.launch,
      hitches: hitchesFromProperties((p) => {
        const v = host?.tree.get(p);
        return typeof v === "boolean" ? String(v) : v;
      }),
      groundAtM: (lat, lon) => terrain?.heightAt(lat, lon) ?? g,
      headingDeg: s.headingDeg,
      seed: s.ground.seed ?? 1,
      ...(s.ground.winchType !== undefined ? { winch: { type: s.ground.winchType } } : {}),
      say: (channel, text) => pendingMessages.push(channel === "system" || channel === "pilot" ? text : `${channel}: ${text.trim()}`),
    });
  }
  publishLaunch();
  stepEnvironment(0);
  t0 = performance.now();
  stepsSinceT0 = 0;
  return { pitchTrim: t.control, alphaDeg: t.alphaDeg, converged: t.converged };
}

/** Pilot input → FG tree. Stick/rudder when they change; trim and airbrake levers as deltas. */
function applyControls(): void {
  if (!host || !controls || !applied) return;
  const t = host.tree;
  for (const k of ["aileron", "elevator", "rudder"] as const) {
    if (controls[k] !== applied[k]) t.set(`/controls/flight/${k}`, controls[k]);
  }
  const dTrim = controls.elevatorTrim - applied.elevatorTrim;
  if (dTrim !== 0) t.set("/controls/flight/elevator-trim", Math.max(-1, Math.min(1, t.num("/controls/flight/elevator-trim") + dTrim)));
  const dBrake = controls.airbrake - applied.airbrake;
  if (dBrake !== 0) t.set(airbrake.property, Math.max(0, Math.min(1, t.num(airbrake.property) + (airbrake.invert ? -dBrake : dBrake))));
  applied = { ...controls };
}

function publish(): void {
  const f = fdm!;
  const t = host?.tree;
  writer!.write((n) => (n.startsWith("/") ? (extras.get(n) ?? (t ? t.num(n) : NaN)) : f.get(n)));
  if (!shared) {
    const copy = (writer!.buffer as ArrayBuffer).slice(0);
    post({ type: "snapshot", buffer: copy }, [copy]);
  }
}

function tick(): void {
  if (fdm && !paused) {
    const now = performance.now();
    const maxCatchup = Math.ceil(rateHz * 0.25);
    let due = Math.floor(((now - t0) * rateHz) / 1000) - stepsSinceT0;
    if (due > maxCatchup) {
      // Too far behind (tab hidden, debugger, slow machine): drop the backlog.
      t0 += ((due - maxCatchup) * 1000) / rateHz;
      due = maxCatchup;
    }
    if (due > 0) {
      applyControls();
      try {
        stepEnvironment(due / rateHz);
        stepWeather(due / rateHz);
        stepLaunch(due / rateHz);
        host?.preStep();
        fdm.step(due);
        publishLaunch();
        host?.update(due / rateHz);
        const msgs = [...(host?.drainMessages() ?? []), ...pendingMessages.splice(0)];
        if (msgs.length) post({ type: "messages", lines: msgs });
      } catch (e) {
        paused = true;
        post({ type: "error", message: String(e instanceof Error ? e.message : e) });
      }
      stepsSinceT0 += due;
      statSteps += due;
      publish();
    }
    lastLag = now - (t0 + (stepsSinceT0 * 1000) / rateHz);
    if (now - envPostT > 1000) {
      postEnvironment();
      envPostT = now;
    }
    if (now - statT > 1000) {
      post({ type: "stats", stepsPerSecond: (statSteps * 1000) / (now - statT), simTime: fdm.simTime, lagMs: lastLag });
      statSteps = 0;
      statT = now;
    }
  }
  setTimeout(tick, 2);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "init": {
        rateHz = msg.rateHz;
        const base = new URL(msg.bundleUrl, self.location.href);
        const { manifest, files } = await loadBundleAircraft(async (rel) => {
          const r = await fetch(new URL(rel, base));
          if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
          return r.text();
        });
        airbrake = manifest.input.airbrake;
        fdm = await Fdm.create({ rateHz, moduleUrl: msg.jsbsimModuleUrl, wasmUrl: msg.jsbsimWasmUrl, onLog: (line) => post({ type: "log", line }) });
        fdm.load(files);
        for (const [i, kg] of Object.entries(msg.loadout)) fdm.set(P.pointmassWeightLbs(Number(i)), kg * LBS_PER_KG);
        if (manifest.host) {
          const r = await fetch(new URL(manifest.host, base));
          const cfg = (await r.json()) as HostConfig;
          host = new FgHost(cfg, fdm, { nasalPorts: NASAL_PORTS, warn: (m) => post({ type: "log", line: `fg-host: ${m}` }) });
          const notPorted = host.nasalStatus.filter((n) => n.status === "not-ported").map((n) => n.file);
          if (notPorted.length) post({ type: "log", line: `fg-host: Nasal not ported: ${notPorted.join(", ")}` });
        }
        layout = SnapshotLayout.withExtras(msg.extraProperties);
        shared = msg.allowShared && typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
        const buf = shared ? new SharedArrayBuffer(snapshotBytes(layout.names.length)) : new ArrayBuffer(snapshotBytes(layout.names.length));
        writer = new SnapshotWriter(buf, layout);
        setupWorld(msg.world);
        const trim = await applyStart(msg.start);
        post({ type: "ready", names: [...layout.names], shared: shared ? (buf as SharedArrayBuffer) : null, trim });
        // After "ready": without shared memory the page keeps a snapshot only once it has the
        // layout (a snapshot sent first was dropped, and while paused no other came).
        publish();
        statT = performance.now();
        tick();
        break;
      }
      case "controls":
        controls = msg.controls;
        break;
      case "set":
        for (const [p, v] of Object.entries(msg.props)) fdm?.set(p, v);
        break;
      case "reset":
        if (fdm) {
          const wasPaused = paused;
          paused = true; // no steps while the start area's terrain loads
          const trim = await applyStart(msg.start);
          paused = wasPaused;
          // The air at the new spot, also while paused (the step loop posts it only when running).
          postEnvironment();
          post({ type: "ready", names: [...layout!.names], shared: shared ? (writer!.buffer as SharedArrayBuffer) : null, trim });
          publish();
        }
        break;
      case "launch":
        if (launch && env) {
          if (msg.action === "start") launch.start({ windFromDeg: env.config.windFromDeg, windKt: env.config.windKt });
          else if (msg.action === "release") launch.release();
          else if (msg.action === "faster") launch.winch?.faster();
          else launch.winch?.slower();
        }
        break;
      case "grid":
        // Applied with the next minute's weather: where the glider is, both grids give the same.
        if (weatherClock) weatherClock.grid = msg.grid;
        env?.setGrid(msg.grid);
        break;
      case "waves":
        pendingWaves = msg.field;
        if (env) env.waves = msg.field;
        break;
      case "wind":
        if (env) {
          // One wind at every height from now on.
          env.config.windFromDeg = msg.fromDeg;
          env.config.windKt = msg.kt;
          delete env.config.profile;
          windFixed = true;
        }
        break;
      case "action":
        if (host) for (const p of host.fireAction(msg.action, msg.phase, msg.offset !== undefined ? { offset: msg.offset } : {})) post({ type: "log", line: p });
        break;
      case "setprop":
        host?.tree.set(msg.path, msg.value);
        break;
      case "pause":
        paused = msg.paused;
        if (!paused) {
          t0 = performance.now();
          stepsSinceT0 = 0;
        }
        break;
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? `${e.message}` : String(e) });
  }
};
