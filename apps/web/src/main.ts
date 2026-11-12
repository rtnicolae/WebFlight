import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import { FT_PER_M, KMH_PER_KT, M_PER_FT, SnapshotLayout, SnapshotReader, type BundleManifestCore } from "@webflight/fdm-core";
import { AircraftView } from "./aircraft.ts";
import { ChaseCamera } from "./camera.ts";
import { Hud } from "./hud.ts";
import { PilotInput } from "./input.ts";
import type { FromWorker, StartState, ToWorker } from "./protocol.ts";
import { addAirfield, createViewer, offsetNorthDeg, TerrainSampler } from "./scene.ts";

const params = new URLSearchParams(location.search);
const AIRCRAFT = params.get("aircraft") ?? "ASK21";
const BUNDLE = new URL(`bundles/${AIRCRAFT}/`, new URL(import.meta.env.BASE_URL, location.href)).href;
const AIRFIELD = { latDeg: 47.0, lonDeg: 8.0, lengthM: 800, widthM: 40 };
/** Start on a straight-in final: distance south of the field, height, speed. */
const START_DIST_M = Number(params.get("dist") ?? 2500);
const START_AGL_M = Number(params.get("agl") ?? 220);
const START_EAS = Number(params.get("eas") ?? 90);
/** ASK21 solo (pointmass 1 = copilot). */
const LOADOUT: Record<number, number> = { 0: 80, 1: 0, 2: 0 };

const status = document.getElementById("boot")!;
const setStatus = (s: string) => (status.textContent = s);

async function main(): Promise<void> {
  setStatus("Loading aircraft bundle…");
  const res = await fetch(new URL("manifest.json", BUNDLE));
  if (!res.ok) throw new Error(`No bundle for ${AIRCRAFT} (${res.status}). Run: pnpm bundle:ask21`);
  const manifest = (await res.json()) as BundleManifestCore;

  const viewer = createViewer(document.getElementById("cesium")!, { osm: params.get("map") === "osm" });
  addAirfield(viewer, AIRFIELD);
  const terrain = new TerrainSampler(viewer.terrainProvider);
  const startLat = AIRFIELD.latDeg - offsetNorthDeg(START_DIST_M);
  const startTerrainM = await terrain.prime(startLat, AIRFIELD.lonDeg);
  const aircraft = new AircraftView(manifest, BUNDLE);
  const hud = new Hud(document.getElementById("hud")!);
  const cam = new ChaseCamera(viewer.camera, manifest.views.cockpit);
  if (params.get("view") === "cockpit") cam.toggle();

  const startState = (): StartState => ({ latDeg: startLat, lonDeg: AIRFIELD.lonDeg, headingDeg: 0, aglM: START_AGL_M, easKmh: START_EAS, terrainM: startTerrainM });

  const worker = new Worker(new URL("./fdm-worker.ts", import.meta.url), { type: "module" });
  const send = (m: ToWorker) => worker.postMessage(m);
  let reader: SnapshotReader | undefined;
  let layout: SnapshotLayout | undefined;
  let shared = false;
  let localSnap: ArrayBuffer | undefined;
  let paused = false;
  let fdmHz = 0;
  const input = new PilotInput({
    reset: () => send({ type: "reset", start: startState() }),
    toggleView: () => cam.toggle(),
    togglePause: () => send({ type: "pause", paused: (paused = !paused) }),
    toggleHelp: () => hud.toggleHelp(),
  });

  const ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      switch (m.type) {
        case "ready":
          layout = new SnapshotLayout(m.names);
          shared = !!m.shared;
          if (m.shared) reader = new SnapshotReader(m.shared, layout);
          input.setTrim(m.trim.pitchTrim);
          resolve();
          break;
        case "snapshot":
          // postMessage fallback: copy into a local buffer read by a fixed reader.
          if (layout) {
            if (!localSnap || localSnap.byteLength !== m.buffer.byteLength) {
              localSnap = new ArrayBuffer(m.buffer.byteLength);
              reader = new SnapshotReader(localSnap, layout);
            }
            new Uint8Array(localSnap).set(new Uint8Array(m.buffer));
          }
          break;
        case "stats":
          fdmHz = m.stepsPerSecond;
          break;
        case "log":
          if (/error|warn/i.test(m.line)) console.warn("[jsbsim]", m.line);
          break;
        case "error":
          setStatus(`FDM error: ${m.message}`);
          status.hidden = false;
          reject(new Error(m.message));
          break;
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
  });

  setStatus("Starting flight model…");
  send({
    type: "init",
    bundleUrl: BUNDLE,
    jsbsimModuleUrl: new URL("/jsbsim/jsbsim_wasm.mjs", location.href).href,
    jsbsimWasmUrl: new URL("/jsbsim/jsbsim_wasm.wasm", location.href).href,
    rateHz: 120,
    extraProperties: aircraft.snapshotProperties,
    start: startState(),
    loadout: LOADOUT,
    allowShared: params.get("nosab") !== "1",
  });
  setStatus("Loading 3D model…");
  await Promise.all([ready, aircraft.load(viewer.scene)]);
  status.hidden = true;

  let last = performance.now();
  let fps = 60;
  let terrainSent = NaN;
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;

    const controls = input.update(dt);
    send({ type: "controls", controls });
    aircraft.setControls(controls, manifest.input.airbrake);
    if (!reader || !layout) return;
    reader.read();
    const d = reader.data;
    const g = (n: string) => d[layout!.at(n)]!;

    const m = aircraft.update(d, layout, dt);
    cam.update(m, { phi: g("attitude/phi-rad"), theta: g("attitude/theta-rad"), psi: g("attitude/psi-rad") }, dt);

    // Terrain-height feedback: the FDM's ground follows the renderer's terrain.
    const h = terrain.heightAt(g("position/lat-geod-deg"), g("position/long-gc-deg"));
    if (h !== undefined && !(Math.abs(h - terrainSent) < 0.01)) {
      send({ type: "set", props: { "position/terrain-elevation-asl-ft": h * FT_PER_M } });
      terrainSent = h;
    }

    const sink = g("velocities/v-down-fps") * M_PER_FT;
    hud.update(
      {
        iasKmh: g("velocities/vc-kts") * KMH_PER_KT,
        altM: g("position/geod-alt-ft") * M_PER_FT,
        aglM: g("position/h-agl-ft") * M_PER_FT,
        varioMs: -sink,
        glideRatio: (g("velocities/vg-fps") * M_PER_FT) / sink,
        controls,
        fps,
        stepsPerSecond: fdmHz,
        shared,
        input: input.gamepadName ? `gamepad: ${input.gamepadName.slice(0, 40)}` : "keyboard (connect a gamepad and press a button)",
        view: cam.mode,
        paused,
      },
      dt,
    );
  });
  // Expose for debugging and automated checks.
  (window as unknown as { webflight: unknown }).webflight = { viewer, input, aircraft, cam, get layout() { return layout; }, get reader() { return reader; }, send };
}

main().catch((e: unknown) => {
  setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
