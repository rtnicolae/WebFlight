import "cesium/Build/Cesium/Widgets/widgets.css";
import { Cartographic, createGooglePhotorealistic3DTileset } from "cesium";
import { pinGroundToGlider } from "./ground-lod.ts";
import { applyLighting, setLook } from "./lighting.ts";
import "./style.css";
import { KMH_PER_KT, M_PER_FT, SnapshotLayout, SnapshotReader, type BundleManifestCore } from "@webflight/fdm-core";
import { advance, TerrariumTerrain } from "@webflight/environment";
import { AircraftView } from "./aircraft.ts";
import { ChaseCamera } from "./camera.ts";
import { Hud } from "./hud.ts";
import { PilotInput } from "./input.ts";
import type { FromWorker, StartState, ToWorker, WorldConfig } from "./protocol.ts";
import { addRunway, createViewer, followShadows, ThermalLayer } from "./scene.ts";
import { resolveFlight, type Flight } from "./world.ts";
import { addImagery, highResPhotoAt, photoTileUrl, S2CLOUDLESS, type ImageryMode } from "./imagery.ts";
import { soaringFrom, sunPosition } from "@webflight/environment";
import { showMenu } from "./menu.ts";
import { Scenery } from "./scenery.ts";
import { GrassLayer } from "./grass/grass-layer.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import { CockpitInteraction } from "./interaction.ts";
import { LAUNCH_PROPERTIES, LaunchView } from "./launch-view.ts";

const params = new URLSearchParams(location.search);
const AIRCRAFT = params.get("aircraft") ?? "ASK21";
const BUNDLE = new URL(`bundles/${AIRCRAFT}/`, new URL(import.meta.env.BASE_URL, location.href)).href;

/**
 * Where and how to fly (URL parameters). Everything else (runway in use, wind, thermals,
 * ridge lift, cloud base, light) comes from the data for that place and time.
 *   field=IDENT&at=lat,lon: an OurAirports airfield (default: home base Ghimbav)
 *   launch=aerotow (default) | winch: on the runway in use (L starts, O releases)
 *   lat, lon, hdg, agl: start in the air there instead (free flight)
 *   time=now (default) | HH:MM (today, local) | YYYY-MM-DDTHH:MM (local): the weather then
 *   rwy=04: a runway other than the longest · wind=from@kt: override the weather's wind
 *   winchtype=1 (rope-speed regulated, default) | 0 (FG's constant-force winch)
 *   imagery=photo (default; falls back to painted) | painted | grid | osm · shadows=0
 *   aerial=bing (default: Bing aerial photos via Cesium ion) | esri (Esri World Imagery) |
 *     google (Google satellite via Cesium ion) | s2 (Sentinel-2, synthesized detail)
 *   world=google3d    Google Photorealistic 3D Tiles instead of the globe and our 3D scenery (comparison)
 *   gdetail=0         no close-range ground texture over the photos
 *   quality=low | high (default: shadows, FXAA) | ultra (+ HDR, 4× MSAA)
 *   sharpen=0..1      contrast-adaptive sharpening (default 0: off)
 *   dynres=1          lower the resolution to keep ≥ 40 fps, down to 60% (default: fixed)
 *   pin=<metres>      keep the ground within that radius of the glider loaded (default: off)
 *   shadowdist=M      how far shadows reach [m] (default: 1–4 km with the height above ground)
 *   far=N             distant buildings out to ±N zoom-14 tiles, ~1.7 km each (default 3, ultra 5; 0: off)
 *   skyline=N         beyond those, blocks and large buildings out to ±N tiles (default 6, ultra 8; 0: off)
 *   thermals=0 · seed=N (thermal placement) · columns=1 (draw lift columns)
 */
const AIR_START = params.has("lat") && params.has("lon");
const LAUNCH = AIR_START ? undefined : params.get("launch") === "winch" ? "winch" : "aerotow";
const SEED = Number(params.get("seed") ?? 1);
// Off by default: every change of scale makes Cesium re-pick ground tiles (popping, reloads).
// Disk cache for tiles and static assets (public/sw.js): what has been downloaded once loads
// from disk afterwards. Takes over from the next request on; ?sw=0 unregisters it.
if ("serviceWorker" in navigator) {
  if (params.get("sw") === "0") void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
  else void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch((e: unknown) => console.warn("tile cache unavailable:", e));
}
const DYNRES = params.get("dynres") === "1";
const QUALITY = (["low", "high", "ultra"].includes(params.get("quality") ?? "") ? params.get("quality") : "high") as "low" | "high" | "ultra";
const GOOGLE3D = params.get("world") === "google3d";
const IMAGERY = (["photo", "painted", "grid", "osm"].includes(params.get("imagery") ?? "") ? params.get("imagery") : params.get("map") === "osm" ? "osm" : "photo") as ImageryMode;

async function startState(F: Flight): Promise<StartState> {
  if (AIR_START || !F.runway)
    return { latDeg: F.latDeg, lonDeg: F.lonDeg, headingDeg: Number(params.get("hdg") ?? 0), aglM: Number(params.get("agl") ?? 600), easKmh: Number(params.get("eas") ?? 90) };
  // On the runway in use, 50 m past its threshold.
  const R = F.runway;
  const [lat, lon] = advance(R.latDeg, R.lonDeg, R.headingDeg + 180, R.lengthM / 2 - 50);
  return { latDeg: lat, lonDeg: lon, headingDeg: R.headingDeg, aglM: 0, easKmh: 0, ground: { launch: LAUNCH ?? "aerotow", winchType: params.get("winchtype") === "0" ? 0 : 1, seed: SEED } };
}

/** ASK21 solo (pointmass 1 = copilot). */
const LOADOUT: Record<number, number> = { 0: 80, 1: 0, 2: 0 };

const status = document.getElementById("boot")!;
const setStatus = (s: string) => (status.textContent = s);

async function main(): Promise<void> {
  setStatus("Loading aircraft bundle…");
  const res = await fetch(new URL("manifest.json", BUNDLE));
  if (!res.ok) throw new Error(`No bundle for ${AIRCRAFT} (${res.status}). Run: pnpm bundle:ask21`);
  const manifest = (await res.json()) as BundleManifestCore;
  setStatus("Airfield, runway and weather…");
  const F = await resolveFlight(params);
  const RUNWAY = F.runway, TIME = F.time;
  const WORLD: WorldConfig = { terrain: "terrarium", environment: F.environment };

  // The renderer draws the same Terrarium heights the worker flies on.
  const renderTerrain = new TerrariumTerrain({ zoom: 13, maxTiles: 512 });
  const viewer = createViewer(document.getElementById("cesium")!, { time: TIME, shadows: params.get("shadows") !== "0" && QUALITY !== "low", quality: QUALITY, terrain: renderTerrain, sharpen: params.has("sharpen") ? Number(params.get("sharpen")) : 0, ...(params.has("shadowdist") ? { shadowDistanceM: Number(params.get("shadowdist")) } : {}) });
  const sun = sunPosition(TIME, F.latDeg, F.lonDeg);
  setLook(sun.elevationDeg);
  applyLighting(viewer, sun, F.latDeg, F.lonDeg);
  // Sharp orthophotos show the real runway; otherwise (painted, or 10 m Sentinel-2 where a
  // 30 m strip is a smudge) draw ours.
  const imageryReady = addImagery(viewer, IMAGERY, sun).then((mode) => {
    // In photo mode the ground imagery shows the runway itself (orthophoto, or our detail tiles,
    // which paint it and take the time of day): an overlay on top would be lit differently.
    if (RUNWAY && (mode !== "photo" || params.get("detail") === "0" || params.get("runway") === "1")) addRunway(viewer, RUNWAY);
    return mode;
  });
  const thermalLayer = new ThermalLayer(viewer, params.get("columns") === "1", sun, soaringFrom(F.weather).cumulus);
  // 3D scenery (Switzerland): buildings, trees, water. ?buildings=0 / trees=0 / water=0 to turn off.
  // After the imagery probe, so the scenery downloads don't starve it.
  const imageryMode = await imageryReady;
  // ?world=google3d: Google Photorealistic 3D Tiles (via Cesium ion) in place of the globe and
  // our buildings, trees and grass. For comparing the look; the glider still flies on the
  // Terrarium heights.
  if (GOOGLE3D) {
    viewer.scene.primitives.add(await createGooglePhotorealistic3DTileset());
    viewer.scene.globe.show = false;
  }
  const scenery = Scenery.create(viewer, { latDeg: F.latDeg, lonDeg: F.lonDeg }, { buildings: params.get("buildings") !== "0" && QUALITY !== "low" && !GOOGLE3D, trees: params.get("trees") !== "0" && QUALITY !== "low" && !GOOGLE3D, water: params.get("water") !== "0", shadows: QUALITY !== "low" && params.get("shadows") !== "0", treeDetail: QUALITY === "ultra" ? 12 : 24, drape: imageryMode === "photo", osmTreeSpacingM: QUALITY === "ultra" ? 7 : 8, osmTreeRings: QUALITY === "ultra" ? 6 : 4, osmFarRings: params.has("far") ? Number(params.get("far")) : QUALITY === "ultra" ? 5 : 3, osmSkylineRings: params.has("skyline") ? Number(params.get("skyline")) : QUALITY === "ultra" ? 8 : 6 });
  // 3D grass near the camera when it is low (on the field, low passes). ?grass=0|1.
  const grassParam = params.get("grass");
  const osmTiles = await openFreeMapTiles();
  const grass =
    osmTiles && !GOOGLE3D && (grassParam === "1" || (grassParam !== "0" && QUALITY !== "low"))
      ? new GrassLayer(viewer, osmTiles, S2CLOUDLESS, { ...(photoTileUrl ? { photoUrl: photoTileUrl } : {}), cellM: 20, radiusM: QUALITY === "ultra" ? 55 : 38, density: QUALITY === "ultra" ? 20 : 11, maxHeightM: 60 })
      : undefined;
  const launchView = LAUNCH ? new LaunchView(viewer.scene, new URL("bundles/_models/", new URL(import.meta.env.BASE_URL, location.href)).href) : undefined;
  let air: { windFromDeg: number; windKt: number; thermalLiftMs: number; ridgeLiftMs: number } | undefined;
  const aircraft = new AircraftView(manifest, BUNDLE);
  const hud = new Hud(document.getElementById("hud")!);
  const cam = new ChaseCamera(viewer.camera, manifest.views.cockpit);
  cam.groundAt = (lat, lon) => renderTerrain.heightAt(lat, lon);
  // ?pin=<metres>: ground tiles within that radius of the glider chosen by the glider's position.
  // Off by default: measured in Brave on an M1 Pro at the Ghimbav ground start, 3 km pinned
  // 2,542 ground tiles at 12.8 fps, 400 m still 1,908 tiles at ~40 fps, off 570 tiles at
  // 60+ fps (the finest tiles under a glider on the ground are many even in a small circle).
  const pinM = Number(params.get("pin")) || 0;
  const pinGround = pinM > 0 ? pinGroundToGlider(viewer, pinM) : () => {};
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
    reset: () => void startState(F).then((start) => send({ type: "reset", start })),
    toggleView: () => cam.toggle(),
    togglePause: () => send({ type: "pause", paused: (paused = !paused) }),
    toggleHelp: () => hud.toggleHelp(),
    launch: () => send({ type: "launch", action: "start" }),
    release: () => send({ type: "launch", action: "release" }),
    winchFaster: () => send({ type: "launch", action: "faster" }),
    winchSlower: () => send({ type: "launch", action: "slower" }),
    menu: () => location.assign(`?menu&time=${encodeURIComponent(params.get("time") ?? "now")}${F.field ? `&field=${F.field.ident}&at=${F.field.latDeg},${F.field.lonDeg}` : ""}`),
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

  // Warm the renderer's terrain around the start at the zooms Cesium will ask for first, in
  // parallel, so its level-by-level refinement doesn't wait on one download per level.
  const start = await startState(F);
  hud.message(F.weatherText);
  const warm = Promise.all([[13, 5000], [12, 9000], [11, 16000], [10, 30000], [9, 60000], [8, 120000]].map(([z, r]) => renderTerrain.load(start.latDeg, start.lonDeg, r!, z!))).catch(() => {});
  setStatus("Starting flight model…");
  send({
    type: "init",
    bundleUrl: BUNDLE,
    jsbsimModuleUrl: new URL(`${import.meta.env.BASE_URL}jsbsim/jsbsim_wasm.mjs`, location.href).href,
    jsbsimWasmUrl: new URL(`${import.meta.env.BASE_URL}jsbsim/jsbsim_wasm.wasm`, location.href).href,
    rateHz: 120,
    // FG properties for the animations plus what the HUD shows.
    extraProperties: [...aircraft.snapshotProperties, "fcs/speedbrake-pos-norm", "/controls/flight/elevator-trim", "/instrumentation/ilec-sc7/te-reading-mps", ...(LAUNCH ? LAUNCH_PROPERTIES : [])],
    start,
    world: WORLD,
    loadout: LOADOUT,
    allowShared: params.get("nosab") !== "1",
  });
  setStatus("Loading 3D model…");
  await Promise.all([ready, warm, aircraft.load(viewer.scene), launchView?.load().catch((e: unknown) => console.warn("launch models:", e))]);
  status.hidden = true;
  const interaction = new CockpitInteraction(viewer, aircraft, send, cam);
  if (aircraft.texMissing.length) console.warn("texture animations without readers:", aircraft.texMissing);

  let last = performance.now();
  let fps = 60;
  let lastScale = 0;
  const bootT = performance.now();
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    // Dynamic resolution: below ~40 fps render fewer pixels (down to 60%), back up above ~55.
    // Sharpening keeps it crisp. Off with ?dynres=0.
    if (DYNRES && now - lastScale > 2000 && now - bootT > 8000) {
      lastScale = now;
      const sc = viewer.resolutionScale;
      if (fps < 40 && sc > 0.61) viewer.resolutionScale = Math.max(0.6, sc - 0.1);
      else if (fps > 55 && sc < 0.99) viewer.resolutionScale = Math.min(1, sc + 0.1);
    }

    const controls = input.update(dt);
    send({ type: "controls", controls });
    if (!reader || !layout) return;
    reader.read();
    const d = reader.data;
    const g = (n: string) => d[layout!.at(n)]!;

    aircraft.showInterior(cam.mode === "cockpit");
    const m = aircraft.update(d, layout, dt);
    cam.update(m, { phi: g("attitude/phi-rad"), theta: g("attitude/theta-rad"), psi: g("attitude/psi-rad") }, dt);
    launchView?.update(d, layout, dt, (g("position/geod-alt-ft") - g("position/h-agl-ft")) * M_PER_FT);
    scenery?.update(g("position/lat-geod-deg"), g("position/long-gc-deg"));
    followShadows(viewer, g("position/h-agl-ft") * M_PER_FT);
    // Ground tiles follow the glider too (eye 4 m above it: about the chase camera's height).
    pinGround(g("position/lat-geod-deg"), g("position/long-gc-deg"), g("position/geod-alt-ft") * M_PER_FT + 4);
    // Grass follows the glider, not the camera: looking around rebuilds nothing.
    if (grass) grass.update(Cartographic.fromDegrees(g("position/long-gc-deg"), g("position/lat-geod-deg"), g("position/h-agl-ft") * M_PER_FT), 0);
    let launchText: string | undefined;
    if (LAUNCH) {
      const connected = g(LAUNCH === "winch" ? "/sim/hitches/winch/open" : "/sim/hitches/aerotow/open") === 0;
      const kn = (g("/sim/hitches/rope/force-N") / 1000).toFixed(1);
      launchText = connected
        ? LAUNCH === "winch"
          ? `Winch: ${kn} kN · cable ${g("/sim/hitches/winch/tow/length").toFixed(0)} m · L clutch, O release, +/− faster/slower`
          : `Tow: ${kn} kN · L start the tow plane, O release`
        : `${LAUNCH === "winch" ? "Winch" : "Tow"}: released`;
    }

    const sink = g("velocities/v-down-fps") * M_PER_FT;
    hud.update(
      {
        iasKmh: g("velocities/vc-kts") * KMH_PER_KT,
        altM: g("position/geod-alt-ft") * M_PER_FT,
        aglM: g("position/h-agl-ft") * M_PER_FT,
        varioMs: -sink,
        headingDeg: g("attitude/psi-rad") * (180 / Math.PI),
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
        ...(launchText ? { launch: launchText } : {}),
        site: LAUNCH ? `${F.name} · ${LAUNCH}` : F.name,
      },
      dt,
    );
  });
  // Expose for debugging and automated checks.
  (window as unknown as { webflight: unknown }).webflight = { viewer, input, aircraft, cam, interaction, scenery, get layout() { return layout; }, get reader() { return reader; }, send };
}

// An empty URL (or ?menu) shows the title screen; any other parameters start a flight.
const MENU = location.search === "" || params.has("menu");
(MENU ? showMenu(params) : main()).catch((e: unknown) => {
  setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
