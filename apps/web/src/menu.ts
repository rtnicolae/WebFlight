/**
 * Title screen: a slow orbit over Grenchen and the Jura under the day's cumulus, with the
 * scenarios and a few options. "Fly" starts the sim by navigating to its URL parameters
 * (the sim reads everything from the URL, so any flight can be bookmarked or shared).
 */
import { HeadingPitchRange, Cartesian3, Math as CMath } from "cesium";
import { GRENCHEN, TerrariumTerrain, ThermalField } from "@webflight/environment";
import { addImagery, type ImageryMode } from "./imagery.ts";
import { createViewer, ThermalLayer } from "./scene.ts";
import { sunPosition } from "./sun.ts";
import type { ThermalView } from "./protocol.ts";

const ICONS: Record<string, string> = {
  final: `<svg viewBox="0 0 40 40"><path d="M4 30h32"/><path d="M14 30l4-4h4l4 4"/><path d="M6 10l20 14"/><path d="M8 8l-3 1 2 3"/></svg>`,
  ridge: `<svg viewBox="0 0 40 40"><path d="M3 32l10-14 6 6 8-12 10 20z"/><path d="M6 12c4-2 7-2 10 0" /><path d="M24 8l6 3"/></svg>`,
  thermal: `<svg viewBox="0 0 40 40"><path d="M12 14a6 6 0 0 1 11-3 5 5 0 0 1 7 6H10a4 4 0 0 1 2-3z"/><path d="M20 34c-4-3 4-6 0-9s4-6 0-8"/></svg>`,
  winch: `<svg viewBox="0 0 40 40"><path d="M4 32h32"/><circle cx="32" cy="28" r="3"/><path d="M30 26L10 12"/><path d="M6 14l8-4 1 3"/></svg>`,
  aerotow: `<svg viewBox="0 0 40 40"><path d="M24 14h12M30 10v8M27 18h6"/><path d="M24 14L10 22"/><path d="M4 22h12M10 20v4"/></svg>`,
};

const SCENARIOS = [
  { id: "final", name: "Final approach", text: "Line up for runway 07 at Grenchen and land." },
  { id: "ridge", name: "Ridge soaring", text: "Ride the Jura's south face in a 20 kt wind." },
  { id: "thermal", name: "Thermal", text: "Under a young cumulus: circle and climb." },
  { id: "winch", name: "Winch launch", text: "1000 m of cable. Press L to launch." },
  { id: "aerotow", name: "Aerotow", text: "Follow the tug in high tow up to 800 m." },
] as const;

type Pick = { start: string; time: string; wind: string; imagery: ImageryMode; quality: string };

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
  const pick: Pick = {
    start: params.get("start") ?? remembered.start ?? "final",
    time: params.get("time") ?? remembered.time ?? "afternoon",
    wind: remembered.wind ?? "auto",
    imagery: (params.get("imagery") as ImageryMode | null) ?? remembered.imagery ?? "photo",
    quality: params.get("quality") ?? remembered.quality ?? "high",
  };

  const root = document.getElementById("menu")!;
  root.hidden = false;
  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.innerHTML = `<h1 class="menu-title">WebFlight</h1><p class="menu-tagline">Gliding over the Swiss Jura · ASK 21 · JSBSim</p>`;
  const cards = document.createElement("div");
  cards.className = "menu-section";
  cards.innerHTML = `<h2>Scenario</h2>`;
  const list = document.createElement("div");
  list.className = "menu-cards";
  for (const s of SCENARIOS) {
    const b = document.createElement("button");
    b.className = "menu-card";
    b.setAttribute("aria-pressed", String(s.id === pick.start));
    b.innerHTML = `${ICONS[s.id]}<div><b>${s.name}</b><span>${s.text}</span></div>`;
    b.onclick = () => {
      list.querySelectorAll(".menu-card").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      pick.start = s.id;
    };
    b.ondblclick = () => fly();
    list.appendChild(b);
  }
  cards.appendChild(list);
  panel.appendChild(cards);
  const opts = document.createElement("div");
  opts.className = "menu-options";
  panel.appendChild(opts);
  segmented(opts, "Time of day", [["morning", "Morning"], ["noon", "Noon"], ["afternoon", "Afternoon"], ["evening", "Evening"]], pick.time, (v) => {
    pick.time = v;
    location.replace(`?menu&time=${v}`); // relight the backdrop
    save();
  });
  segmented(opts, "Wind", [["auto", "Auto"], ["0@0", "Calm"], ["240@8", "Light W"], ["150@15", "SE 15 kt"], ["150@25", "SE 25 kt"]], pick.wind, (v) => (pick.wind = v));
  segmented(opts, "Scenery", [["photo", "Photos"], ["painted", "Painted"]], pick.imagery, (v) => (pick.imagery = v as ImageryMode));
  segmented(opts, "Quality", [["low", "Low"], ["high", "High"], ["ultra", "Ultra"]], pick.quality, (v) => (pick.quality = v));
  const go = document.createElement("button");
  go.className = "menu-fly";
  go.textContent = "Fly";
  go.onclick = () => fly();
  panel.appendChild(go);
  const foot = document.createElement("div");
  foot.className = "menu-foot";
  foot.innerHTML = "Keyboard or gamepad. H shows the controls in flight, Esc comes back here.<br>Aircraft: FlightGear ASK 21 (GPL). Terrain: Mapzen Terrarium. Imagery: swisstopo, EOX Sentinel-2 cloudless.";
  panel.appendChild(foot);
  root.appendChild(panel);

  function save(): void {
    try {
      localStorage.setItem("webflight.menu", JSON.stringify(pick));
    } catch {}
  }
  function fly(): void {
    save();
    const q = new URLSearchParams({ start: pick.start, time: pick.time, imagery: pick.imagery, quality: pick.quality });
    if (pick.wind !== "auto") q.set("wind", pick.wind);
    location.assign(`?${q}`);
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fly();
  });

  // Backdrop: the real scene, orbiting slowly.
  const date = timeFor(pick.time);
  const terrain = new TerrariumTerrain({ zoom: 13 });
  const viewer = createViewer(document.getElementById("cesium")!, { time: date, shadows: false, terrain, quality: pick.quality === "ultra" ? "ultra" : "high" });
  void addImagery(viewer, pick.imagery, sunPosition(date, GRENCHEN.latDeg, GRENCHEN.lonDeg));
  const field = new ThermalField({ seed: 1, centerLatDeg: GRENCHEN.latDeg, centerLonDeg: GRENCHEN.lonDeg, radiusM: 12_000, count: 30, cloudBaseM: 1900 });
  const thermals: ThermalView[] = field.thermals.map((t) => {
    const time = t.cycleTimer / (25 * 60);
    return {
      latDeg: t.spec.latDeg,
      lonDeg: t.spec.lonDeg,
      topM: t.spec.heightMslFt * 0.3048,
      groundM: 450,
      radiusM: t.spec.diameterFt * 0.3048 * 0.5,
      strengthMs: t.spec.strengthFps * 0.3048,
      phase: time <= 0.2 ? "forming" : time <= 0.8 ? "formed" : time <= 1 ? "dying" : "dead",
    };
  });
  new ThermalLayer(viewer).update(thermals);
  document.getElementById("boot")!.hidden = true;
  const centre = Cartesian3.fromDegrees(7.47, 47.215, 900);
  let heading = CMath.toRadians(200);
  let last = performance.now();
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    heading += ((now - last) / 1000) * CMath.toRadians(1.6);
    last = now;
    viewer.camera.lookAt(centre, new HeadingPitchRange(heading, CMath.toRadians(-11), 5200));
  });
}

/** Same presets as the sim (main.ts simTime). */
function timeFor(v: string): Date {
  const presets: Record<string, string> = { morning: "07:15", noon: "13:15", afternoon: "16:30", evening: "20:50" };
  const [h, m] = (presets[v] ?? "16:30").split(":").map(Number) as [number, number];
  return new Date(Date.UTC(2026, 6, 15, h - 2, m));
}
