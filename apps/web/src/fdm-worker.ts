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
  loadBundleAircraft,
  P,
  SnapshotLayout,
  SnapshotWriter,
  snapshotBytes,
  trimSteadyGlide,
  type AirbrakeRoute,
  type FgControls,
} from "@webflight/fdm-core";
import type { FromWorker, StartState, ToWorker } from "./protocol.ts";

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
let paused = false;
let t0 = 0;
let stepsSinceT0 = 0;
let statSteps = 0;
let statT = 0;
let lastLag = 0;

function applyStart(s: StartState): { pitchTrim: number; alphaDeg: number; converged: boolean } {
  const f = fdm!;
  const base = {
    "ic/terrain-elevation-ft": s.terrainM * FT_PER_M,
    "ic/lat-geod-deg": s.latDeg,
    "ic/long-gc-deg": s.lonDeg,
    "ic/h-agl-ft": s.aglM * FT_PER_M,
    "ic/psi-true-deg": s.headingDeg,
  };
  f.set(P.terrainElevationAslFt, s.terrainM * FT_PER_M);
  const t = trimSteadyGlide(f, { speed: { veKts: s.easKmh / KMH_PER_KT }, base });
  controls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: t.control, airbrake: 0 };
  applied = { ...controls };
  if (host) {
    for (const [p, v] of Object.entries(controlsToFgProperties(controls, airbrake))) host.tree.set(p, v);
    host.reinit();
  }
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
  writer!.write((n) => (n.startsWith("/") ? (t ? t.num(n) : NaN) : f.get(n)));
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
        host?.preStep();
        fdm.step(due);
        host?.update(due / rateHz);
        const msgs = host?.drainMessages();
        if (msgs?.length) post({ type: "messages", lines: msgs });
      } catch (e) {
        paused = true;
        post({ type: "error", message: String(e instanceof Error ? e.message : e) });
      }
      stepsSinceT0 += due;
      statSteps += due;
      publish();
    }
    lastLag = now - (t0 + (stepsSinceT0 * 1000) / rateHz);
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
        const trim = applyStart(msg.start);
        publish();
        post({ type: "ready", names: [...layout.names], shared: shared ? (buf as SharedArrayBuffer) : null, trim });
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
          const trim = applyStart(msg.start);
          publish();
          post({ type: "ready", names: [...layout!.names], shared: shared ? (writer!.buffer as SharedArrayBuffer) : null, trim });
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
