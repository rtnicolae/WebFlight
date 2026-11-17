/**
 * Title screen: a slow orbit over the chosen airfield in the chosen day's weather. Pick an
 * airfield (any in Europe), when, and how to launch; everything else comes from the data.
 * "Fly" starts the sim at its URL parameters (any flight can be bookmarked), in the same page
 * (main.ts): the viewer and Google's 3D tiles carry over.
 *
 * The backdrop costs nothing metered: Google's 3D tiles once a flight has opened their
 * session (it lasts up to three hours), before that the globe with Sentinel-2 (free; it used
 * to be Bing via Cesium ion, a metered session on every visit to this screen).
 */
import { HeadingPitchRange, Cartesian3, Credit, ImageryLayer, JulianDate, Matrix4, UrlTemplateImageryProvider, Math as CMath, type Viewer } from "cesium";
import { advance, loadAirfieldIndex, searchAirfields, soaringFrom, sunPosition, type TerrariumTerrain, ThermalSky } from "@webflight/environment";
import type { Google3D } from "./google3d.ts";
import { S2CLOUDLESS, type ImageryMode } from "./imagery.ts";
import type { Lifetime } from "./lifetime.ts";
import { applyLighting, setLook } from "./lighting.ts";
import { ThermalLayer, thermalView } from "./scene.ts";
import { Scenery } from "./scenery.ts";
import type { ThermalView } from "./protocol.ts";
import { resolveFlight } from "./world.ts";

const ICONS: Record<string, string> = {
  winch: `<svg viewBox="0 0 40 40"><path d="M4 32h32"/><circle cx="32" cy="28" r="3"/><path d="M30 26L10 12"/><path d="M6 14l8-4 1 3"/></svg>`,
  aerotow: `<svg viewBox="0 0 40 40"><path d="M24 14h12M30 10v8M27 18h6"/><path d="M24 14L10 22"/><path d="M4 22h12M10 20v4"/></svg>`,
};

const LAUNCHES = [
  { id: "aerotow", name: "Aerotow", text: "Behind the tug: L to start, O to release." },
  { id: "winch", name: "Winch", text: "Cable launch: L to start, O to release." },
] as const;

/** What the menu remembers; the airfield as ident + position (the position selects its data tile). */
type Pick = { field?: string; at?: string; launch: string; time: string; imagery: ImageryMode; world: string; quality: string };

function segmented(parent: HTMLElement, label: string, options: [string, string][], value: string, onPick: (v: string) => void): void {
  const sec = document.createElement("div");
  sec.className = "menu-section";
  sec.innerHTML = `<h2>${label}</h2>`;
  const seg = document.createElement("div");
  seg.className = "menu-seg";
  for (const [v, text] of options) {
    const b = document.createElement("button");
    b.textContent = text;
    b.setAttribute("aria-pressed", String(v === value));
    b.onclick = () => {
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      onPick(v);
    };
    seg.appendChild(b);
  }
  sec.appendChild(seg);
  parent.appendChild(sec);
}

export interface MenuEnv {
  viewer: Viewer;
  terrain: TerrariumTerrain;
  /** Google's 3D tiles, when a flight has opened their session. */
  google3d?: Google3D;
  life: Lifetime;
  /** Show another page of the app (menu or flight) without reloading; replace: no history entry. */
  go: (href: string, replace?: boolean) => void;
}

export async function showMenu(params: URLSearchParams, env: MenuEnv): Promise<void> {
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem("webflight.menu") ?? "{}") as Partial<Pick>;
    } catch {
      return {};
    }
  })();
  const field0 = params.get("field") ?? remembered.field;
  const at0 = params.get("field") ? params.get("at") ?? undefined : remembered.at;
  const pick: Pick = {
    ...(field0 && at0 ? { field: field0, at: at0 } : {}),
    launch: params.get("launch") ?? remembered.launch ?? "aerotow",
    time: params.get("time") ?? remembered.time ?? "now",
    imagery: (params.get("imagery") as ImageryMode | null) ?? remembered.imagery ?? "photo",
    // Google 3D tiles (the default) or the globe with the aerial photo (main.ts).
    world: params.get("world") ?? remembered.world ?? "google3d",
    quality: params.get("quality") ?? remembered.quality ?? "high",
  };
  const q = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(pick.field && pick.at ? { field: pick.field, at: pick.at } : {}), time: pick.time, ...extra });
  /** The page-wide settings (main.ts appKey): a change of these reloads the page. */
  const app = (): Record<string, string> => ({ imagery: pick.imagery, quality: pick.quality, ...(pick.world === "globe" ? { world: "globe" } : {}) });

  // The flight as the sim will resolve it: airfield, runway in use, weather.
  const F = await resolveFlight(q());
  const field = F.field;
  if (field) Object.assign(pick, { field: field.ident, at: `${field.latDeg},${field.lonDeg}` });

  const root = document.getElementById("menu")!;
  root.hidden = false;
  env.life.onClose(() => {
    root.replaceChildren();
    root.hidden = true;
  });
  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.innerHTML = `<h1 class="menu-title">WebFlight</h1><p class="menu-tagline">Gliding in Europe · ASK 21 · JSBSim</p>`;

  // Airfield: any in Europe, by name, town or ICAO code (the index loads on first search).
  {
    const sec = document.createElement("div");
    sec.className = "menu-section menu-field";
    sec.innerHTML = `<h2>Airfield</h2><input type="search" placeholder="Search Europe: name, town or ICAO" aria-label="Search airfields" /><div class="menu-field-now"></div><div class="menu-field-list" role="listbox"></div>`;
    sec.querySelector(".menu-field-now")!.textContent = field && F.runway ? `${field.name} (${field.ident}) · runway ${F.runway.name.split("/")[0]} in use · ${Math.round(F.runway.lengthM)} m ${F.runway.paved ? "paved" : "grass"}` : "Airfield data unavailable";
    const input = sec.querySelector("input")!;
    const list = sec.querySelector(".menu-field-list")!;
    input.oninput = async () => {
      const all = await loadAirfieldIndex();
      list.replaceChildren(
        ...searchAirfields(all, input.value, 8).map((a) => {
          const b = document.createElement("button");
          b.textContent = `${a.name} · ${a.municipality || a.country} (${a.ident})`;
          b.onclick = () => {
            Object.assign(pick, { field: a.ident, at: `${a.latDeg},${a.lonDeg}` });
            save();
            env.go(`?menu&${q(app())}`, true); // move the backdrop
          };
          return b;
        }),
      );
    };
    input.onkeydown = (e) => e.stopPropagation(); // Enter flies only outside the search box
    panel.appendChild(sec);
  }

  const cards = document.createElement("div");
  cards.className = "menu-section";
  cards.innerHTML = `<h2>Launch</h2>`;
  const list = document.createElement("div");
  list.className = "menu-cards";
  for (const s of LAUNCHES) {
    const b = document.createElement("button");
    b.className = "menu-card";
    b.setAttribute("aria-pressed", String(s.id === pick.launch));
    b.innerHTML = `${ICONS[s.id]}<div><b>${s.name}</b><span>${s.text}</span></div>`;
    b.onclick = () => {
      list.querySelectorAll(".menu-card").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      pick.launch = s.id;
    };
    b.ondblclick = () => fly();
    list.appendChild(b);
  }
  cards.appendChild(list);
  panel.appendChild(cards);

  const opts = document.createElement("div");
  opts.className = "menu-options";
  panel.appendChild(opts);
  // When: now, or any local date and time at the field (that hour's weather).
  {
    const sec = document.createElement("div");
    sec.className = "menu-section";
    const local = new Date(F.time.getTime() + F.weather.utcOffsetH * 3600_000).toISOString().slice(0, 16);
    // Any hour of the last ten years (historical reanalysis) up to the 16-day forecast.
    const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
    sec.innerHTML = `<h2>When (local time)</h2><div class="menu-when"><button aria-pressed="${pick.time === "now"}">Now</button><input type="datetime-local" value="${local}" min="${day(-3653)}T00:00" max="${day(15)}T23:59" aria-label="Local date and time" /></div>`;
    sec.querySelector("button")!.onclick = () => {
      pick.time = "now";
      save();
      env.go(`?menu&${q(app())}`, true);
    };
    const input = sec.querySelector("input")!;
    input.onchange = () => {
      if (!input.value) return;
      pick.time = input.value;
      save();
      env.go(`?menu&${q(app())}`, true); // new weather and light
    };
    opts.appendChild(sec);
  }
  const wx = document.createElement("p");
  wx.className = "menu-weather";
  wx.textContent = F.weatherText;
  opts.appendChild(wx);
  segmented(opts, "Scenery", [["google3d", "Google 3D"], ["photo", "Photos"], ["painted", "Painted"]], pick.world !== "globe" && pick.imagery === "photo" ? "google3d" : pick.imagery, (v) => {
    pick.world = v === "google3d" ? "google3d" : "globe";
    pick.imagery = (v === "google3d" ? "photo" : v) as ImageryMode;
  });
  segmented(opts, "Quality", [["low", "Low"], ["high", "High"], ["ultra", "Ultra"]], pick.quality, (v) => (pick.quality = v));
  const go = document.createElement("button");
  go.className = "menu-fly";
  go.textContent = "Fly";
  go.onclick = () => fly();
  panel.appendChild(go);
  const foot = document.createElement("div");
  foot.className = "menu-foot";
  foot.innerHTML =
    "Keyboard or gamepad. H shows the controls in flight, Esc comes back here.<br>Aircraft: FlightGear ASK 21 (GPL). Terrain: Mapzen Terrarium. Scenery: Google Photorealistic 3D Tiles; imagery: Bing Maps (both via Cesium ion), swisstopo, IGN, basemap.at, EOX Sentinel-2 cloudless. Maps: OpenStreetMap via OpenFreeMap. Airfields: OurAirports. Weather data by Open-Meteo.com.";
  panel.appendChild(foot);
  root.appendChild(panel);

  function save(): void {
    try {
      localStorage.setItem("webflight.menu", JSON.stringify(pick));
    } catch {}
  }
  function fly(): void {
    save();
    env.go(`?${q({ launch: pick.launch, ...app() })}`);
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fly();
  });

  // Backdrop: the real scene, orbiting slowly.
  const date = F.time;
  const { viewer, terrain } = env;
  (window as unknown as { webflightViewer: unknown }).webflightViewer = viewer;
  const sun = sunPosition(date, F.latDeg, F.lonDeg);
  viewer.clock.currentTime = JulianDate.fromDate(date);
  setLook(sun.elevationDeg);
  applyLighting(viewer, sun, F.latDeg, F.lonDeg);
  if (env.google3d) env.google3d.relight();
  else {
    // Sentinel-2 cloudless (free, 10 m): plenty for an orbit 5 km out.
    const s2 = new ImageryLayer(new UrlTemplateImageryProvider({ url: S2CLOUDLESS, maximumLevel: 15, credit: new Credit('Sentinel-2 cloudless 2016 by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2016), CC BY 4.0') }));
    viewer.imageryLayers.add(s2);
    env.life.onClose(() => viewer.imageryLayers.remove(s2));
  }
  // The day's thermals and cumulus, streamed in as their terrain loads (as in flight).
  const layer = new ThermalLayer(viewer, false, sun, soaringFrom(F.weather).cumulus, env.google3d ? (clouds) => env.google3d!.setCloudShadows(clouds, sun) : undefined);
  if (env.google3d) env.life.onClose(() => env.google3d!.setCloudShadows([], sun));
  if (F.environment.thermalSky) {
    const sky = new ThermalSky({ ...F.environment.thermalSky, radiusCells: 6, groundAt: (la, lo) => terrain.heightAt(la, lo, 11) });
    const wind = { groundFromDeg: F.environment.windFromDeg, groundKt: F.environment.windKt, aloftFromDeg: F.environment.aloftFromDeg ?? F.environment.windFromDeg, aloftKt: F.environment.aloftKt ?? F.environment.windKt };
    const tick = () => {
      sky.update(2, { latDeg: F.latDeg, lonDeg: F.lonDeg, altFt: 0 }, wind);
      layer.update(sky.thermals.map(thermalView));
    };
    tick();
    setInterval(tick, 2000);
  }
  // Lakes and rivers read well from the orbit; buildings and trees are too small up here.
  // (Google's tiles have their own.)
  if (!env.google3d) Scenery.create(viewer, { latDeg: F.latDeg, lonDeg: F.lonDeg }, { buildings: false, trees: false, water: true, shadows: false, treeDetail: 24, drape: false });
  document.getElementById("boot")!.hidden = true;
  // Orbit a point a few km upwind of the field.
  const [cLat, cLon] = advance(F.latDeg, F.lonDeg, F.environment.windFromDeg, 3000);
  const groundM = await terrain.heightAtAsync(cLat, cLon).catch(() => 500);
  const centre = Cartesian3.fromDegrees(cLon, cLat, groundM + 450);
  // lookAt leaves the camera in the centre's frame: back to the earth's for the flight.
  env.life.onClose(() => viewer.camera.lookAtTransform(Matrix4.IDENTITY));
  let heading = CMath.toRadians(200);
  let last = performance.now();
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    heading += ((now - last) / 1000) * CMath.toRadians(1.6);
    last = now;
    viewer.camera.lookAt(centre, new HeadingPitchRange(heading, CMath.toRadians(-11), 5200));
  });
}
