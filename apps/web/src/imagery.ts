/**
 * Ground imagery:
 *  - "photo": swisstopo SWISSIMAGE (aerial photos, ~10 cm, over Switzerland) on top of EOX
 *    Sentinel-2 cloudless 2016 (10 m, worldwide). Both free, no key, attribution required.
 *  - "painted": land cover and hillshade generated from the terrain heights (workers), the
 *    fallback when the photo servers can't be reached.
 *  - "grid" / "osm": the old debug looks.
 */
import { Credit, Event, GridImageryProvider, ImageryLayer, OpenStreetMapImageryProvider, Rectangle, UrlTemplateImageryProvider, WebMercatorTilingScheme, Color, type ImageryProvider, type Viewer } from "cesium";
import { sunFrom, type Sun } from "./paint/landcover.ts";
import type { PaintRequest } from "./paint/paint-worker.ts";

export type ImageryMode = "photo" | "painted" | "grid" | "osm";

const SWISSIMAGE = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg";
const S2CLOUDLESS = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
/** SWISSIMAGE coverage (a little larger than Switzerland). */
const SWISS_RECT = Rectangle.fromDegrees(5.8, 45.75, 10.6, 47.9);

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

/** Can the photo servers be reached (one tile each, with a timeout)? */
export async function photoAvailable(timeoutMs = 4000): Promise<boolean> {
  const probe = async (url: string) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: c.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  const tile = (u: string) => u.replace("{z}", "13").replace("{x}", "4264").replace("{y}", "2898");
  const [ch, s2] = await Promise.all([probe(tile(SWISSIMAGE)), probe(tile(S2CLOUDLESS))]);
  return ch || s2;
}

export async function addImagery(viewer: Viewer, mode: ImageryMode, sun: { azimuthDeg: number; elevationDeg: number }): Promise<ImageryMode> {
  const layers = viewer.imageryLayers;
  if (mode === "photo" && !(await photoAvailable())) {
    console.warn("photo imagery unreachable; using painted terrain");
    mode = "painted";
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
    layers.add(
      new ImageryLayer(
        new UrlTemplateImageryProvider({ url: SWISSIMAGE, rectangle: SWISS_RECT, minimumLevel: 8, maximumLevel: 19, credit: new Credit('© <a href="https://www.swisstopo.admin.ch">swisstopo</a> SWISSIMAGE') }),
      ),
    );
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
