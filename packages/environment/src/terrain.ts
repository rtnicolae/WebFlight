/**
 * Terrain heights from Terrarium-encoded elevation tiles (AWS Terrain Tiles, public, no key):
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   height_m = R * 256 + G + B / 256 - 32768   (Web Mercator tiles, 256×256)
 *
 * One source serves the FDM (worker / Node) and the renderer's terrain mesh, so the ground
 * the glider touches is the ground drawn. Heights are used as heights above the WGS84
 * ellipsoid; Terrarium values are above mean sea level, so the geoid separation (≈ +48 m in
 * Switzerland) is ignored consistently everywhere.
 */
import { decodePng } from "./png.ts";

export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export interface TerrainOptions {
  /** Tile zoom used for heights (13 ≈ 13 m pixels at 47°N). */
  zoom?: number;
  /** Fetch a tile's PNG bytes (default: global fetch of TERRARIUM_URL). */
  fetchTile?: (z: number, x: number, y: number) => Promise<Uint8Array>;
  /** Keep at most this many decoded tiles. */
  maxTiles?: number;
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

export async function fetchTerrariumTile(z: number, x: number, y: number, url = TERRARIUM_URL): Promise<Uint8Array> {
  const u = url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(u);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      if (r.status === 404) break;
    } catch {}
    await new Promise<void>((res) => setTimeout(() => res(), 500 * 2 ** i));
  }
  throw new Error(`terrain tile ${z}/${x}/${y} unavailable`);
}

/** Web Mercator tile coordinates (fractional) of a position at zoom z. */
export function lonLatToTile(lonDeg: number, latDeg: number, z: number): [number, number] {
  const n = 2 ** z;
  const lat = (Math.max(-85.0511, Math.min(85.0511, latDeg)) * Math.PI) / 180;
  return [((lonDeg + 180) / 360) * n, ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n];
}

export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export class TerrariumTerrain {
  readonly zoom: number;
  private readonly fetchTile: NonNullable<TerrainOptions["fetchTile"]>;
  private readonly maxTiles: number;
  /** Decoded heights per tile (256×256 Float32). */
  private readonly tiles = new Map<string, Float32Array>();
  private readonly pending = new Map<string, Promise<Float32Array | undefined>>();
  private readonly failed = new Set<string>();

  constructor(opts: TerrainOptions = {}) {
    this.zoom = opts.zoom ?? 13;
    this.fetchTile = opts.fetchTile ?? ((z, x, y) => fetchTerrariumTile(z, x, y));
    this.maxTiles = opts.maxTiles ?? 256;
  }

  private loadTile(z: number, x: number, y: number): Promise<Float32Array | undefined> {
    const key = tileKey(z, x, y);
    const have = this.tiles.get(key);
    if (have) return Promise.resolve(have);
    if (this.failed.has(key)) return Promise.resolve(undefined);
    let p = this.pending.get(key);
    if (!p) {
      p = this.fetchTile(z, x, y)
        .then(decodePng)
        .then((img) => {
          const h = new Float32Array(img.width * img.height);
          for (let i = 0, j = 0; i < h.length; i++, j += img.channels) h[i] = img.pixels[j]! * 256 + img.pixels[j + 1]! + img.pixels[j + 2]! / 256 - 32768;
          if (this.tiles.size >= this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
          this.tiles.set(key, h);
          return h;
        })
        .catch(() => {
          this.failed.add(key);
          return undefined;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  /** Pixel height at integer global pixel coordinates (undefined if the tile isn't loaded). */
  private pixel(z: number, gx: number, gy: number, load: boolean): number | undefined {
    const n = 2 ** z;
    const tx = ((Math.floor(gx / 256) % n) + n) % n, ty = Math.min(n - 1, Math.max(0, Math.floor(gy / 256)));
    const t = this.tiles.get(tileKey(z, tx, ty));
    if (!t) {
      if (load) void this.loadTile(z, tx, ty);
      return undefined;
    }
    const px = ((gx % 256) + 256) % 256, py = Math.min(255, Math.max(0, gy - ty * 256));
    return t[py * 256 + px];
  }

  /**
   * Bilinear height [m] at a position, or undefined while its tiles are loading (the load is
   * started). Synchronous, for use inside the FDM step.
   */
  heightAt(latDeg: number, lonDeg: number, zoom = this.zoom): number | undefined {
    const [tx, ty] = lonLatToTile(lonDeg, latDeg, zoom);
    // Pixel centres sit at +0.5.
    const gx = tx * 256 - 0.5, gy = ty * 256 - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const h00 = this.pixel(zoom, x0, y0, true), h10 = this.pixel(zoom, x0 + 1, y0, true);
    const h01 = this.pixel(zoom, x0, y0 + 1, true), h11 = this.pixel(zoom, x0 + 1, y0 + 1, true);
    if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined) return undefined;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  /** Load the tiles covering a square of ±radiusM around a position. */
  async load(latDeg: number, lonDeg: number, radiusM = 3000, zoom = this.zoom): Promise<void> {
    const dLat = radiusM / 111_132, dLon = radiusM / (111_320 * Math.cos((latDeg * Math.PI) / 180));
    const [x0, y0] = lonLatToTile(lonDeg - dLon, latDeg + dLat, zoom);
    const [x1, y1] = lonLatToTile(lonDeg + dLon, latDeg - dLat, zoom);
    const jobs: Promise<unknown>[] = [];
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) jobs.push(this.loadTile(zoom, x, y));
    await Promise.all(jobs);
  }

  /**
   * A heightmap grid over a lon/lat rectangle, row 0 at the north edge (Cesium's
   * HeightmapTerrainData layout), sampled bilinearly from the coarsest zoom whose pixels are
   * no larger than the grid spacing (capped at this terrain's zoom). Near the aircraft the
   * renderer's mesh therefore uses the very heights the FDM uses.
   */
  async heightmap(west: number, south: number, east: number, north: number, width: number, height: number): Promise<Float32Array> {
    const spacingDeg = (east - west) / (width - 1);
    const zoom = Math.max(0, Math.min(this.zoom, Math.ceil(Math.log2(360 / (256 * spacingDeg)))));
    const [x0, y0] = lonLatToTile(west, north, zoom);
    const [x1, y1] = lonLatToTile(east, south, zoom);
    const n = 2 ** zoom;
    const jobs: Promise<unknown>[] = [];
    for (let x = Math.floor(x0 - 0.01); x <= Math.floor(x1 + 0.01); x++) {
      for (let y = Math.max(0, Math.floor(y0 - 0.01)); y <= Math.min(n - 1, Math.floor(y1 + 0.01)); y++) jobs.push(this.loadTile(zoom, ((x % n) + n) % n, y));
    }
    await Promise.all(jobs);
    const out = new Float32Array(width * height);
    for (let r = 0; r < height; r++) {
      const lat = north - ((north - south) * r) / (height - 1);
      for (let c = 0; c < width; c++) out[r * width + c] = this.heightAt(lat, west + ((east - west) * c) / (width - 1), zoom) ?? 0;
    }
    return out;
  }

  /** Height after loading what it needs. */
  async heightAtAsync(latDeg: number, lonDeg: number, zoom = this.zoom): Promise<number> {
    await this.load(latDeg, lonDeg, 50, zoom);
    return this.heightAt(latDeg, lonDeg, zoom) ?? 0;
  }
}
