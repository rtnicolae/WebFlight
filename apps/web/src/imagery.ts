/**
 * Ground imagery:
 *  - "photo": free national orthophotos (Spain, France, Poland, Czechia, the Netherlands,
 *    Flanders, Austria, Switzerland on top) over EOX Sentinel-2 cloudless 2016 (10 m,
 *    everywhere). All free, no key, attribution shown in the credits.
 *  - "painted": land cover and hillshade generated from the terrain heights (workers), the
 *    fallback when the photo servers can't be reached.
 *  - "grid" / "osm": the old debug looks.
 */
import { ArcGisBaseMapType, ArcGisMapServerImageryProvider, ArcGisMapService, Google2DImageryProvider, Ion, IonImageryProvider, Cartesian2, Cartographic, Credit, DiscardMissingTileImagePolicy, Event, GridImageryProvider, ImageryLayer, OpenStreetMapImageryProvider, Rectangle, UrlTemplateImageryProvider, WebMercatorTilingScheme, Color, type ImageryProvider, type Viewer } from "cesium";
import { sunFrom, type Sun } from "./paint/landcover.ts";
import type { PaintRequest } from "./paint/paint-worker.ts";
import type { DetailRequest } from "./detail/detail-worker.ts";
import { LOOK } from "./lighting.ts";
import { openFreeMapTiles } from "./osm-source.ts";
import { addGroundDetail } from "./ground-detail.ts";

export type ImageryMode = "photo" | "painted" | "grid" | "osm";

const SWISSIMAGE = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg";
export const S2CLOUDLESS = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
/**
 * Free national orthophotos (no key), all Web Mercator tiles with CORS; each checked for a
 * real photo inside and for what it returns outside its country (errors, or white tiles:
 * `outsideTile` for the discard policy). Layered in this order, so later ones win where the
 * rectangles overlap (France over Spain's border mosaic, Switzerland on top).
 */
interface Ortho {
  name: string;
  url: string;
  /** [west, south, east, north] degrees: the service's coverage (a little larger than the country). */
  bbox: [number, number, number, number];
  maximumLevel: number;
  credit: string;
  /** A tile outside the coverage that comes back blank, to discard such tiles. */
  outsideTile?: string;
}
const KVP = (base: string, layer: string, set: string, matrix: string, format = "image/jpeg", style = "default") =>
  `${base}${base.includes("?") ? "&" : "?"}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}&FORMAT=${format}&TILEMATRIXSET=${set}&TILEMATRIX=${matrix}&TILEROW={y}&TILECOL={x}`;
const ORTHOS: Ortho[] = [
  // Spain: IGN PNOA (CC BY 4.0, scne.es).
  { name: "es", url: KVP("https://www.ign.es/wmts/pnoa-ma", "OI.OrthoimageCoverage", "GoogleMapsCompatible", "{z}"), bbox: [-9.6, 35.8, 4.6, 44.0], maximumLevel: 20, credit: "PNOA © IGN España (scne.es), CC BY 4.0" },
  // France: IGN Géoplateforme (~20 cm; Licence Ouverte 2.0).
  { name: "fr", url: KVP("https://data.geopf.fr/wmts", "ORTHOIMAGERY.ORTHOPHOTOS", "PM", "{z}", "image/jpeg", "normal"), bbox: [-5.3, 41.2, 9.7, 51.2], maximumLevel: 19, credit: "© IGN – Géoplateforme (orthophotos)" },
  // Poland: GUGiK Geoportal (no restrictions; Geoportal terms).
  { name: "pl", url: KVP("https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution", "ORTOFOTOMAPA", "EPSG:3857", "EPSG:3857:{z}"), bbox: [14.0, 48.9, 24.2, 55.0], maximumLevel: 19, credit: "Ortofotomapa © GUGiK (geoportal.gov.pl)" },
  // Czechia: ČÚZK (ArcGIS tiles; errors outside).
  { name: "cz", url: "https://ags.cuzk.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}", bbox: [11.8, 48.5, 19.0, 51.2], maximumLevel: 20, credit: "Ortofoto © ČÚZK" },
  // Netherlands: PDOK / Beeldmateriaal (no fees or constraints); white tiles outside.
  {
    name: "nl",
    url: "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{zz}/{x}/{y}.jpeg",
    bbox: [3.2, 50.7, 7.3, 53.6],
    maximumLevel: 20,
    credit: "Luchtfoto © Beeldmateriaal Nederland (PDOK)",
    outsideTile: "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/14/8510/5448.jpeg",
  },
  // Flanders: Digitaal Vlaanderen (free; Vlaanderen terms); errors outside.
  { name: "vl", url: KVP("https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts", "omwrgbmrvl", "GoogleMapsVL", "{z}", "image/png", ""), bbox: [2.5, 50.65, 5.95, 51.55], maximumLevel: 20, credit: "Orthofoto © Digitaal Vlaanderen" },
  // Austria: basemap.at (30 cm; CC BY 4.0).
  { name: "at", url: "https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg", bbox: [9.4, 46.3, 17.3, 49.1], maximumLevel: 19, credit: '<a href="https://basemap.at">basemap.at</a> orthofoto, CC BY 4.0' },
];
const rect = (o: Ortho) => Rectangle.fromDegrees(...o.bbox);

function orthoLayer(o: Ortho): ImageryLayer {
  // PDOK names its zoom levels with two digits.
  const custom = o.url.includes("{zz}") ? { customTags: { zz: (_p: unknown, _x: number, _y: number, level: number) => String(level).padStart(2, "0") } } : {};
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: o.url,
      rectangle: rect(o),
      minimumLevel: 6,
      maximumLevel: o.maximumLevel,
      credit: new Credit(o.credit),
      ...custom,
      ...(o.outsideTile ? { tileDiscardPolicy: new DiscardMissingTileImagePolicy({ missingImageUrl: o.outsideTile, pixelsToCheck: [new Cartesian2(0, 0), new Cartesian2(128, 128), new Cartesian2(255, 255), new Cartesian2(40, 200)] }) } : {}),
    }),
  );
}

/** SWISSIMAGE coverage (a little larger than Switzerland). */
const SWISS_RECT = Rectangle.fromDegrees(5.8, 45.75, 10.6, 47.9);

/** SWISSIMAGE aerial photos (Switzerland). */
/** Whether the photo layers have sub-metre orthophotos here (else Sentinel-2's 10 m pixels). */
export function highResPhotoAt(latDeg: number, lonDeg: number): boolean {
  const c = Cartographic.fromDegrees(lonDeg, latDeg);
  return [SWISS_RECT, ...ORTHOS.map(rect)].some((r) => Rectangle.contains(r, c));
}

export function swissImageProvider(): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({ url: SWISSIMAGE, rectangle: SWISS_RECT, minimumLevel: 8, maximumLevel: 20, credit: new Credit('© <a href="https://www.swisstopo.admin.ch">swisstopo</a> SWISSIMAGE') });
}

/** Painted tiles from a small worker pool. */
export class PaintedImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly minimumLevel = 0;
  readonly maximumLevel = 15;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly credit = new Credit("Painted from Mapzen Terrarium heights");
  readonly proxy = undefined;
  readonly hasAlphaChannel = false;
  readonly ready = true;
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private rr = 0;

  constructor(private readonly sun: Sun) {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./paint/paint-worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.bitmap) p.resolve(ev.data.bitmap);
        else p.reject(new Error(ev.data.error ?? "paint failed"));
      };
      this.workers.push(w);
    }
  }

  getTileCredits(): undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<ImageBitmap> | undefined {
    // Back-pressure: Cesium retries a tile later when this returns undefined.
    if (this.pending.size >= 6 * this.workers.length) return undefined;
    const id = this.nextId++;
    const w = this.workers[this.rr++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, x, y, z: level, sun: this.sun } satisfies PaintRequest);
    });
  }
}

/**
 * Synthesized detail (zoom 12–18) wherever the photos are only Sentinel-2: see
 * detail/detail-worker.ts. Tiles inside a national orthophoto's coverage come back empty.
 */
const DETAIL_MIN_LEVEL = 12;
export class DetailImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  // minimumLevel must stay low: Cesium would otherwise build zoom-15 imagery for every
  // coarse terrain tile (millions). Below DETAIL_MIN_LEVEL tiles come back empty, and the
  // layer only applies on detailed terrain (minimumTerrainLevel).
  readonly minimumLevel = 0;
  // Down to ~5 cm per pixel under a glider standing on the field.
  readonly maximumLevel = 20;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new Event();
  readonly credit = new Credit("Ground detail synthesized from Sentinel-2 and © OpenStreetMap contributors");
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  readonly ready = true;
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, { key: string; resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private rr = 0;
  private empty: ImageBitmap | undefined;
  /** The tiles carry the time of day themselves (darkening, lamp light): see lighting.ts. */
  readonly selfLit = true;
  /** Composed tiles, least recently used first (~260 kB each). */
  private readonly cache = new Map<string, ImageBitmap>();

  constructor(
    private readonly osmUrl: string,
    private readonly sun: { azimuthDeg: number; elevationDeg: number },
    /** 3D shadows are on: near tiles leave building shadows to them. */
    private readonly realShadows = false,
  ) {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./detail/detail-worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.bitmap) {
          // Keep it: when Cesium drops a tile (camera turned away) and wants it again, it is
          // not composed again.
          this.cache.set(p.key, ev.data.bitmap);
          if (this.cache.size > 500) {
            // Not closed: Cesium may not have made its texture from it yet.
            this.cache.delete(this.cache.keys().next().value!);
          }
          p.resolve(ev.data.bitmap);
        } else p.reject(new Error(ev.data.error ?? "detail failed"));
      };
      this.workers.push(w);
    }
    void createImageBitmap(new ImageData(1, 1)).then((b) => (this.empty = b));
    // Tiles that still fail (sources rate-limited after the worker's backoff): let Cesium
    // try again a few times rather than keep a hole.
    this.errorEvent.addEventListener((e: { retry: boolean; timesRetried: number }) => {
      e.retry = e.timesRetried < 5;
    });
  }

  getTileCredits(): undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<ImageBitmap> | undefined {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const c = Rectangle.center(r);
    if (level < DETAIL_MIN_LEVEL || highResPhotoAt((c.latitude * 180) / Math.PI, (c.longitude * 180) / Math.PI)) return this.empty ? Promise.resolve(this.empty) : undefined;
    const key = `${level}/${x}/${y}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    // Back-pressure: Cesium retries a tile later when this returns undefined.
    if (this.pending.size >= 6 * this.workers.length) return undefined;
    const id = this.nextId++;
    const w = this.workers[this.rr++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { key, resolve, reject });
      const dbg = new URLSearchParams(location.search);
      w.postMessage({ id, x, y, z: level, s2Url: S2CLOUDLESS, osmUrl: this.osmUrl, texUrl: new URL(`${import.meta.env.BASE_URL}textures/`, location.href).href, sun: this.sun, realShadows: this.realShadows, look: { ground: LOOK.ground, night: 1 - LOOK.day }, gpu: dbg.get("detailgpu") !== "0", synth: dbg.get("synth") !== "0", snap: dbg.get("snap") !== "0" } satisfies DetailRequest);
    });
  }
}

/** Can the photo servers be reached (one tile each, with a timeout)? */
export async function photoAvailable(timeoutMs = 10000): Promise<boolean> {
  const tile = (u: string) => u.replace("{z}", "13").replace("{x}", "4264").replace("{y}", "2898");
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  const probe = (url: string) =>
    fetch(url, { signal: c.signal }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return true;
    });
  try {
    // Whichever server answers first is enough.
    return await Promise.any([probe(tile(SWISSIMAGE)), probe(tile(S2CLOUDLESS))]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    c.abort();
  }
}

/**
 * Romania: ANCPI's orthophotos, if this browser can reach the geoportal (it did not answer
 * from outside Romania when this was written). The newest MapServer in its "Ortofoto" folder
 * is discovered from the ArcGIS REST listing and layered above the synthesized detail.
 */
const ANCPI = "https://geoportal.ancpi.ro/maps/rest/services/Ortofoto";
async function addAncpi(viewer: Viewer): Promise<void> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${ANCPI}?f=json`, { signal: ctl.signal });
    clearTimeout(t);
    const j = (await r.json()) as { services?: { name: string; type: string }[] };
    const ms = (j.services ?? []).filter((s) => s.type === "MapServer").map((s) => s.name).sort();
    const newest = ms[ms.length - 1];
    if (!newest) return;
    const provider = await ArcGisMapServerImageryProvider.fromUrl(`https://geoportal.ancpi.ro/maps/rest/services/${newest}/MapServer`);
    const layer = new ImageryLayer(provider, { rectangle: Rectangle.fromDegrees(20.2, 43.6, 29.8, 48.3) });
    // Below the other national layers (they don't overlap Romania), above the detail.
    viewer.imageryLayers.add(layer, viewer.imageryLayers.length - ORTHOS.length);
    console.info(`ANCPI orthophotos: ${newest}`);
  } catch (e) {
    console.info("ANCPI orthophotos unavailable here; using synthesized detail:", e instanceof Error ? e.message : e);
  }
}

/**
 * Which aerial photos cover the ground (?aerial=): Bing via Cesium ion (default), Esri World
 * Imagery (Maxar Vivid; Cesium's default ArcGIS key, or VITE_ARCGIS_KEY), Google's 2D
 * satellite tiles via Cesium ion, or s2 (Sentinel-2 with the synthesized detail).
 * Compared round Brașov on 2026-11-17 (Esri: 2024–25, ~0.3 m, served to zoom 17–18 here;
 * Google: sharpest, true ortho in towns, but a faint "© Google" in the tiles and a blue-magenta
 * cast over fields); Esri and Google are switches for comparison, Bing stays the default.
 */
export type AerialSource = "bing" | "esri" | "google" | "s2";
export const AERIAL: AerialSource = ((a) => (["bing", "esri", "google", "s2"].includes(a ?? "") ? a : "bing"))(new URLSearchParams(location.search).get("aerial")) as AerialSource;

/** The photo's tile URL template (tile-url.ts), once the photo layer is up (else undefined). */
export let photoTileUrl: string | undefined;

/** Bing, Esri or Google aerial photos as the ground's one imagery layer. */
async function addAerial(viewer: Viewer, source: Exclude<AerialSource, "s2">): Promise<void> {
  const layers = viewer.imageryLayers;
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  if (token) Ion.defaultAccessToken = token;
  if (source === "esri") {
    // Esri's basemap service; tiles it has no photo for come back as a grey "Map data not yet
    // available" image, which the provider's discard policy drops (the parent tile shows).
    const key = import.meta.env.VITE_ARCGIS_KEY as string | undefined;
    if (key) ArcGisMapService.defaultAccessToken = key;
    layers.add(new ImageryLayer(await ArcGisMapServerImageryProvider.fromBasemapType(ArcGisBaseMapType.SATELLITE)));
    photoTileUrl = `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(ArcGisMapService.defaultAccessToken)}`;
    return;
  }
  if (source === "google") {
    // Google Map Tiles API, satellite, through Cesium ion (asset 3830182). Display only:
    // Google's tile policies forbid "non-visualization use cases" such as image analysis, so
    // no photoTileUrl (roofs keep palette colours, no photo alignment, grass from Sentinel-2).
    const google = await Google2DImageryProvider.fromIonAssetId({ assetId: "3830182" });
    layers.add(new ImageryLayer(google as unknown as ImageryProvider));
    return;
  }
  const bing = await IonImageryProvider.fromAssetId(2);
  layers.add(new ImageryLayer(bing));
  // The tile URL template (quadkey addressed) for workers that need the photo's colours.
  const inner = (bing as unknown as { _imageryProvider?: { _imageUrlTemplate?: string; _imageUrlSubdomains?: string[] } })._imageryProvider;
  if (inner?._imageUrlTemplate) photoTileUrl = inner._imageUrlTemplate.replace("{subdomain}", inner._imageUrlSubdomains?.[0] ?? "t0").replace("{culture}", "").replace(/^http:/, "https:");
}

export async function addImagery(viewer: Viewer, mode: ImageryMode, sun: { azimuthDeg: number; elevationDeg: number }): Promise<ImageryMode> {
  const layers = viewer.imageryLayers;
  if (mode === "photo" && !(await photoAvailable())) {
    console.warn("photo imagery unreachable; using painted terrain");
    mode = "painted";
  }
  // Sub-metre aerial photos (Bing by default, see AERIAL) alone: they cover everywhere the
  // other layers do, and every extra layer is more textures per ground tile (Cesium's ground
  // shader has 16 texture units in all). Close-range detail is drawn in the ground shader
  // (ground-detail.ts). ?aerial=s2 for Sentinel-2 with the synthesized detail and the national
  // orthophotos. The Cesium ion token comes from VITE_CESIUM_ION_TOKEN (apps/web/.env.local);
  // without one, Cesium's evaluation token.
  if (mode === "photo" && AERIAL !== "s2") {
    await addAerial(viewer, AERIAL);
    if (new URLSearchParams(location.search).get("gdetail") !== "0") addGroundDetail(viewer, new URL(`${import.meta.env.BASE_URL}textures/`, location.href).href);
    return mode;
  }
  if (mode === "photo") {
    layers.add(
      new ImageryLayer(
        new UrlTemplateImageryProvider({
          url: S2CLOUDLESS,
          maximumLevel: 15,
          credit: new Credit('Sentinel-2 cloudless 2016 by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2016), CC BY 4.0'),
        }),
      ),
    );
    // National orthophotos where they are free, Switzerland on top (sharpest, and where the
    // 3D scenery is). Elsewhere Sentinel-2 (10 m) shows through.
    // Where photos are only 10 m: detail synthesized from them and OpenStreetMap (visual only).
    const osmUrl = await openFreeMapTiles();
    if (osmUrl && new URLSearchParams(location.search).get("detail") !== "0") layers.add(new ImageryLayer(new DetailImageryProvider(osmUrl, sun, viewer.shadows) as unknown as ImageryProvider, { minimumTerrainLevel: 10 }));
    for (const o of ORTHOS) layers.add(orthoLayer(o));
    void addAncpi(viewer);
    layers.add(new ImageryLayer(swissImageProvider()));
  } else if (mode === "painted") {
    layers.add(new ImageryLayer(new PaintedImageryProvider(sunFrom(sun.azimuthDeg, Math.max(5, sun.elevationDeg))) as unknown as ImageryProvider));
  } else if (mode === "osm") {
    layers.add(new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })));
  } else {
    layers.add(
      new ImageryLayer(
        new GridImageryProvider({ cells: 8, color: Color.fromCssColorString("#d9e6c3").withAlpha(0.55), glowColor: Color.fromCssColorString("#d9e6c3").withAlpha(0.08), backgroundColor: Color.fromCssColorString("#5f7f3e") }),
      ),
    );
  }
  return mode;
}
