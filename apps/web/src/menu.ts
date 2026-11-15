/**
 * Title screen: a slow orbit over the chosen airfield in the chosen day's weather. Pick an
 * airfield (any in Europe), when, and how to launch; everything else comes from the data.
 * "Fly" starts the sim by navigating to its URL parameters (any flight can be bookmarked).
 */
import { HeadingPitchRange, Cartesian3, Math as CMath } from "cesium";
import { advance, loadAirfieldIndex, searchAirfields, soaringFrom, sunPosition, TerrariumTerrain, ThermalSky, type Thermal } from "@webflight/environment";
import { addImagery, type ImageryMode } from "./imagery.ts";
import { createViewer, ThermalLayer } from "./scene.ts";
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
type Pick = { field?: string; at?: string; launch: string; time: string; imagery: ImageryMode; quality: string };

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

export async function showMenu(params: URLSearchParams): Promise<void> {
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
    quality: params.get("quality") ?? remembered.quality ?? "high",
  };
  const q = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(pick.field && pick.at ? { field: pick.field, at: pick.at } : {}), time: pick.time, ...extra });

  // The flight as the sim will resolve it: airfield, runway in use, weather.
  const F = await resolveFlight(q());
  const field = F.field;
  if (field) Object.assign(pick, { field: field.ident, at: `${field.latDeg},${field.lonDeg}` });

  const root = document.getElementById("menu")!;
  root.hidden = false;
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
            location.replace(`?menu&${q()}`); // move the backdrop
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
  // When: now, or any local date and time at the field (the weather of that hour).
  {
    const sec = document.createElement("div");
    sec.className = "menu-section";
    const local = new Date(F.time.getTime() + F.weather.utcOffsetH * 3600_000).toISOString().slice(0, 16);
    sec.innerHTML = `<h2>When (local time)</h2><div class="menu-when"><button aria-pressed="${pick.time === "now"}">Now</button><input type="datetime-local" value="${local}" aria-label="Local date and time" /></div>`;
    sec.querySelector("button")!.onclick = () => {
      pick.time = "now";
      save();
      location.replace(`?menu&${q()}`);
    };
    const input = sec.querySelector("input")!;
    input.onchange = () => {
      if (!input.value) return;
      pick.time = input.value;
      save();
      location.replace(`?menu&${q()}`); // new weather and light
    };
    opts.appendChild(sec);
  }
  const wx = document.createElement("p");
  wx.className = "menu-weather";
  wx.textContent = F.weatherText;
  opts.appendChild(wx);
  segmented(opts, "Scenery", [["photo", "Photos"], ["painted", "Painted"]], pick.imagery, (v) => (pick.imagery = v as ImageryMode));
  segmented(opts, "Quality", [["low", "Low"], ["high", "High"], ["ultra", "Ultra"]], pick.quality, (v) => (pick.quality = v));
  const go = document.createElement("button");
  go.className = "menu-fly";
  go.textContent = "Fly";
  go.onclick = () => fly();
  panel.appendChild(go);
  const foot = document.createElement("div");
  foot.className = "menu-foot";
  foot.innerHTML =
    "Keyboard or gamepad. H shows the controls in flight, Esc comes back here.<br>Aircraft: FlightGear ASK 21 (GPL). Terrain: Mapzen Terrarium. Imagery: swisstopo, IGN, basemap.at, EOX Sentinel-2 cloudless. Maps: OpenStreetMap via OpenFreeMap. Airfields: OurAirports. Weather data by Open-Meteo.com.";
  panel.appendChild(foot);
  root.appendChild(panel);

  function save(): void {
    try {
      localStorage.setItem("webflight.menu", JSON.stringify(pick));
    } catch {}
  }
  function fly(): void {
    save();
    location.assign(`?${q({ launch: pick.launch, imagery: pick.imagery, quality: pick.quality })}`);
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fly();
  });

  // Backdrop: the real scene, orbiting slowly.
  const date = F.time;
  const terrain = new TerrariumTerrain({ zoom: 13 });
  const viewer = createViewer(document.getElementById("cesium")!, { time: date, shadows: false, terrain, quality: pick.quality === "ultra" ? "ultra" : "high" });
  (window as unknown as { webflightViewer: unknown }).webflightViewer = viewer;
  const sun = sunPosition(date, F.latDeg, F.lonDeg);
  void addImagery(viewer, pick.imagery, sun);
  // The day's thermals and cumulus, streamed in as their terrain loads (as in flight).
  const layer = new ThermalLayer(viewer, false, sun, soaringFrom(F.weather).cumulus);
  if (F.environment.thermalSky) {
    const sky = new ThermalSky({ ...F.environment.thermalSky, radiusCells: 3, groundAt: (la, lo) => terrain.heightAt(la, lo, 11) });
    const view = (t: Thermal): ThermalView => {
      const time = t.cycleTimer / (25 * 60);
      return {
        id: t.id,
        latDeg: t.spec.latDeg,
        lonDeg: t.spec.lonDeg,
        topM: t.spec.heightMslFt * 0.3048,
        groundM: t.spec.groundElevFt * 0.3048,
        radiusM: t.spec.diameterFt * 0.3048 * 0.5,
        strengthMs: t.spec.strengthFps * 0.3048,
        phase: time <= 0.2 ? "forming" : time <= 0.8 ? "formed" : time <= 1 ? "dying" : "dead",
      };
    };
    const wind = { groundFromDeg: F.environment.windFromDeg, groundKt: F.environment.windKt, aloftFromDeg: F.environment.aloftFromDeg ?? F.environment.windFromDeg, aloftKt: F.environment.aloftKt ?? F.environment.windKt };
    const tick = () => {
      sky.update(2, { latDeg: F.latDeg, lonDeg: F.lonDeg, altFt: 0 }, wind);
      layer.update(sky.thermals.map(view));
    };
    tick();
    setInterval(tick, 2000);
  }
  // Lakes and rivers read well from the orbit; buildings and trees are too small up here.
  Scenery.create(viewer, { latDeg: F.latDeg, lonDeg: F.lonDeg }, { buildings: false, trees: false, water: true, shadows: false, treeDetail: 24, drape: false });
  document.getElementById("boot")!.hidden = true;
  // Orbit a point a few km upwind of the field.
  const [cLat, cLon] = advance(F.latDeg, F.lonDeg, F.environment.windFromDeg, 3000);
  const groundM = await terrain.heightAtAsync(cLat, cLon).catch(() => 500);
  const centre = Cartesian3.fromDegrees(cLon, cLat, groundM + 450);
  let heading = CMath.toRadians(200);
  let last = performance.now();
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    heading += ((now - last) / 1000) * CMath.toRadians(1.6);
    last = now;
    viewer.camera.lookAt(centre, new HeadingPitchRange(heading, CMath.toRadians(-11), 5200));
  });
}
