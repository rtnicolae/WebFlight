import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import { KMH_PER_KT, M_PER_FT, SnapshotLayout, SnapshotReader, type BundleManifestCore } from "@webflight/fdm-core";
import { advance, FLAT_TEST, GRENCHEN, JURA_CREST, TerrariumTerrain, ThermalField, type EnvironmentConfig } from "@webflight/environment";
import { AircraftView } from "./aircraft.ts";
import { ChaseCamera } from "./camera.ts";
import { Hud } from "./hud.ts";
import { PilotInput } from "./input.ts";
import type { FromWorker, StartState, ToWorker, WorldConfig } from "./protocol.ts";
import { addRunway, createViewer, ThermalLayer, type Runway } from "./scene.ts";
import { CockpitInteraction } from "./interaction.ts";

const params = new URLSearchParams(location.search);
const AIRCRAFT = params.get("aircraft") ?? "ASK21";
const BUNDLE = new URL(`bundles/${AIRCRAFT}/`, new URL(import.meta.env.BASE_URL, location.href)).href;

/**
 * Where and how to fly (URL parameters):
 *   site=grenchen (default, real terrain) | flat (the old test field on the ellipsoid)
 *   start=final (straight-in final, runway 07) | ridge (Jura SE face) | thermal (high over the field)
 *   wind=150@20 (from° @ kt) · thermals=0|1 · seed=N · columns=1 (draw lift columns)
 *   dist, agl, eas: start distance from the runway [m], height above ground [m], speed [km/h]
 */
const SITE = params.get("site") === "flat" ? "flat" : "grenchen";
const START_KIND = (params.get("start") ?? "final") as "final" | "ridge" | "thermal";
const RUNWAY: Runway =
  SITE === "flat"
    ? { latDeg: FLAT_TEST.latDeg, lonDeg: FLAT_TEST.lonDeg, headingDeg: 0, lengthM: 800, widthM: 40, paved: false }
    : { latDeg: GRENCHEN.latDeg, lonDeg: GRENCHEN.lonDeg, headingDeg: GRENCHEN.headingDeg, lengthM: 1000, widthM: 30, paved: true };

function parseWind(): { fromDeg: number; kt: number } {
  const m = /^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)$/.exec(params.get("wind") ?? "");
  if (m) return { fromDeg: Number(m[1]), kt: Number(m[2]) };
  // Ridge soaring needs wind onto the Jura's SE face; elsewhere a light breeze from there.
  return SITE === "flat" ? { fromDeg: 0, kt: 0 } : { fromDeg: 150, kt: START_KIND === "ridge" ? 20 : 8 };
}
const WIND = parseWind();
const THERMALS = SITE !== "flat" && params.get("thermals") !== "0";
const SEED = Number(params.get("seed") ?? 1);

/** Renderer-side terrain (same tiles as the worker's); set in main(). */
let renderTerrain: TerrariumTerrain | undefined;

async function startState(): Promise<StartState> {
  const eas = Number(params.get("eas") ?? 90);
  if (START_KIND === "ridge" && SITE !== "flat") {
    // Down the windward face from the Weissenstein crest, flying along the ridge.
    const [lat, lon] = advance(JURA_CREST.latDeg, JURA_CREST.lonDeg, 150, 700);
    return { latDeg: lat, lonDeg: lon, headingDeg: JURA_CREST.headingDeg, aglM: Number(params.get("agl") ?? 250), easKmh: eas };
  }
  if (START_KIND === "thermal" && ENVIRONMENT.thermals) {
    // The thermal field is seeded, so the worker builds the same one: start in a thermal
    // that has just formed (well clear of its dying phase), half a radius off its centre
    // at our height (the column leans downwind).
    const field = new ThermalField({ ...ENVIRONMENT.thermals });
    const near = (t: (typeof field.thermals)[number]) => Math.hypot((t.spec.latDeg - RUNWAY.latDeg) * 111, (t.spec.lonDeg - RUNWAY.lonDeg) * 76) < 8;
    const fresh = field.thermals.filter((t) => near(t) && t.cycleTimer >= 5 * 60 && t.cycleTimer <= 10 * 60);
    const pool = fresh.length ? fresh : field.thermals;
    const th = pool.reduce((a, b) => (a.spec.strengthFps >= b.spec.strengthFps ? a : b));
    const groundM = renderTerrain ? await renderTerrain.heightAtAsync(th.spec.latDeg, th.spec.lonDeg) : 0;
    th.spec.groundElevFt = groundM / 0.3048;
    th.spec.heightMslFt = Math.max(ENVIRONMENT.thermals.cloudBaseM ?? 1800, groundM + 600) / 0.3048;
    // Default: 60 % of the way up the thermal (FG's profile gives ~0.8 of full strength there).
    const aglM = Number(params.get("agl") ?? 0.6 * (th.spec.heightMslFt * 0.3048 - groundM));
    const altFt = (groundM + aglM) / 0.3048;
    th.run(0, { latDeg: th.spec.latDeg, lonDeg: th.spec.lonDeg, altFt }, { groundFromDeg: WIND.fromDeg, groundKt: WIND.kt, aloftFromDeg: WIND.fromDeg, aloftKt: WIND.kt });
    const r = (th.spec.diameterFt * 0.3048) / 4;
    const [lat, lon] = advance(th.sliceLatDeg, th.sliceLonDeg, 270, r);
    return { latDeg: lat, lonDeg: lon, headingDeg: 0, aglM, easKmh: Number(params.get("eas") ?? 85) };
  }
  // Straight-in final: `dist` before the threshold of the low-numbered runway.
  const dist = Number(params.get("dist") ?? 2500) + RUNWAY.lengthM / 2;
  const [lat, lon] = advance(RUNWAY.latDeg, RUNWAY.lonDeg, RUNWAY.headingDeg + 180, dist);
  return { latDeg: lat, lonDeg: lon, headingDeg: RUNWAY.headingDeg, aglM: Number(params.get("agl") ?? 220), easKmh: eas };
}

const ENVIRONMENT: EnvironmentConfig = {
  windFromDeg: WIND.fromDeg,
  windKt: WIND.kt,
  ridgeLift: true,
  thermals: THERMALS ? { seed: SEED, centerLatDeg: RUNWAY.latDeg, centerLonDeg: RUNWAY.lonDeg, radiusM: 12_000, count: 30, cloudBaseM: 1900 } : false,
};
const WORLD: WorldConfig = { terrain: SITE === "flat" ? "flat" : "terrarium", environment: ENVIRONMENT };
/** ASK21 solo (pointmass 1 = copilot). */
const LOADOUT: Record<number, number> = { 0: 80, 1: 0, 2: 0 };

const status = document.getElementById("boot")!;
const setStatus = (s: string) => (status.textContent = s);

async function main(): Promise<void> {
  setStatus("Loading aircraft bundle…");
  const res = await fetch(new URL("manifest.json", BUNDLE));
  if (!res.ok) throw new Error(`No bundle for ${AIRCRAFT} (${res.status}). Run: pnpm bundle:ask21`);
  const manifest = (await res.json()) as BundleManifestCore;

  // The renderer draws the same Terrarium heights the worker flies on.
  if (WORLD.terrain === "terrarium") renderTerrain = new TerrariumTerrain({ zoom: 13 });
  const viewer = createViewer(document.getElementById("cesium")!, { osm: params.get("map") === "osm", ...(renderTerrain ? { terrain: renderTerrain } : {}) });
  addRunway(viewer, RUNWAY);
  const thermalLayer = new ThermalLayer(viewer, params.get("columns") === "1");
  let air: { windFromDeg: number; windKt: number; thermalLiftMs: number; ridgeLiftMs: number } | undefined;
  const aircraft = new AircraftView(manifest, BUNDLE);
  const hud = new Hud(document.getElementById("hud")!);
  const cam = new ChaseCamera(viewer.camera, manifest.views.cockpit);
  if (params.get("view") === "cockpit") cam.toggle();

  const worker = new Worker(new URL("./fdm-worker.ts", import.meta.url), { type: "module" });
  const send = (m: ToWorker) => worker.postMessage(m);
  let reader: SnapshotReader | undefined;
  let layout: SnapshotLayout | undefined;
  let shared = false;
  let localSnap: ArrayBuffer | undefined;
  let paused = false;
  let fdmHz = 0;
  const input = new PilotInput({
    reset: () => void startState().then((start) => send({ type: "reset", start })),
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
          if (/error|warn|not ported|not supported/i.test(m.line)) console.warn("[fdm]", m.line);
          break;
        case "environment":
          thermalLayer.update(m.thermals);
          air = { windFromDeg: m.windFromDeg, windKt: m.windKt, thermalLiftMs: m.thermalLiftMs, ridgeLiftMs: m.ridgeLiftMs };
          break;
        case "messages":
          for (const l of m.lines) hud.message(l);
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
    // FG properties for the animations plus what the HUD shows.
    extraProperties: [...aircraft.snapshotProperties, "fcs/speedbrake-pos-norm", "/controls/flight/elevator-trim", "/instrumentation/ilec-sc7/te-reading-mps"],
    start: await startState(),
    world: WORLD,
    loadout: LOADOUT,
    allowShared: params.get("nosab") !== "1",
  });
  setStatus("Loading 3D model…");
  await Promise.all([ready, aircraft.load(viewer.scene)]);
  status.hidden = true;
  const interaction = new CockpitInteraction(viewer, aircraft, send, cam);
  if (aircraft.texMissing.length) console.warn("texture animations without readers:", aircraft.texMissing);

  let last = performance.now();
  let fps = 60;
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;

    const controls = input.update(dt);
    send({ type: "controls", controls });
    if (!reader || !layout) return;
    reader.read();
    const d = reader.data;
    const g = (n: string) => d[layout!.at(n)]!;

    const m = aircraft.update(d, layout, dt);
    cam.update(m, { phi: g("attitude/phi-rad"), theta: g("attitude/theta-rad"), psi: g("attitude/psi-rad") }, dt);

    const sink = g("velocities/v-down-fps") * M_PER_FT;
    hud.update(
      {
        iasKmh: g("velocities/vc-kts") * KMH_PER_KT,
        altM: g("position/geod-alt-ft") * M_PER_FT,
        aglM: g("position/h-agl-ft") * M_PER_FT,
        varioMs: -sink,
        glideRatio: (g("velocities/vg-fps") * M_PER_FT) / sink,
        controls: { ...controls, airbrake: g("fcs/speedbrake-pos-norm"), elevatorTrim: g("/controls/flight/elevator-trim") },
        teVarioMs: g("/instrumentation/ilec-sc7/te-reading-mps"),
        fps,
        stepsPerSecond: fdmHz,
        shared,
        input: input.gamepadName ? `gamepad: ${input.gamepadName.slice(0, 40)}` : "keyboard (connect a gamepad and press a button)",
        view: cam.mode,
        paused,
        ...(air ? { air } : {}),
        site: SITE === "flat" ? "flat test field" : `${GRENCHEN.name} · ${START_KIND}`,
      },
      dt,
    );
  });
  // Expose for debugging and automated checks.
  (window as unknown as { webflight: unknown }).webflight = { viewer, input, aircraft, cam, interaction, get layout() { return layout; }, get reader() { return reader; }, send };
}

main().catch((e: unknown) => {
  setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
