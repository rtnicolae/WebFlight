/// <reference lib="webworker" />
/**
 * Detail imagery tiles (zoom 15–18) where the photos are only Sentinel-2's 10 m: the
 * satellite colours upsampled, detail synthesized from them (synth.ts), then OpenStreetMap
 * drawn crisp on top: water, waterways, roads (paved / dirt), railways, rooftops with
 * shadows. Visual only.
 */
import { airfieldsAround, bearingDeg, designatorDeg } from "@webflight/environment";
import { decodeMvt, type MvtLayer } from "@webflight/scenery";
import { synthesize, hash2, COVERS, type Cover } from "./synth.ts";

declare const self: DedicatedWorkerGlobalScope;

export interface DetailRequest {
  id: number;
  x: number;
  y: number;
  z: number;
  s2Url: string;
  osmUrl: string;
  sun: { azimuthDeg: number; elevationDeg: number };
}

const C = 40075016.686;
const SIZE = 256;
/** World metres for texture anchoring: Web Mercator scaled by a fixed cos(47°) (no seams). */
const K = Math.cos((47 * Math.PI) / 180);

function lru<V>(max: number) {
  const m = new Map<string, Promise<V>>();
  return (k: string, make: () => Promise<V>): Promise<V> => {
    let v = m.get(k);
    if (v) {
      m.delete(k);
      m.set(k, v);
      return v;
    }
    v = make();
    m.set(k, v);
    v.catch(() => m.delete(k));
    if (m.size > max) m.delete(m.keys().next().value!);
    return v;
  };
}
const s2Cache = lru<ImageBitmap>(48);
const osmCache = lru<MvtLayer[]>(24);
const fill = (u: string, z: number, x: number, y: number) => u.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

async function s2(url: string, z: number, x: number, y: number): Promise<ImageBitmap> {
  return s2Cache(`${z}/${x}/${y}`, async () => {
    const r = await fetch(fill(url, z, x, y));
    if (!r.ok) throw new Error(`s2 ${r.status}`);
    return createImageBitmap(await r.blob());
  });
}
async function osm(url: string, x: number, y: number): Promise<MvtLayer[]> {
  return osmCache(`${x}/${y}`, async () => {
    const r = await fetch(fill(url, 14, x, y));
    if (!r.ok) return [];
    return decodeMvt(new Uint8Array(await r.arrayBuffer()));
  });
}

const COVER_OF: Record<string, Cover> = {
  wood: "forest",
  forest: "forest",
  grass: "grass",
  meadow: "grass",
  park: "grass",
  wetland: "grass",
  farmland: "crop",
  residential: "urban",
  industrial: "urban",
  commercial: "urban",
  retail: "urban",
  railway: "urban",
};
/** Road widths [m] and paint by OpenMapTiles class. */
const ROAD: Record<string, number> = { motorway: 22, trunk: 16, primary: 12, secondary: 9, tertiary: 7.5, minor: 5.5, service: 3.5, track: 3, path: 1.3, raceway: 10, busway: 7 };
/** Houses: clay tiles and some slate/metal; large roofs: grey membranes and metal. */
const ROOFS = ["#9c5a45", "#8f5644", "#7e5244", "#a2705a", "#6a6664", "#5c5e64", "#8c8a86"];
const BIG_ROOFS = ["#8e8f8f", "#a3a4a2", "#7b7e82", "#b4b3ae", "#6f7377"];

self.onmessage = async (ev: MessageEvent<DetailRequest>) => {
  const q = ev.data;
  try {
    const bitmap = await compose(q);
    self.postMessage({ id: q.id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id: q.id, error: String(e) });
  }
};

/** The OurAirports surface of the runway an OSM line belongs to, if one matches. */
async function airfieldSurface(geom: [number, number][][], e: number, ax: number, ay: number): Promise<"paved" | "grass" | "other" | undefined> {
  const line = geom[0];
  if (!line || line.length < 2) return undefined;
  const ll = ([u, v]: [number, number]): [number, number] => {
    const n = 2 ** 14, X = ax + u / e, Y = ay + v / e;
    return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI, (X / n) * 360 - 180];
  };
  const a = ll(line[0]!), b = ll(line[line.length - 1]!);
  const brg = bearingDeg(a[0], a[1], b[0], b[1]);
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const fields = await airfieldsAround(mid[0], mid[1], 3000).catch(() => []);
  // Parallel runways of neighbouring fields both match the direction: take the closest
  // (to its surveyed midpoint when known, else to the field's reference point).
  let best: { d: number; surface: "paved" | "grass" | "other" } | undefined;
  for (const fld of fields)
    for (const rw of fld.runways) {
      const deg = designatorDeg(rw.le);
      if (deg === undefined) continue;
      const diff = Math.abs((((brg - deg) % 180) + 270) % 180 - 90);
      if (diff >= 25) continue;
      const ref = rw.leLatLon && rw.heLatLon ? [(rw.leLatLon[0] + rw.heLatLon[0]) / 2, (rw.leLatLon[1] + rw.heLatLon[1]) / 2] : [fld.latDeg, fld.lonDeg];
      const d = Math.hypot(ref[0]! - mid[0], (ref[1]! - mid[1]) * Math.cos((mid[0] * Math.PI) / 180));
      if (!best || d < best.d) best = { d, surface: rw.surface };
    }
  return best?.surface;
}

async function compose(q: DetailRequest): Promise<ImageBitmap> {
  const { x, y, z } = q;
  const d = z - 14;
  const sub = 2 ** d;
  const ax = x >> d, ay = y >> d, ox = x - ax * sub, oy = y - ay * sub;
  const [base, layers] = await Promise.all([s2(q.s2Url, 14, ax, ay), osm(q.osmUrl, ax, ay)]);
  const cv = new OffscreenCanvas(SIZE, SIZE);
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const src = 256 / sub;
  ctx.drawImage(base, ox * src, oy * src, src, src, 0, 0, SIZE, SIZE);

  // MVT (zoom 14, extent e) → this tile's pixels.
  const toPx = (e: number) => (px: number, py: number): [number, number] => [((px / e) * sub - ox) * SIZE, ((py / e) * sub - oy) * SIZE];
  const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))) * 180) / Math.PI;
  const mPerPx = (C * Math.cos((latC * Math.PI) / 180)) / 2 ** z / SIZE;
  const path = (c: OffscreenCanvasRenderingContext2D, rings: [number, number][][], f: (a: number, b: number) => [number, number]) => {
    c.beginPath();
    for (const r of rings) r.forEach(([a, b], i) => (i ? c.lineTo(...f(a, b)) : c.moveTo(...f(a, b))));
  };

  // OSM land cover, rasterized for the synthesis.
  const cov = new OffscreenCanvas(SIZE, SIZE);
  const cc = cov.getContext("2d", { willReadFrequently: true })!;
  cc.imageSmoothingEnabled = false;
  for (const l of layers) {
    if (l.name !== "landcover" && l.name !== "landuse" && l.name !== "park") continue;
    const f = toPx(l.extent);
    for (const feat of l.features) {
      if (feat.type !== 3) continue;
      const cls = String(feat.properties["subclass"] ?? feat.properties["class"] ?? (l.name === "park" ? "park" : ""));
      const c = COVER_OF[cls] ?? COVER_OF[String(feat.properties["class"] ?? "")];
      if (!c) continue;
      cc.fillStyle = `rgb(${(COVERS.indexOf(c) + 1) * 40},0,0)`;
      path(cc, feat.geometry, f);
      cc.fill("evenodd");
    }
  }
  // Around buildings: yards and lots (the 10 m pixels smear bright roofs into halos there).
  const bl = layers.find((l) => l.name === "building");
  if (bl) {
    const f = toPx(bl.extent);
    cc.fillStyle = cc.strokeStyle = `rgb(${(COVERS.indexOf("urban") + 1) * 40},0,0)`;
    cc.lineWidth = 24 / mPerPx;
    cc.lineJoin = "round";
    for (const ft of bl.features) {
      if (ft.type !== 3) continue;
      path(cc, ft.geometry, f);
      cc.fill("evenodd");
      cc.stroke();
    }
  }
  const covPx = cc.getImageData(0, 0, SIZE, SIZE).data;
  const cover = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < cover.length; i++) if (covPx[i * 4 + 3]! > 127) cover[i] = Math.max(0, Math.min(COVERS.length, Math.round(covPx[i * 4]! / 40)));

  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const az = (q.sun.azimuthDeg * Math.PI) / 180;
  const sunLow = Math.min(1.5, 1 / Math.tan((Math.max(8, q.sun.elevationDeg) * Math.PI) / 180));
  const n = 2 ** z;
  synthesize(img.data, {
    x0: ((x / n) * C - C / 2) * K,
    y0: (C / 2 - (y / n) * C) * K,
    mPerPx: (C / n / SIZE) * K,
    size: SIZE,
    sunX: Math.sin(az),
    sunY: Math.cos(az),
    sunLow,
  }, cover);
  ctx.putImageData(img, 0, 0);

  // Crisp vectors on top.
  const w = (m: number) => Math.max(0.6, m / mPerPx);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const l of layers) {
    const f = toPx(l.extent);
    if (l.name === "water") {
      ctx.fillStyle = "rgba(46, 66, 68, 0.78)";
      for (const feat of l.features) if (feat.type === 3) { path(ctx, feat.geometry, f); ctx.fill("evenodd"); }
    } else if (l.name === "waterway") {
      ctx.strokeStyle = "rgba(48, 70, 72, 0.85)";
      for (const feat of l.features) {
        if (feat.type !== 2) continue;
        const cls = String(feat.properties["class"] ?? "");
        ctx.lineWidth = w(cls === "river" ? 14 : cls === "canal" ? 8 : cls === "stream" ? 3 : 1.6);
        path(ctx, feat.geometry, f);
        ctx.stroke();
      }
    }
  }
  // The whole zoom-14 satellite tile, to judge features as a whole (same answer in every tile).
  const bc = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
  bc.drawImage(base, 0, 0);
  const sat = bc.getImageData(0, 0, 256, 256).data;
  const looksGreen = (geom: [number, number][][], e: number): boolean => {
    let g = 0, n = 0;
    for (const line of geom)
      for (let i = 0; i + 1 < line.length; i++)
        for (const t of [0.2, 0.4, 0.6, 0.8]) {
          const u = ((line[i]![0] + (line[i + 1]![0] - line[i]![0]) * t) / e) * 256, v = ((line[i]![1] + (line[i + 1]![1] - line[i]![1]) * t) / e) * 256;
          if (u < 0 || v < 0 || u >= 256 || v >= 256) continue;
          const k = (Math.floor(v) * 256 + Math.floor(u)) * 4;
          g += sat[k + 1]! - (sat[k]! + sat[k + 2]!) / 2;
          n++;
        }
    return n > 0 && g / n > 6;
  };
  // Runways: paved with a centreline, grass as a mown band.
  const aero = layers.find((l) => l.name === "aeroway");
  if (aero) {
    const f = toPx(aero.extent);
    for (const ft of aero.features) {
      const cls = String(ft.properties["class"] ?? "");
      if (cls !== "runway" && cls !== "taxiway") continue;
      const surf = ft.properties["surface"];
      // Untagged surface: judge from the satellite colour under the line (green = grass).
      // Surface: OSM's tag, else the airfield data's (OurAirports runway in the same
      // direction within 3 km), else the satellite colour under the line.
      let grass: boolean;
      if (surf !== undefined) grass = surf === "grass" || surf === "unpaved" || surf === "dirt";
      else {
        const known = ft.type === 2 ? await airfieldSurface(ft.geometry, aero.extent, ax, ay) : undefined;
        grass = known !== undefined ? known === "grass" : looksGreen(ft.geometry, aero.extent);
      }
      path(ctx, ft.geometry, f);
      if (ft.type === 3) {
        ctx.fillStyle = grass ? "rgba(150, 175, 100, 0.35)" : "rgb(92, 92, 90)";
        ctx.fill("evenodd");
        continue;
      }
      const width = cls === "runway" ? 30 : 12;
      if (grass) {
        ctx.strokeStyle = "rgba(160, 186, 108, 0.4)";
        ctx.lineWidth = w(width);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgb(88, 88, 86)";
        ctx.lineWidth = w(width);
        ctx.stroke();
        if (cls === "runway" && mPerPx < 1.2) {
          ctx.setLineDash([w(30), w(20)]);
          ctx.strokeStyle = "rgba(235, 235, 230, 0.9)";
          ctx.lineWidth = w(0.9);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
  const roads = layers.find((l) => l.name === "transportation");
  if (roads) {
    const f = toPx(roads.extent);
    // Verges/edges first, then surfaces, wider roads last so junctions read right.
    const list = roads.features.filter((ft) => ft.type === 2).map((ft) => {
      const cls = String(ft.properties["class"] ?? "");
      const paved = ft.properties["surface"] === "paved" || (ft.properties["surface"] !== "unpaved" && !["track", "path"].includes(cls));
      return { ft, cls, paved, width: cls === "rail" || cls === "transit" ? 3.2 : ROAD[cls] ?? 0 };
    }).filter((r) => r.width > 0 && Number(r.ft.properties["brunnel"] === "tunnel") === 0).sort((a, b) => a.width - b.width);
    for (const r of list) {
      path(ctx, r.ft.geometry, f);
      if (r.cls === "rail" || r.cls === "transit") {
        ctx.strokeStyle = "rgba(92, 86, 80, 0.9)";
        ctx.lineWidth = w(3.2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(48, 46, 44, 0.9)";
        ctx.lineWidth = w(1.2);
        ctx.stroke();
        continue;
      }
      ctx.strokeStyle = r.paved ? "rgba(70, 70, 68, 0.55)" : "rgba(120, 104, 82, 0.4)";
      ctx.lineWidth = w(r.width + 1.6);
      ctx.stroke();
      ctx.strokeStyle = r.paved ? "rgb(108, 107, 104)" : "rgb(166, 148, 120)";
      ctx.lineWidth = w(r.width);
      ctx.stroke();
      if (r.paved && r.width >= 9 && mPerPx < 0.8) {
        ctx.setLineDash([w(3), w(6)]);
        ctx.strokeStyle = "rgba(230, 230, 222, 0.8)";
        ctx.lineWidth = w(0.15);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  const bld = layers.find((l) => l.name === "building");
  if (bld) {
    const f = toPx(bld.extent);
    const sdx = -Math.sin(az), sdy = Math.cos(az); // shadow direction in pixels (y down)
    for (const ft of bld.features) {
      if (ft.type !== 3) continue;
      const h = Number(ft.properties["render_height"] ?? 5);
      const off = Math.min(18, h * sunLow) / mPerPx;
      ctx.fillStyle = "rgba(20, 22, 26, 0.42)";
      path(ctx, ft.geometry, (a, b) => { const [u, v] = f(a, b); return [u + sdx * off, v + sdy * off]; });
      ctx.fill("evenodd");
    }
    // Buildings of one height share a feature: colour each footprint (ring) on its own.
    for (const ft of bld.features) {
      if (ft.type !== 3) continue;
      for (const ring of ft.geometry) {
        const [a, b] = ring[0] ?? [0, 0];
        let area = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
        const areaM2 = Math.abs(area / 2) * ((mPerPx * SIZE) / (bld.extent / sub)) ** 2;
        const palette = areaM2 > 800 ? BIG_ROOFS : ROOFS;
        ctx.fillStyle = palette[hash2(a + ax * 4096, b + ay * 4096, 61) % palette.length]!;
        path(ctx, [ring], f);
        ctx.fill();
      }
    }
  }
  return cv.transferToImageBitmap();
}
