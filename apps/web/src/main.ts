import "cesium/Build/Cesium/Widgets/widgets.css";
import { Cartesian3, JulianDate } from "cesium";
import { pinGroundToGlider } from "./ground-lod.ts";
import { PoseSmoother } from "./pose-smoother.ts";
import { applyLighting, reflectSky, setLook, setSunLight, tintGround } from "./lighting.ts";
import "./style.css";
import { KMH_PER_KT, M_PER_FT, SnapshotLayout, SnapshotReader, type BundleManifestCore } from "@webflight/fdm-core";
import { advance, skyCellOf, TerrariumTerrain, ThermalSky } from "@webflight/environment";
import { AircraftView } from "./aircraft.ts";
import { ChaseCamera } from "./camera.ts";
import { Hud } from "./hud.ts";
import { PilotInput } from "./input.ts";
import type { FromWorker, StartState, ToWorker, WorldConfig } from "./protocol.ts";
import { addRunway, createViewer, followShadows, SHADOW_DARKNESS, ThermalLayer, thermalView } from "./scene.ts";
import { cloudShadeRamp } from "./sun-through.ts";
import { setBuildingShade } from "./osm-layer.ts";
import { Google3D } from "./google3d.ts";
import { Lifetime } from "./lifetime.ts";
import { resolveFlight, type Flight } from "./world.ts";
import { addImagery, S2CLOUDLESS, type ImageryMode } from "./imagery.ts";
import { clearSkyGhi, cloudDecks, deckDepthScale, distanceM, soaringFrom, sounding, sunPosition, weatherAt, windAt, type WaveFieldData, type Weather, type WeatherGrid } from "@webflight/environment";
import type { DeckPlaces, DeckTarget } from "./vclouds.ts";
import { showMenu } from "./menu.ts";
import type { Viewer } from "cesium";
import { Scenery } from "./scenery.ts";
import { GrassField } from "./grass/grass-field.ts";
import { DynamicResolution } from "./dynres.ts";
import { disableHdr, enableHdr, HdrFinish } from "./hdr.ts";
import { Atmosphere, relativeHumidity } from "./atmosphere.ts";
import { setOwnSky } from "./twilight-sky.ts";
import { Water } from "./water.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import { RunwayPaint } from "./runway-paint.ts";
import { TemporalAA } from "./taa.ts";
import { Windsocks } from "./windsocks.ts";
import { CockpitInteraction } from "./interaction.ts";
import { LAUNCH_PROPERTIES, LaunchView } from "./launch-view.ts";

/** The page's URL parameters: the page-wide settings (appKey) come from these. */
const page = new URLSearchParams(location.search);
const AIRCRAFT = page.get("aircraft") ?? "ASK21";
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
 *   world=google3d (default with imagery=photo: Google Photorealistic 3D Tiles in place of the
 *     globe, our OSM buildings and trees; google3d.ts) | globe (the globe with the aerial photo)
 *   g3dsse=N          Google 3D detail (default 8, quality=low 16; lower is finer and slower)
 *   gdetail=0         no close-range ground texture over the photos
 *   quality=low | high (default: shadows, FXAA; HDR in flight) | ultra (+ 4× MSAA)
 *   sharpen=0..1      contrast-adaptive sharpening (default 0: off)
 *   dynres=0 | <scale> fixed render scale (default: 1.0–1.5× following the frame time, dynres.ts)
 *   water3d=0         Google's photo of lakes instead of our water (water.ts; wglint= glint strength)
 *   hdr=0             LDR (default: HDR with bloom, a cinematic grade and our tonemap, hdr.ts;
 *                     exposure=, bloom=, saturation=, contrast=, tone=, vignette= tune it)
 *   pin=<metres>      keep the ground within that radius of the glider loaded (default: off)
 *   shadowdist=M      how far shadows reach [m] (default: 1–4 km with the height above ground)
 *   far=N             distant buildings out to ±N zoom-14 tiles, ~1.7 km each (default 3, ultra 5; 0: off)
 *   skyline=N         beyond those, blocks and large buildings out to ±N tiles (default 6, ultra 8; 0: off)
 *   thermals=0 · seed=N (thermal placement) · columns=1 (draw lift columns)
 *   clouds=sprites    the sprite cumulus instead of the ray-marched volumes (default with quality=low)
 */
// Off by default: every change of scale makes Cesium re-pick ground tiles (popping, reloads).
// Disk cache for tiles and static assets (public/sw.js): what has been downloaded once loads
// from disk afterwards. Takes over from the next request on; ?sw=0 unregisters it.
if ("serviceWorker" in navigator) {
  if (page.get("sw") === "0") void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
  else void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch((e: unknown) => console.warn("tile cache unavailable:", e));
}
const qualityOf = (p: URLSearchParams) => (["low", "high", "ultra"].includes(p.get("quality") ?? "") ? p.get("quality") : "high") as "low" | "high" | "ultra";
const imageryOf = (p: URLSearchParams) => (["photo", "painted", "grid", "osm"].includes(p.get("imagery") ?? "") ? p.get("imagery") : p.get("map") === "osm" ? "osm" : "photo") as ImageryMode;
const DYNRES = page.get("dynres");
const QUALITY = qualityOf(page);
const IMAGERY = imageryOf(page);
const GOOGLE3D = page.get("world") !== "globe" && IMAGERY === "photo";
/**
 * The settings the viewer is built with: the menu and every flight with the same ones share
 * the page (and Google's 3D tiles session); a change of these reloads the page.
 */
function appKey(p: URLSearchParams): string {
  const im = imageryOf(p);
  const world = p.get("world") === "globe" || im !== "photo" ? "globe" : "google3d";
  return [qualityOf(p), im, world, ...["aircraft", "shadows", "sharpen", "shadowdist", "dynres", "g3dsse", "g3dgrade", "g3dreq", "g3daniso", "msaa", "gdetail", "aerial", "nosab", "pin"].map((k) => p.get(k) ?? "")].join("|");
}

async function startState(F: Flight, params: URLSearchParams): Promise<StartState> {
  const AIR_START = params.has("lat") && params.has("lon");
  const LAUNCH = AIR_START ? undefined : params.get("launch") === "winch" ? "winch" : "aerotow";
  const SEED = Number(params.get("seed") ?? 1);
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
const setStatus = (s: string) => ((status.textContent = s), (status.hidden = false));

/** What the menu and every flight in this page share. */
interface App {
  viewer: Viewer;
  /** The renderer draws the same Terrarium heights the worker flies on. */
  renderTerrain: TerrariumTerrain;
  google3d?: Google3D;
  /** Google's tiles were asked for (they may have failed: the globe then). */
  googleTried: boolean;
}
let app: App | undefined;
function ensureApp(time: Date): App {
  if (app) return app;
  const renderTerrain = new TerrariumTerrain({ zoom: 13, maxTiles: 512 });
  const viewer = createViewer(document.getElementById("cesium")!, { time, shadows: page.get("shadows") !== "0" && QUALITY !== "low", quality: QUALITY, terrain: renderTerrain, sharpen: page.has("sharpen") ? Number(page.get("sharpen")) : 0, ...(page.has("msaa") ? { msaa: Number(page.get("msaa")) } : {}), ...(page.has("shadowdist") ? { shadowDistanceM: Number(page.get("shadowdist")) } : {}) });
  return (app = { viewer, renderTerrain, googleTried: false });
}
/** Google 3D tiles in place of the globe (google3d.ts); the globe with the photo if they can't be had. */
async function ensureGoogle3D(a: App): Promise<Google3D | undefined> {
  if (!GOOGLE3D || a.googleTried) return a.google3d;
  a.googleTried = true;
  try {
    a.google3d = await Google3D.create(a.viewer, (lat, lon) => a.renderTerrain.heightAt(lat, lon), { screenSpaceError: page.has("g3dsse") ? Number(page.get("g3dsse")) : QUALITY === "low" ? 16 : 8, ...(page.get("gdetail") !== "0" ? { texBase: new URL(`${import.meta.env.BASE_URL}textures/`, location.href).href } : {}), ...(page.has("g3dgrade") ? { grade: Number(page.get("g3dgrade")) } : {}), ...(page.has("g3dreq") ? { maxRequests: Number(page.get("g3dreq")) } : {}), ...(page.has("g3daniso") ? { anisotropy: Number(page.get("g3daniso")) } : {}) });
  } catch (e) {
    console.warn("Google 3D tiles unavailable; the globe with the aerial photo instead:", e);
  }
  return a.google3d;
}

let manifestP: Promise<BundleManifestCore> | undefined;
const loadManifest = () =>
  (manifestP ??= fetch(new URL("manifest.json", BUNDLE)).then(async (res) => {
    if (!res.ok) throw new Error(`No bundle for ${AIRCRAFT} (${res.status}). Run: pnpm bundle:ask21`);
    return (await res.json()) as BundleManifestCore;
  }));

async function startFlight(params: URLSearchParams, life: Lifetime, a: App, F: Flight): Promise<void> {
  const AIR_START = params.has("lat") && params.has("lon");
  const LAUNCH = AIR_START ? undefined : params.get("launch") === "winch" ? "winch" : "aerotow";
  setStatus("Loading aircraft bundle…");
  const manifest = await loadManifest();
  const RUNWAY = F.runway, TIME = F.time;
  const WORLD: WorldConfig = { terrain: "terrarium", environment: F.environment, ...(F.series ? { weather: { series: F.series, startUtc: F.time.toISOString(), rate: Number(params.get("wxrate") ?? 1) || 1, ...(F.grid ? { grid: F.grid } : {}) } } : {}) };
  /** The weather now, as the worker's clock moves it on (set up below). */
  let onWeather: ((w: Weather) => void) | undefined;
  const { viewer, renderTerrain, google3d } = a;
  viewer.clock.currentTime = JulianDate.fromDate(TIME);
  const sun = sunPosition(TIME, F.latDeg, F.lonDeg);
  setLook(sun.elevationDeg);
  // HDR for the flight (hdr.ts), before the lighting and the clouds read it. ?hdr=0: off.
  const hdr = params.get("hdr") !== "0" && QUALITY !== "low" && enableHdr(viewer);
  if (hdr) life.onClose(() => disableHdr(viewer));
  // Our sky and haze (atmosphere.ts) in HDR with Google's tiles; ?atm=0: Cesium's.
  const ownAtmosphere = hdr && !!google3d && params.get("atm") !== "0";
  setOwnSky(ownAtmosphere);
  applyLighting(viewer, sun, F.latDeg, F.lonDeg);
  google3d?.relight();
  // Sharp orthophotos show the real runway; otherwise (painted, or 10 m Sentinel-2 where a
  // 30 m strip is a smudge) draw ours.
  const imageryReady = addImagery(viewer, IMAGERY, sun, { aerial: !google3d }).then((mode) => {
    // In photo mode the ground imagery shows the runway itself (orthophoto, or our detail tiles,
    // which paint it and take the time of day): an overlay on top would be lit differently.
    if (RUNWAY && (mode !== "photo" || params.get("detail") === "0" || params.get("runway") === "1")) addRunway(viewer, RUNWAY);
    return mode;
  });
  const soaring = soaringFrom(F.weather), cumulus = soaring.cumulus;
  // Before the clouds: its pass must run before theirs.
  let atmosphere: Atmosphere | undefined;
  /** The atmosphere's air from a weather: haze (visibility, humidity, the layer's depth), cirrus. */
  const airOf = (w: Weather) => {
    const top = [...w.aloft].sort((x, y) => y.altM - x.altM)[0];
    return { groundM: w.elevationM, hazeTopM: w.elevationM + Math.max(300, w.boundaryLayerM), humidity: relativeHumidity(w.tempC, w.dewPointC), ...(w.visibilityM !== undefined ? { visibilityKm: w.visibilityM / 1000 } : {}), ...(w.highCloud !== undefined ? { highCloud: w.highCloud } : {}), ...(top ? { aloft: { fromDeg: top.fromDeg, kt: top.kt } } : {}) };
  };
  if (ownAtmosphere) {
    atmosphere = new Atmosphere(viewer, { sun, ...airOf(F.weather) });
    life.onClose(() => atmosphere?.destroy());
  }
  const thermalLayer = new ThermalLayer(viewer, params.get("columns") === "1", sun, cumulus, google3d ? (clouds) => google3d.setCloudShadows(clouds, sun) : undefined, atmosphere);
  if (google3d) life.onClose(() => google3d.setCloudShadows([], sun));
  /**
   * The cloud decks (decks.ts): stratus to altostratus from the model's low and mid cover, at the
   * heights its humidity profile gives; drawn only, drifting with the wind at their height. Fog:
   * the haze has the visibility in the lowest layer (atmosphere.ts), so the deck starts on its
   * top. Extinction at full density: stratocumulus ~0.05 /m (in-cloud visibility ~100 m),
   * altostratus less. ?decks=0: none.
   */
  const columnDecks = (w: Weather): (DeckTarget | undefined)[] => {
    const s = soaringFrom(w), ds = cloudDecks(w, { cumulus: s.cumulus && s.wStarMs >= 0.5 });
    return (["low", "mid"] as const).map((band) => {
      const d = ds.find((x) => x.band === band);
      if (!d) return undefined;
      const base = d.fog ? Math.max(d.baseM, airOf(w).hazeTopM) : d.baseM;
      if (d.topM - base < 100) return undefined;
      const wind = windAt(w, (base + d.topM) / 2), to = ((wind.fromDeg + 180) * Math.PI) / 180, ms = wind.kt * (1852 / 3600);
      return { baseM: base, topM: d.topM, cover: d.cover, field: band === "low" || d.joined ? 0 : 1, extinction: band === "low" ? 0.05 : 0.03, windE: ms * Math.sin(to), windN: ms * Math.cos(to) };
    });
  };
  /** The weather grid as it is now (moved with the flight), and the last weather. */
  let wxGrid = F.grid, lastWeather = F.weather;
  /**
   * The decks by place: each node of the weather grid its own low and mid cover, and the depth
   * that passes its own share of the clear-sky light (its radiation: decks.ts deckDepthScale) as
   * drawn there; their heights the glider's (a band it has none of: the node's with the most).
   * The model's cover varies a lot over the grid's 66 km (5 Nov 2026 12:00: low 29–100 %, its
   * radiation 82–422 W/m²); its mid deck is joined to the low one at some nodes (~2 km) and a
   * separate one at others (~7 km), whose heights would not blend.
   */
  const decksOf = (w: Weather): { decks: (DeckTarget | undefined)[]; places?: DeckPlaces } => {
    if (params.get("decks") === "0") return { decks: [undefined, undefined] };
    const here = columnDecks(w), g = wxGrid, t = new Date(w.timeUtc);
    const nodes = g ? g.nodes.map((series) => {
      const nw = weatherAt(series, t);
      return { w: nw, d: columnDecks(nw) };
    }) : [{ w, d: here }];
    const slots = [0, 1].map((b) => here[b] ?? nodes.reduce<DeckTarget | undefined>((best, n) => (n.d[b] && (!best || n.d[b]!.cover > best.cover) ? n.d[b] : best), undefined));
    const cover = (b: number) => Float32Array.from(nodes, (n) => (slots[b] ? n.d[b]?.cover ?? 0 : 0));
    const low = cover(0), mid = cover(1);
    const clear = (nw: Weather) => nw.shortwaveWm2 / Math.max(1, clearSkyGhi(sun.elevationDeg));
    const scale = Float32Array.from(nodes, (n, k) =>
      deckDepthScale(slots.flatMap((d, b) => {
        const c = (b === 0 ? low : mid)[k]!;
        return d && c > 0 ? [{ cover: c, tau: d.extinction * 0.75 * (d.topM - d.baseM) }] : [];
      }), clear(n.w), sun.elevationDeg),
    );
    const places: DeckPlaces = g ? { lat0: g.lat0, lon0: g.lon0, dLat: g.dLat, dLon: g.dLon, rows: g.rows, cols: g.cols, low, mid, scale } : { lat0: F.latDeg, lon0: F.lonDeg, dLat: 1, dLon: 1, rows: 1, cols: 1, low, mid, scale };
    const decks = slots.map((d, b) => {
      const most = Math.max(...(b === 0 ? low : mid));
      return d && most > 0.005 ? { ...d, cover: most } : undefined;
    });
    return { decks, places };
  };
  const setDecks = (w: Weather) => {
    lastWeather = w;
    const r = decksOf(w);
    thermalLayer.setDecks(r.decks, r.places);
  };
  setDecks(F.weather);
  google3d?.setDeckShade(() => thermalLayer.deckShade());
  /**
   * The glider in a cloud's shade (sun-through.ts: the towers and holes drawn, whose shade is on
   * the ground): lit as in a cast shadow, all its light times the ground's factor there (1 − 0.65
   * of the light the cloud takes, cloudShadeRamp), and the shadows on and round it (Cesium's,
   * the whole colour times their darkness) as much lighter, so the two don't stack: in full
   * shade it casts none. The grass round it the same. m: the glider's model matrix (ECEF).
   */
  const gliderWC = new Cartesian3(), sunWC = new Cartesian3();
  let cloudLight = 1;
  const uniforms = (viewer.scene as unknown as { context: { uniformState: { lightDirectionWC: Cartesian3 } } }).context.uniformState;
  const shadeGlider = (m: ArrayLike<number>) => {
    Cartesian3.fromElements(m[12]!, m[13]!, m[14]!, gliderWC);
    Cartesian3.normalize(uniforms.lightDirectionWC, sunWC);
    const s = thermalLayer.sunAt(gliderWC, sunWC);
    const k = 1 - 0.65 * cloudShadeRamp(sun.elevationDeg) * (1 - Math.min(1 - s.cumulus, s.deck));
    aircraft.cloudShade(k, viewer.scene.light);
    if (viewer.shadows) viewer.scene.shadowMap.darkness = Math.min(1, SHADOW_DARKNESS / k);
    if (grass) grass.cloudK = k;
    cloudLight = k;
  };
  if (google3d) life.onClose(() => google3d.setDeckShade(undefined));
  // 3D scenery (Switzerland): buildings, trees, water. ?buildings=0 / trees=0 / water=0 to turn off.
  // After the imagery probe, so the scenery downloads don't starve it.
  const imageryMode = await imageryReady;
  // With Google 3D: their buildings, trees and water; our grass near the glider (the tiles
  // are a blur at the height of a cockpit), and our OSM buildings under theirs, standing where
  // their tiles are flat (villages). The glider still flies on the Terrarium heights.
  const scenery = Scenery.create(viewer, { latDeg: F.latDeg, lonDeg: F.lonDeg }, { buildings: params.get("buildings") !== "0" && QUALITY !== "low", underGoogle: !!google3d, trees: params.get("trees") !== "0" && QUALITY !== "low" && !google3d, water: params.get("water") !== "0" && !google3d, shadows: QUALITY !== "low" && params.get("shadows") !== "0", treeDetail: QUALITY === "ultra" ? 12 : 24, drape: imageryMode === "photo", osmTreeSpacingM: QUALITY === "ultra" ? 7 : 8, osmTreeRings: QUALITY === "ultra" ? 6 : 4, osmFarRings: params.has("far") ? Number(params.get("far")) : QUALITY === "ultra" ? 5 : 3, osmSkylineRings: params.has("skyline") ? Number(params.get("skyline")) : QUALITY === "ultra" ? 8 : 6 });
  // 3D grass near the camera when it is low (on the field, low passes). ?grass=0|1.
  const grassParam = params.get("grass");
  const osmTiles = await openFreeMapTiles();
  // Runways painted on Google's tiles from the airfield data (runway-paint.ts). ?rwpaint=0: off.
  const runways = google3d?.tileset.customShader && params.get("rwpaint") !== "0" ? new RunwayPaint(viewer, google3d.tileset.customShader, osmTiles, new URL(`${import.meta.env.BASE_URL}textures/`, location.href).href) : undefined;
  if (runways) life.onClose(() => runways.destroy());
  // Windsocks by the runways, showing the day's surface wind (windsocks.ts). ?windsocks=0: off.
  const windsocks = runways && params.get("windsocks") !== "0" ? new Windsocks(viewer, runways, google3d, (la, lo) => renderTerrain.heightAt(la, lo), { fromDeg: F.environment.windFromDeg, kt: F.environment.windKt }) : undefined;
  if (windsocks) life.onClose(() => windsocks.destroy());
  // Our water on Google's tiles (water.ts): with our sky only. ?water3d=0: Google's photo.
  const water = google3d && atmosphere && params.get("water3d") !== "0" ? new Water(viewer, google3d, atmosphere, (la, lo, z) => renderTerrain.heightAt(la, lo, z), osmTiles) : undefined;
  // Last of the post-process stages (after the clouds and the water's reflections): bloom,
  // exposure, the grade, the tonemap (?exposure=, ?bloom=, … for tuning).
  const num = (k: string) => (params.has(k) ? { [k]: Number(params.get(k)) } : {});
  const hdrFinish = hdr ? new HdrFinish(viewer, { ...num("exposure"), ...num("bloom"), ...num("saturation"), ...num("contrast"), ...num("tone"), ...num("vignette") }) : undefined;
  // Temporal anti-aliasing (taa.ts), after it: the very last stage. ?taa=0: Cesium's FXAA.
  const taa = hdrFinish && params.get("taa") !== "0" ? new TemporalAA(viewer, { ...(params.has("taasharp") ? { sharpen: Number(params.get("taasharp")) } : {}) }) : undefined;
  if (taa) life.onClose(() => taa.destroy());
  const grass =
    osmTiles && (grassParam === "1" || (grassParam !== "0" && QUALITY !== "low"))
      ? new GrassField(viewer, osmTiles, S2CLOUDLESS, { density: params.has("grassdensity") ? Number(params.get("grassdensity")) : QUALITY === "ultra" ? 500 : 320, tuft: params.has("grasstuft") ? Number(params.get("grasstuft")) : 6, ...(google3d ? { google3d } : {}), ...(runways ? { strip: () => runways.grassStrip() } : {}) }, F.latDeg)
      : undefined;
  const launchView = LAUNCH ? new LaunchView(viewer.scene, new URL("bundles/_models/", new URL(import.meta.env.BASE_URL, location.href)).href) : undefined;
  let waveBuildMs: number | undefined;
  let air: { windFromDeg: number; windKt: number; thermalLiftMs: number; ridgeLiftMs: number; waveLiftMs?: number } | undefined;
  const aircraft = new AircraftView(manifest, BUNDLE);
  let skyVersion = -1;
  const hudEl = document.getElementById("hud")!;
  const hud = new Hud(hudEl);
  life.onClose(() => hudEl.replaceChildren());
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
  /** The weather by place moved with the glider: the flight model's, and the far skies'. */
  const gridHooks: ((g: WeatherGrid) => void)[] = [(g) => send({ type: "grid", grid: g }), (g) => ((wxGrid = g), setDecks(lastWeather))];
  const gridMoved = (g: WeatherGrid) => gridHooks.forEach((f) => f(g));
  life.onClose(() => worker.terminate());
  let reader: SnapshotReader | undefined;
  let layout: SnapshotLayout | undefined;
  let shared = false;
  let localSnap: ArrayBuffer | undefined;
  let paused = false;
  let fdmHz = 0;
  /** The flight model's simulated time [s] (its stats, every second). */
  let simS = 0;
  const input = new PilotInput({
    reset: () =>
      void startState(F, params).then((start) => {
        // The grid back round the start first (its columns are had): the start's own weather.
        const g = F.gridFollower?.moveNow(start.latDeg, start.lonDeg);
        if (g) gridMoved(g);
        send({ type: "reset", start });
      }),
    toggleView: () => cam.toggle(),
    togglePause: () => send({ type: "pause", paused: (paused = !paused) }),
    toggleHelp: () => hud.toggleHelp(),
    launch: () => send({ type: "launch", action: "start" }),
    release: () => send({ type: "launch", action: "release" }),
    winchFaster: () => send({ type: "launch", action: "faster" }),
    winchSlower: () => send({ type: "launch", action: "slower" }),
    menu: () => go(`?menu&time=${encodeURIComponent(params.get("time") ?? "now")}${F.field ? `&field=${F.field.ident}&at=${F.field.latDeg},${F.field.lonDeg}` : ""}&${appParams(params)}`),
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
          simS = m.simTime;
          break;
        case "log":
          if (/error|warn|not ported|not supported/i.test(m.line)) console.warn("[fdm]", m.line);
          else if (m.line.startsWith("air at")) console.info("[fdm]", m.line);
          break;
        case "environment":
          thermalLayer.update(m.thermals);
          air = { windFromDeg: m.windFromDeg, windKt: m.windKt, thermalLiftMs: m.thermalLiftMs, ridgeLiftMs: m.ridgeLiftMs, ...(m.waveLiftMs !== undefined ? { waveLiftMs: m.waveLiftMs } : {}) };
          grass?.setWind(m.surfaceFromDeg, m.surfaceKt);
          water?.setWind(m.surfaceFromDeg, m.surfaceKt);
          break;
        case "messages":
          for (const l of m.lines) hud.message(l);
          break;
        case "weather":
          onWeather?.(m.weather);
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
  const start = await startState(F, params);
  // Clouds to the horizon: the flight model's thermals reach ~20 km; the same sky model (same
  // seed: the same thermals, cell by cell) out to ~50 km gives the clouds beyond (visual only).
  let gliderAt = { latDeg: start.latDeg, lonDeg: start.lonDeg };
  // The weather moving on (the worker's clock): far skies, the clouds' cumulus, waves.
  const weatherHooks: ((w: Weather) => void)[] = [(w) => thermalLayer.setCumulus(soaringFrom(w).cumulus)];
  onWeather = (w) => weatherHooks.forEach((f) => f(w));
  // The sun with the flight's clock: Cesium's clock (its sun light, so the light on everything
  // and the shadows), the light's colour (and below 5° its direction), our sky and haze, and
  // everything holding the start's `sun` (the cloud shadows on the ground) through it.
  weatherHooks.push((w) => {
    const t = new Date(w.timeUtc);
    viewer.clock.currentTime = JulianDate.fromDate(t);
    Object.assign(sun, sunPosition(t, F.latDeg, F.lonDeg));
    setSunLight(viewer, sun, F.latDeg, F.lonDeg);
    atmosphere?.setSun(sun);
    // The haze and the cirrus of the hour; the tints of the sun's height (dusk, night) on the
    // ground: Google's tiles (their light and haze), the globe and its imagery.
    atmosphere?.setAir(airOf(w));
    setDecks(w);
    setLook(sun.elevationDeg);
    tintGround(viewer);
    google3d?.relight();
    aircraft.relight();
  });
  // (Built also on a blue start: the day may turn to cumulus.)
  if (F.environment.thermalSky) {
    const farSky = new ThermalSky({ ...F.environment.thermalSky, radiusCells: 7, groundAt: (la, lo) => renderTerrain.heightAt(la, lo, 11) });
    // And on to the horizon (~160 km): the same sky on coarse terrain (zoom 9, ~25 tiles), its
    // cells beyond the ring above; drawn from the clouds' far map (vclouds.ts).
    const outerSky = new ThermalSky({ ...F.environment.thermalSky, radiusCells: 27, groundAt: (la, lo) => renderTerrain.heightAt(la, lo, 9) });
    const e = F.environment;
    let wind = { groundFromDeg: e.windFromDeg, groundKt: e.windKt, aloftFromDeg: e.aloftFromDeg ?? e.windFromDeg, aloftKt: e.aloftKt ?? e.windKt };
    // Visual only, thousands of thermals: every 5 simulated minutes is enough.
    let farWx = Date.parse(F.weather.timeUtc);
    gridHooks.push((g) => (farSky.setGrid(g), outerSky.setGrid(g)));
    weatherHooks.push((w) => {
      const t = Date.parse(w.timeUtc);
      if (Math.abs(t - farWx) < 5 * 60_000) return;
      farWx = t;
      farSky.setWeather(w);
      outerSky.setWeather(w);
      const a = w.aloft[0];
      wind = { groundFromDeg: w.windFromDeg, groundKt: w.windKt, aloftFromDeg: a?.fromDeg ?? w.windFromDeg, aloftKt: a?.kt ?? w.windKt };
    });
    // Their thermals' cycles on the flight's clock, as the flight model's (they kept going while
    // paused, and drifted from its thermals' cycles: the cloud handed between them changed).
    let farSimS = simS;
    const tickFar = () => {
      const dt = Math.min(10, Math.max(0, simS - farSimS));
      farSimS = simS;
      farSky.update(dt, { ...gliderAt, altFt: 0 }, wind);
      outerSky.update(dt, { ...gliderAt, altFt: 0 }, wind);
      const [cx, cy] = skyCellOf(gliderAt.latDeg, gliderAt.lonDeg);
      const beyond = outerSky.thermals.filter((t) => {
        const [x, y] = t.id.split(":").map(Number) as [number, number];
        return Math.abs(x - cx) > 7 || Math.abs(y - cy) > 7;
      });
      thermalLayer.setFar([...farSky.thermals, ...beyond].map(thermalView));
    };
    tickFar();
    setInterval(tickFar, 3000);
  }
  // The weather by place moves on with the glider (GridFollower, ~5 columns asked for once it is
  // within 16.5 km of the grid's edge), checked as often as the waves below.
  const follower = F.gridFollower;
  if (follower) {
    const timer = setInterval(() => {
      follower.follow(gliderAt.latDeg, gliderAt.lonDeg).then(
        (g) => {
          if (!g) return;
          gridMoved(g);
          console.info(`weather grid moved: centre ${(g.lat0 + ((g.rows - 1) / 2) * g.dLat).toFixed(3)}, ${(g.lon0 + ((g.cols - 1) / 2) * g.dLon).toFixed(3)}`);
        },
        (e: unknown) => console.warn(`weather grid: ${e instanceof Error ? e.message : String(e)} (its edge's weather beyond it)`),
      );
    }, 5000);
    life.onClose(() => clearInterval(timer));
  }
  // Mountain waves (waves.ts) for the day's pressure levels: built off the main thread round the
  // glider, again when it is 20 km from the last centre; the flight model adds them to the air.
  // (No levels with temperatures, as for reanalysis days: no waves.) ?waves=0 turns them off.
  let levels = sounding(F.weather);
  if (levels.length >= 2 && params.get("waves") !== "0") {
    const ww = new Worker(new URL("./wave-worker.ts", import.meta.url), { type: "module" });
    let centre: { latDeg: number; lonDeg: number } | undefined, busy = false, id = 0;
    const want = () => {
      const c = gliderAt;
      if (busy || (centre && distanceM(c.latDeg, c.lonDeg, centre.latDeg, centre.lonDeg) < 20_000)) return;
      busy = true;
      centre = { ...c };
      ww.postMessage({ id: ++id, latDeg: c.latDeg, lonDeg: c.lonDeg, levels });
    };
    ww.onmessage = (ev: MessageEvent<{ field: WaveFieldData | null; ms?: number; error?: string }>) => {
      busy = false;
      const f = ev.data.field;
      if (f) worker.postMessage({ type: "waves", field: f } satisfies ToWorker, [f.data.buffer]);
      else console.warn("waves:", ev.data.error ?? "no field");
      waveBuildMs = ev.data.ms;
    };
    // Built again for the air every half hour of the flight's clock, where it is now.
    let wavesWx = Date.parse(F.weather.timeUtc);
    weatherHooks.push((w) => {
      const t = Date.parse(w.timeUtc), next = sounding(w);
      if (Math.abs(t - wavesWx) < 30 * 60_000 || next.length < 2) return;
      wavesWx = t;
      levels = next;
      centre = undefined;
      want();
    });
    want();
    const timer = setInterval(want, 5000);
    life.onClose(() => (clearInterval(timer), ww.terminate()));
  }
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
  // The flight model stays paused (the worker starts so) behind the loading screen, until the
  // ground is in: below.
  setStatus("Loading the ground…");
  const interaction = new CockpitInteraction(viewer, aircraft, send, cam);
  if (aircraft.texMissing.length) console.warn("texture animations without readers:", aircraft.texMissing);

  let last = performance.now();
  let fps = 60;
  // ?smooth=0: draw the newest snapshot as it is (to compare).
  const SMOOTH = params.get("smooth") !== "0";
  let smoother: { layout: SnapshotLayout; s: PoseSmoother } | undefined;
  const dynres = new DynamicResolution(viewer, DYNRES === null ? undefined : DYNRES === "0" ? 1 : Number(DYNRES) || 1);
  life.onClose(() => dynres.reset());
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    if (life.isClosed) return;
    dynres.update(now, status.hidden);

    const controls = input.update(dt);
    send({ type: "controls", controls });
    if (!reader || !layout) return;
    reader.read();
    // The pose at a smoothly running clock between the flight model's steps (pose-smoother.ts):
    // the newest snapshot each frame moved the glider, and the camera with it, in uneven jumps.
    if (smoother?.layout !== layout) smoother = { layout, s: new PoseSmoother(layout) };
    const d = SMOOTH ? smoother.s.frame(reader.data, dt) : reader.data;
    const g = (n: string) => d[layout!.at(n)]!;

    aircraft.showInterior(cam.mode === "cockpit");
    const m = aircraft.update(d, layout, dt);
    shadeGlider(m);
    // The glider mirrors the sky drawn round it (once the atmosphere has read it, and again
    // as it re-reads it).
    const gm = aircraft.gltfModel?.customShader;
    if (gm && atmosphere && skyVersion !== atmosphere.ambientVersion) {
      const sk = atmosphere.skyAmbient();
      if (sk) {
        skyVersion = atmosphere.ambientVersion;
        reflectSky(gm, sk);
      }
    }
    cam.update(m, { phi: g("attitude/phi-rad"), theta: g("attitude/theta-rad"), psi: g("attitude/psi-rad") }, dt);
    launchView?.update(d, layout, dt, (g("position/geod-alt-ft") - g("position/h-agl-ft")) * M_PER_FT);
    scenery?.update(g("position/lat-geod-deg"), g("position/long-gc-deg"));
    water?.follow(g("position/lat-geod-deg"), g("position/long-gc-deg"));
    gliderAt = { latDeg: g("position/lat-geod-deg"), lonDeg: g("position/long-gc-deg") };
    followShadows(viewer, g("position/h-agl-ft") * M_PER_FT, cam.mode === "cockpit");
    google3d?.update(g("position/lat-geod-deg"), g("position/long-gc-deg"), g("position/h-agl-ft") * M_PER_FT);
    // Our buildings in the clouds' shade as Google's ground round them.
    if (google3d) setBuildingShade(google3d.shade, google3d.shadeTextures());
    // Ground tiles follow the glider too (eye 4 m above it: about the chase camera's height).
    pinGround(g("position/lat-geod-deg"), g("position/long-gc-deg"), g("position/geod-alt-ft") * M_PER_FT + 4);
    // Grass follows the glider, not the camera: looking around rebuilds nothing.
    if (grass) {
      const camC = viewer.camera.positionCartographic;
      const camGround = renderTerrain.heightAt((camC.latitude * 180) / Math.PI, (camC.longitude * 180) / Math.PI);
      grass.follow(g("position/lat-geod-deg"), g("position/long-gc-deg"), camGround === undefined ? 0 : camC.height - camGround);
    }
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
  const w = window as unknown as { webflight: unknown };
  w.webflight = { viewer, input, aircraft, cam, interaction, scenery, google3d, grass, thermalLayer, dynres, hdrFinish, taa, atmosphere, water, runways, windsocks, get layout() { return layout; }, get reader() { return reader; }, get air() { return air; }, get waveBuildMs() { return waveBuildMs; }, get cloudLight() { return cloudLight; }, send };
  life.onClose(() => (w.webflight = undefined));

  // Behind the loading screen until the ground under the glider is in: Google's tiles in view
  // and their height offset settled (else the globe's tiles), and the grass near it when low,
  // so a flight never starts over a blur or with the glider in the ground. The frame loop
  // runs meanwhile (it streams the tiles and measures the offset); the flight model is
  // paused. At most 60 s.
  const t0 = performance.now();
  if (grass) grass.loading = true;
  if (water) water.loading = true;
  await new Promise<void>((done) => {
    const tick = () => {
      if (life.isClosed) return done();
      const t = google3d?.tileset;
      const st = (t as unknown as { statistics?: { numberOfPendingRequests: number; numberOfTilesProcessing: number } } | undefined)?.statistics;
      const tiles = st ? st.numberOfPendingRequests + st.numberOfTilesProcessing : 0;
      const ground = google3d ? google3d.settled : viewer.scene.globe.tilesLoaded;
      const lawn = !grass || grass.settled || grass.idle;
      const waited = performance.now() - t0;
      if ((ground && lawn && waited > 1500) || waited > 60_000) return done();
      setStatus(`Loading the ground…${tiles ? ` ${tiles} tiles` : ""}`);
      setTimeout(tick, 250);
    };
    tick();
  });
  if (grass) grass.loading = false;
  if (water) water.loading = false;
  if (life.isClosed) return;
  status.hidden = true;
  // From here clouds change only gradually (scene.ts ThermalLayer.follow).
  thermalLayer.gradual = true;
  send({ type: "pause", paused });
}

/** The page-wide parameters of p, for links within the app (appKey). */
function appParams(p: URLSearchParams): string {
  const o = new URLSearchParams();
  for (const k of ["quality", "imagery", "world", "aircraft", "shadows", "sharpen", "shadowdist", "dynres", "g3dsse", "g3dgrade", "g3dreq", "g3daniso", "msaa", "gdetail", "aerial", "nosab", "pin"]) {
    const v = p.get(k);
    if (v !== null) o.set(k, v);
  }
  return o.toString();
}

/*
 * One page for the title screen and every flight: going from one to the other closes what the
 * last one added (lifetime.ts) and keeps the viewer and Google's 3D tiles, so their session
 * (metered by Cesium ion per root tile, up to three hours each) carries over. A change of the
 * page-wide settings (appKey: quality, scenery, …) reloads the page; so does leaving a flight
 * on the globe (the photo layers it adds are not undone).
 */
const isMenu = (p: URLSearchParams) => [...p.keys()].length === 0 || p.has("menu");
let current: { life: Lifetime; flight: boolean } | undefined;
let busy = false;

async function show(url: URL, history: "push" | "replace" | "none"): Promise<void> {
  const p = url.searchParams;
  const toMenu = isMenu(p);
  const globe = !GOOGLE3D || (app?.googleTried && !app.google3d);
  if (current && (appKey(p) !== appKey(page) || (globe && (current.flight || !toMenu)))) {
    location.assign(url.href);
    return;
  }
  if (busy) return;
  busy = true;
  try {
    current?.life.close();
    current = undefined;
    if (history === "push") window.history.pushState(null, "", url.href);
    else if (history === "replace") window.history.replaceState(null, "", url.href);
    if (toMenu) {
      const a = ensureApp(new Date());
      const life = new Lifetime(a.viewer);
      current = { life, flight: false };
      await showMenu(p, { viewer: a.viewer, terrain: a.renderTerrain, ...(a.google3d ? { google3d: a.google3d } : {}), life, go });
    } else {
      setStatus("Airfield, runway and weather…");
      const F = await resolveFlight(p);
      const a = ensureApp(F.time);
      // Before the flight's lifetime: the tiles outlive it.
      if (GOOGLE3D) setStatus("Google 3D tiles…");
      await ensureGoogle3D(a);
      const life = new Lifetime(a.viewer);
      current = { life, flight: true };
      await startFlight(p, life, a, F);
    }
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  } finally {
    busy = false;
  }
}
function go(href: string, replace = false): void {
  void show(new URL(href, location.href), replace ? "replace" : "push");
}
window.addEventListener("popstate", () => void show(new URL(location.href), "none"));
void show(new URL(location.href), "none");
