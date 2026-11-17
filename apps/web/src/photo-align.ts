/**
 * Where OpenStreetMap content must move to sit on the aerial photo, per zoom-14 tile (~1.7 km).
 *
 * Bing's photos are registered a few metres off, and differently from place to place
 * (measured 2026-11: Ghimbav 2.7 m W 3.8 m S, Brașov 2.6 m E 9.5 m S, Sânpetru 5.0 m E
 * 2.2 m S, Codlea ~0). Buildings drawn on the OSM footprints then stand beside the photo's
 * own roofs ("ghost roofs"), and grass grows on the photo's roads. So the 3D buildings,
 * trees, lamps and the grass's OSM masks are moved by the measured displacement
 * (photo-align-worker.ts): the photo is what the eye checks them against. The flight model,
 * terrain, runway and airfield data keep their true positions.
 *
 * Measured once per tile and kept in localStorage for a month. Off with ?align=0.
 */
import { lonLatToTile } from "@webflight/environment";
import { photoQuadkeyUrl } from "./imagery.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import type { AlignRequest, AlignResult } from "./photo-align-worker.ts";

const KEY = "wf-osm-photo-shift-v1";
const MONTH_MS = 30 * 86_400_000;
const ENABLED = new URLSearchParams(location.search).get("align") !== "0";

type Entry = { s: [number, number] | null; t: number };
let stored: Record<string, Entry> = {};
try {
  stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Entry>;
} catch {
  stored = {};
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // private window or full storage: measured again next time
  }
};

let worker: Worker | undefined;
const waiting = new Map<string, (s: [number, number]) => void>();
const known = new Map<string, Promise<[number, number]>>();

/** East, north [m] to move OSM content of zoom-14 tile (x, y) by; [0, 0] when unknown. */
export function osmShift(x: number, y: number): Promise<[number, number]> {
  const k = `${x}/${y}`;
  let p = known.get(k);
  if (p) return p;
  const e = stored[k];
  if (!ENABLED || !photoQuadkeyUrl) p = Promise.resolve([0, 0]);
  else if (e && Date.now() - e.t < MONTH_MS) p = Promise.resolve(e.s ?? [0, 0]);
  else
    p = openFreeMapTiles().then((osmUrl) => {
      const photoUrl = photoQuadkeyUrl;
      if (!osmUrl || !photoUrl) return [0, 0] as [number, number];
      if (!worker) {
        worker = new Worker(new URL("./photo-align-worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (ev: MessageEvent<AlignResult>) => {
          const r = ev.data, rk = `${r.x}/${r.y}`;
          if (r.error) console.warn(`photo alignment ${rk}:`, r.error);
          else {
            const s = r.shift ? ([Math.round(r.shift[0] * 10) / 10, Math.round(r.shift[1] * 10) / 10] as [number, number]) : null;
            stored[rk] = { s, t: Date.now() };
            save();
            console.info(`photo alignment ${rk}: ${s ? `${s[0]} m E, ${s[1]} m N` : "none"} (${r.buildings} houses${r.quality ? `, quality ${r.quality.toFixed(2)}` : ""})`);
          }
          waiting.get(rk)?.(stored[rk]?.s ?? [0, 0]);
          waiting.delete(rk);
        };
      }
      return new Promise<[number, number]>((resolve) => {
        waiting.set(k, resolve);
        worker!.postMessage({ x, y, osmUrl, photoUrl } satisfies AlignRequest);
      });
    });
  known.set(k, p);
  return p;
}

/** The shift if already measured, else [0, 0], without measuring: for towns far away, where a few metres don't show. */
export function osmShiftIfKnown(x: number, y: number): [number, number] {
  const e = stored[`${x}/${y}`];
  return ENABLED && photoQuadkeyUrl && e?.s ? e.s : [0, 0];
}

/** The same for the zoom-14 tile under a position. */
export function osmShiftAt(latDeg: number, lonDeg: number): Promise<[number, number]> {
  const [x, y] = lonLatToTile(lonDeg, latDeg, 14);
  return osmShift(Math.floor(x), Math.floor(y));
}
