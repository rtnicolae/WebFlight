/// <reference lib="webworker" />
/**
 * Detail imagery tiles (zoom 15–18) where the photos are only Sentinel-2's 10 m: the
 * satellite colours upsampled, detail synthesized from them (synth.ts), then OpenStreetMap
 * drawn crisp on top: water, waterways, roads (paved / dirt), railways, rooftops with
 * shadows. Visual only.
 */
import { airfieldsAround, bearingDeg, designatorDeg } from "@webflight/environment";
import { decodeMvt, streetLamps, type MvtLayer } from "@webflight/scenery";
import { edgeAwareUpsample, synthesize, hash2, COVERS, type Cover, type GroundTextures } from "./synth.ts";
import { addRelief, buildDetailTexture, TEXTURES, type DetailTexture, type TextureRole } from "./textures.ts";

declare const self: DedicatedWorkerGlobalScope;

export interface DetailRequest {
  id: number;
  /**
   * Time of day (lighting.ts LOOK): the tile darkens itself by `ground` and, by `night`,
   * paints the street lamps' light pools (the layer is then drawn at full brightness).
   */
  look?: { ground: number; night: number };
  /** 3D building shadows are drawn: don't also paint them into tiles within their reach (zoom ≥ 15). */
  realShadows?: boolean;
  x: number;
  y: number;
  z: number;
  s2Url: string;
  osmUrl: string;
  sun: { azimuthDeg: number; elevationDeg: number };
  /** Base URL of the HD textures (public/textures/). */
  texUrl: string;
  /** Debug switches (?synth=0, ?snap=0): skip the texture, skip the edge-aware snapping. */
  synth?: boolean;
  snap?: boolean;
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

/**
 * Cesium expects imagery ImageBitmaps pre-flipped (it loads its own with imageOrientation
 * "flipY"; WebGL's UNPACK_FLIP_Y doesn't apply to ImageBitmaps). Unflipped, every tile was
 * drawn upside down: features broke and tones jumped at each tile row.
 */
function flipped(cv: OffscreenCanvas): Promise<ImageBitmap> {
  return createImageBitmap(cv, { imageOrientation: "flipY" });
}

/** HD textures, decoded once per worker: detail maps (ratios) and canvas patterns (roads). */
interface LoadedTexture {
  detail: DetailTexture;
  /** The texture as ratio × mid-grey: a tone-neutral overlay (soft-light). */
  overlay: ImageBitmap;
}
const texCache = new Map<TextureRole, Promise<LoadedTexture>>();
function texture(base: string, role: TextureRole): Promise<LoadedTexture> {
  let t = texCache.get(role);
  if (!t) {
    t = (async () => {
      const r = await fetch(base + TEXTURES[role].file);
      if (!r.ok) throw new Error(`texture ${role} ${r.status}`);
      const bitmap = await createImageBitmap(await r.blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      c.drawImage(bitmap, 0, 0);
      const detail = buildDetailTexture(c.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, TEXTURES[role].meters);
      const hm = TEXTURES[role].height;
      if (hm) {
        const hr = await fetch(base + hm.file);
        if (hr.ok) {
          const hb = await createImageBitmap(await hr.blob());
          const hc = new OffscreenCanvas(hb.width, hb.height).getContext("2d")!;
          hc.drawImage(hb, 0, 0);
          addRelief(detail, hc.getImageData(0, 0, hb.width, hb.height).data, hb.width, hm.m);
        }
      }
      const img = new ImageData(detail.size, detail.size);
      const l0 = detail.levels[0]!;
      for (let i = 0; i < detail.size * detail.size; i++) {
        for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.min(255, 128 * l0[i * 3 + k]!);
        img.data[i * 4 + 3] = 255;
      }
      return { detail, overlay: await createImageBitmap(img) };
    })();
    t.catch(() => texCache.delete(role));
    texCache.set(role, t);
  }
  return t;
}
async function groundTextures(base: string): Promise<GroundTextures> {
  const [grass, dryGrass, soil, drySoil] = await Promise.all((["grass", "dryGrass", "soil", "drySoil"] as const).map((k) => texture(base, k)));
  return { grass: grass!.detail, dryGrass: dryGrass!.detail, soil: soil!.detail, drySoil: drySoil!.detail, paved: (await texture(base, "asphalt")).detail };
}

/** fetch with backoff on rate limits and server errors (1 s, 2 s, 4 s). */
async function get(url: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok || (r.status !== 429 && r.status < 500) || i === 3) return r;
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
}

async function s2(url: string, z: number, x: number, y: number): Promise<ImageBitmap> {
  return s2Cache(`${z}/${x}/${y}`, async () => {
    const r = await get(fill(url, z, x, y));
    if (!r.ok) throw new Error(`s2 ${r.status}`);
    return createImageBitmap(await r.blob());
  });
}
const mosaicCache = lru<Uint8ClampedArray>(10);
/** A zoom-14 satellite tile with its 8 neighbours as one 768×768 RGBA image. */
function mosaic(url: string, x: number, y: number): Promise<Uint8ClampedArray> {
  return mosaicCache(`${x}/${y}`, async () => {
    const c = new OffscreenCanvas(768, 768).getContext("2d", { willReadFrequently: true })!;
    const n = 2 ** 14;
    await Promise.all(
      [-1, 0, 1].flatMap((dy) =>
        [-1, 0, 1].map(async (dx) => {
          const ty = y + dy;
          if (ty < 0 || ty >= n) return;
          // Any missing piece fails the mosaic (and the tile, retried later): a partial
          // mosaic would mis-sharpen along its edges.
          const b = await s2(url, 14, (((x + dx) % n) + n) % n, ty);
          c.drawImage(b, (dx + 1) * 256, (dy + 1) * 256);
        }),
      ),
    );
    return c.getImageData(0, 0, 768, 768).data;
  });
}

async function osm(url: string, x: number, y: number): Promise<MvtLayer[]> {
  return osmCache(`${x}/${y}`, async () => {
    const r = await get(fill(url, 14, x, y));
    // A failed download (e.g. 429) must fail the tile so Cesium retries it later, not draw
    // the tile without its roads (cached failures made roads stop at tile edges).
    if (!r.ok) throw new Error(`osm ${r.status}`);
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
const BIG_ROOFS = ["#76787a", "#86878a", "#696c70", "#8e8d88", "#5f6367"];

self.onmessage = async (ev: MessageEvent<DetailRequest>) => {
  const q = ev.data;
  try {
    const bitmap = await compose(q);
    self.postMessage({ id: q.id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id: q.id, error: String(e) });
  }
};


type Ctx = OffscreenCanvasRenderingContext2D;
type ToPx = (a: number, b: number) => [number, number];
function trace(c: Ctx, rings: [number, number][][], f: ToPx): void {
  c.beginPath();
  for (const r of rings) r.forEach(([a, b], i) => (i ? c.lineTo(...f(a, b)) : c.moveTo(...f(a, b))));
}

function drawWaterways(ctx: Ctx, l: MvtLayer, f: ToPx, w: (m: number) => number): void {
  ctx.strokeStyle = "rgba(48, 70, 72, 0.85)";
  for (const feat of l.features) {
    if (feat.type !== 2) continue;
    const cls = String(feat.properties["class"] ?? "");
    ctx.lineWidth = w(cls === "river" ? 14 : cls === "canal" ? 8 : cls === "stream" ? 3 : 1.6);
    trace(ctx, feat.geometry, f);
    ctx.stroke();
  }
}

/** Roads (paved / dirt, with verges), railways; narrow first so junctions read right. */
/** Road surface textures as soft-light overlays (normalized to mid-grey: tone-neutral). */
interface RoadPatterns {
  track: CanvasPattern;
  gravel: CanvasPattern;
  asphalt: CanvasPattern;
}

/** Streets that get sidewalks in town. */
const SIDEWALK = new Set(["primary", "secondary", "tertiary", "minor"]);

function drawRoads(ctx: Ctx, roads: MvtLayer, f: ToPx, w: (m: number) => number, mPerPx: number, pats?: RoadPatterns, urban?: (geom: [number, number][][]) => boolean): void {
  const path = (_c: Ctx, rings: [number, number][][], g: ToPx) => trace(ctx, rings, g);
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
      // In town, up close: sidewalks (light concrete slabs) and a curb.
      if (r.paved && mPerPx < 4 && SIDEWALK.has(r.cls) && urban?.(r.ft.geometry)) {
        const sw = r.width + 2 * (r.cls === "minor" ? 2 : 3);
        ctx.strokeStyle = "rgb(136, 134, 128)";
        ctx.lineWidth = w(sw);
        ctx.stroke();
        if (pats && mPerPx < 1) {
          const op = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = "soft-light";
          ctx.strokeStyle = pats.gravel;
          ctx.stroke();
          ctx.globalCompositeOperation = op;
        }
        if (mPerPx < 0.5) {
          // Slab joints across the walk every 1.5 m (dashes of a thin wide stroke).
          ctx.setLineDash([w(0.06), w(1.44)]);
          ctx.strokeStyle = "rgba(90, 88, 84, 0.5)";
          ctx.lineWidth = w(sw - 0.4);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = "rgb(168, 166, 160)";
        ctx.lineWidth = w(r.width + 0.5);
        ctx.stroke();
      } else {
        ctx.strokeStyle = r.paved ? "rgba(70, 70, 68, 0.55)" : "rgba(120, 104, 82, 0.4)";
        ctx.lineWidth = w(r.width + 1.6);
        ctx.stroke();
      }
      ctx.strokeStyle = r.paved ? "rgb(108, 107, 104)" : "rgb(166, 148, 120)";
      ctx.lineWidth = w(r.width);
      ctx.stroke();
      // Up close, the surface photo on top: ruts on dirt tracks, gravel, asphalt.
      if (pats && mPerPx < 1) {
        const op = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "soft-light";
        ctx.strokeStyle = !r.paved ? pats.track : r.ft.properties["surface"] === "gravel" ? pats.gravel : pats.asphalt;
        ctx.stroke();
        ctx.globalCompositeOperation = op;
      }
      if (r.paved && r.width >= 9 && mPerPx < 0.8) {
        ctx.setLineDash([w(3), w(6)]);
        ctx.strokeStyle = "rgba(230, 230, 222, 0.8)";
        ctx.lineWidth = w(0.15);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

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

/**
 * Zoom 12–13: the satellite tile itself (unchanged, so tones match the plain layer beyond)
 * with roads, railways and waterways from the zoom-14 OSM tiles under it, faded by their
 * sub-pixel width. The handover to plain Sentinel-2 then happens where they are invisible.
 */
async function composeLow(q: DetailRequest): Promise<ImageBitmap> {
  const { x, y, z } = q;
  const k = 2 ** (14 - z);
  const jobs: Promise<[number, number, MvtLayer[]]>[] = [];
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) jobs.push(osm(q.osmUrl, x * k + i, y * k + j).then((l) => [x * k + i, y * k + j, l]));
  const [base, tiles] = await Promise.all([s2(q.s2Url, z, x, y), Promise.all(jobs)]);
  const cv = new OffscreenCanvas(SIZE, SIZE);
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(base, 0, 0, SIZE, SIZE);
  const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))) * 180) / Math.PI;
  const mPerPx = (C * Math.cos((latC * Math.PI) / 180)) / 2 ** z / SIZE;
  const w = (m: number) => {
    const px = m / mPerPx;
    ctx.globalAlpha = Math.min(1, Math.max(0.15, px));
    return Math.max(1, px);
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [X, Y, layers] of tiles)
    for (const l of layers) {
      const f: ToPx = (a, b) => [((X + a / l.extent) / k - x) * SIZE, ((Y + b / l.extent) / k - y) * SIZE];
      if (l.name === "waterway") drawWaterways(ctx, l, f, w);
      else if (l.name === "transportation") drawRoads(ctx, l, f, w, mPerPx);
    }
  nightLook(ctx, q, undefined, undefined);
  return flipped(cv);
}

async function compose(q: DetailRequest): Promise<ImageBitmap> {
  const { x, y, z } = q;
  if (z < 14) return composeLow(q);
  const d = z - 14;
  const sub = 2 ** d;
  const ax = x >> d, ay = y >> d, ox = x - ax * sub, oy = y - ay * sub;
  const [sat, layers, tex, roadTex] = await Promise.all([
    mosaic(q.s2Url, ax, ay),
    osm(q.osmUrl, ax, ay),
    groundTextures(q.texUrl),
    Promise.all((["track", "gravel", "asphalt"] as const).map((k) => texture(q.texUrl, k))),
  ]);
  const cv = new OffscreenCanvas(SIZE, SIZE);
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const src = 256 / sub;
  // `sat`: the zoom-14 satellite tile with its 8 neighbours (768×768), so the upsampling
  // reads real neighbours at tile borders, and features can be judged as a whole.

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

  const img = new ImageData(SIZE, SIZE);
  edgeAwareUpsample(sat, 768, 256 + ox * src, 256 + oy * src, src, img.data, SIZE, q.snap === false ? 0 : 0.8);
  // Plain upsampling for built-up ground (only when the tile has any).
  let smooth: Uint8ClampedArray | undefined;
  if (cover.includes(COVERS.indexOf("urban") + 1)) {
    smooth = new Uint8ClampedArray(SIZE * SIZE * 4);
    edgeAwareUpsample(sat, 768, 256 + ox * src, 256 + oy * src, src, smooth, SIZE, 0);
  }
  const az = (q.sun.azimuthDeg * Math.PI) / 180;
  const sunLow = Math.min(1.5, 1 / Math.tan((Math.max(8, q.sun.elevationDeg) * Math.PI) / 180));
  const n = 2 ** z;
  const world = { x0: ((x / n) * C - C / 2) * K, y0: (C / 2 - (y / n) * C) * K, mPerPx: (C / n / SIZE) * K };
  if (q.synth !== false) synthesize(img.data, {
    x0: ((x / n) * C - C / 2) * K,
    y0: (C / 2 - (y / n) * C) * K,
    mPerPx: (C / n / SIZE) * K,
    size: SIZE,
    sunX: Math.sin(az),
    sunY: Math.cos(az),
    sunLow,
  }, cover, tex, smooth);
  ctx.putImageData(img, 0, 0);

  // Crisp vectors on top.
  // Line width in pixels; lines thinner than a pixel are drawn one pixel wide and faded by
  // their width (so a 5 m track at 10 m/pixel is a faint trace, not a hard line).
  const w = (m: number) => {
    const px = m / mPerPx;
    ctx.globalAlpha = Math.min(1, Math.max(0.15, px));
    return Math.max(1, px);
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const l of layers) {
    const f = toPx(l.extent);
    if (l.name === "water") {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(46, 66, 68, 0.78)";
      for (const feat of l.features) if (feat.type === 3) { path(ctx, feat.geometry, f); ctx.fill("evenodd"); }
    } else if (l.name === "waterway") drawWaterways(ctx, l, f, w);
  }
  const looksGreen = (geom: [number, number][][], e: number): boolean => {
    let g = 0, n = 0;
    for (const line of geom)
      for (let i = 0; i + 1 < line.length; i++)
        for (const t of [0.2, 0.4, 0.6, 0.8]) {
          const u = ((line[i]![0] + (line[i + 1]![0] - line[i]![0]) * t) / e) * 256 + 256, v = ((line[i]![1] + (line[i + 1]![1] - line[i]![1]) * t) / e) * 256 + 256;
          if (u < 0 || v < 0 || u >= 768 || v >= 768) continue;
          const k = (Math.floor(v) * 768 + Math.floor(u)) * 4;
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
        ctx.globalAlpha = 1;
        ctx.fillStyle = grass ? "rgba(128, 148, 96, 0.22)" : "rgb(92, 92, 90)";
        ctx.fill("evenodd");
        continue;
      }
      const width = cls === "runway" ? 30 : 12;
      if (grass) {
        ctx.strokeStyle = "rgba(128, 148, 96, 0.22)"; // mown: a shade lighter, not a painted band
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
  // World-anchored patterns (they join across tiles), from the same coordinates as synth.
  const pattern = (t: LoadedTexture): CanvasPattern => {
    const p = ctx.createPattern(t.overlay, "repeat")!;
    const sc = t.detail.meters / t.detail.size / world.mPerPx, period = t.detail.size * sc;
    const mod = (v: number) => ((v % period) + period) % period;
    p.setTransform(new DOMMatrix([sc, 0, 0, sc, mod(-world.x0 / world.mPerPx), mod(world.y0 / world.mPerPx)]));
    return p;
  };
  const [trackT, gravelT, asphaltT] = roadTex;
  // Whether a line runs mostly through built-up land (the cover raster, sampled along it).
  const urbanIdx = COVERS.indexOf("urban") + 1;
  const isUrban = (e: number) => (geom: [number, number][][]): boolean => {
    let u = 0, n = 0;
    const f = toPx(e);
    for (const line of geom)
      for (let i = 0; i + 1 < line.length; i++)
        for (const t of [0.25, 0.5, 0.75]) {
          const [px, py] = f(line[i]![0] + (line[i + 1]![0] - line[i]![0]) * t, line[i]![1] + (line[i + 1]![1] - line[i]![1]) * t);
          if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
          n++;
          const k = Math.floor(py) * SIZE + Math.floor(px);
          if (cover[k] === urbanIdx) u++;
        }
    return n === 0 ? false : u / n > 0.5;
  };
  if (roads) drawRoads(ctx, roads, toPx(roads.extent), w, mPerPx, { track: pattern(trackT!), gravel: pattern(gravelT!), asphalt: pattern(asphaltT!) }, isUrban(roads.extent));
  const bld = layers.find((l) => l.name === "building");
  if (bld) {
    const f = toPx(bld.extent);
    // Concrete aprons (paved walks) round town buildings, up close.
    if (mPerPx < 4) {
      ctx.lineJoin = "miter";
      for (const ft of bld.features) {
        if (ft.type !== 3) continue;
        ctx.strokeStyle = "rgb(128, 126, 120)";
        ctx.lineWidth = w(2.4);
        path(ctx, ft.geometry, f);
        ctx.stroke();
      }
      ctx.lineJoin = "round";
    }
    const sdx = -Math.sin(az), sdy = Math.cos(az); // shadow direction in pixels (y down)
    for (const ft of bld.features) {
      if (ft.type !== 3 || (q.realShadows && z >= 15)) continue;
      const h = Number(ft.properties["render_height"] ?? 5);
      const off = Math.min(18, h * sunLow) / mPerPx;
      ctx.globalAlpha = 1;
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
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette[hash2(a + ax * 4096, b + ay * 4096, 61) % palette.length]!;
        path(ctx, [ring], f);
        ctx.fill();
      }
    }
  }
  nightLook(ctx, q, layers, toPx);
  return flipped(cv);
}

/** Darken the finished tile for the time of day; at night add the street lamps' pools of light. */
function nightLook(ctx: Ctx, q: DetailRequest, layers: MvtLayer[] | undefined, toPx: ((e: number) => ToPx) | undefined): void {
  const look = q.look;
  if (!look || look.ground >= 0.995) return;
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.globalCompositeOperation = "multiply";
  // Towards night the remaining light is bluish.
  const g = look.ground, n = look.night;
  ctx.fillStyle = `rgb(${Math.round(255 * g * (1 - 0.18 * n))}, ${Math.round(255 * g * (1 - 0.06 * n))}, ${Math.round(255 * Math.min(1, g * (1 + 0.25 * n)))})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (n > 0.3 && layers && toPx && q.z >= 14) {
    const lamps = streetLamps(layers, 14, q.y >> (q.z - 14));
    const f = toPx(lamps.extent);
    const latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (q.y + 0.5)) / 2 ** q.z))) * 180) / Math.PI;
    const r = 15 / ((C * Math.cos((latC * Math.PI) / 180)) / 2 ** q.z / SIZE); // 15 m pools
    ctx.globalCompositeOperation = "lighter";
    const a = 0.34 * Math.min(1, (n - 0.3) / 0.4);
    for (const [u, v] of lamps.pts) {
      const [px, py] = f(u, v);
      if (px < -r || py < -r || px > SIZE + r || py > SIZE + r) continue;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `rgba(255, 190, 110, ${a})`);
      grad.addColorStop(0.35, `rgba(255, 170, 90, ${a * 0.45})`);
      grad.addColorStop(1, "rgba(255, 160, 80, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(px - r, py - r, 2 * r, 2 * r);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}
