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
  /**
   * When frozen, heightAt() uses only tiles already loaded and never starts loads: results
   * then can't depend on when a download finishes (deterministic training episodes).
   */
  frozen = false;

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
      if (load && !this.frozen) void this.loadTile(z, tx, ty);
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
  /** Number of decoded tiles in memory. */
  get tileCount(): number {
    return this.tiles.size;
  }

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
    // Keep our own references: concurrent requests may evict tiles from the shared cache
    // between loading and sampling.
    const local = new Map<string, Float32Array | undefined>();
    const jobs: Promise<unknown>[] = [];
    for (let x = Math.floor(x0) - 1; x <= Math.floor(x1) + 1; x++) {
      for (let y = Math.max(0, Math.floor(y0) - 1); y <= Math.min(n - 1, Math.floor(y1) + 1); y++) {
        const tx = ((x % n) + n) % n;
        jobs.push(this.loadTile(zoom, tx, y).then((t) => local.set(tileKey(zoom, tx, y), t)));
      }
    }
    await Promise.all(jobs);
    const pixel = (gx: number, gy: number): number => {
      const tx = ((Math.floor(gx / 256) % n) + n) % n, ty = Math.min(n - 1, Math.max(0, Math.floor(gy / 256)));
      const t = local.get(tileKey(zoom, tx, ty));
      if (!t) return NaN;
      return t[Math.min(255, Math.max(0, gy - ty * 256)) * 256 + (((gx % 256) + 256) % 256)]!;
    };
    const out = new Float32Array(width * height);
    let last = 0;
    for (let r = 0; r < height; r++) {
      const lat = north - ((north - south) * r) / (height - 1);
      for (let c = 0; c < width; c++) {
        const [tx, ty] = lonLatToTile(west + ((east - west) * c) / (width - 1), lat, zoom);
        const gx = tx * 256 - 0.5, gy = ty * 256 - 0.5;
        const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
        const h = (pixel(ix, iy) * (1 - fx) + pixel(ix + 1, iy) * fx) * (1 - fy) + (pixel(ix, iy + 1) * (1 - fx) + pixel(ix + 1, iy + 1) * fx) * fy;
        // A missing (failed) tile: repeat the last good value rather than drop to sea level.
        out[r * width + c] = Number.isFinite(h) ? (last = h) : last;
      }
    }
    return out;
  }

  /**
   * Heights at the pixel centres of Web Mercator tile (z, x, y), with a 1-pixel border:
   * (size + 2)² values, row 0 = north. Up to this terrain's zoom the grid is the Terrarium
   * tile itself (plus neighbours' edges); deeper, it is upsampled bilinearly from it.
   * Missing tiles read as 0.
   */
  async heightGrid(z: number, x: number, y: number, size = 256): Promise<Float32Array> {
    const zs = Math.min(z, this.zoom);
    const scale = 2 ** (z - zs);
    const n = 2 ** zs;
    // Source tile containing this tile's centre, and its 8 neighbours.
    const sx = Math.floor(((x + 0.5) * 256) / scale / 256), sy = Math.floor(((y + 0.5) * 256) / scale / 256);
    const tiles: (Float32Array | undefined)[] = [];
    await Promise.all(
      [-1, 0, 1].flatMap((dy) =>
        [-1, 0, 1].map(async (dx) => {
          const ty = sy + dy;
          tiles[(dy + 1) * 3 + dx + 1] = ty < 0 || ty >= n ? undefined : await this.loadTile(zs, (((sx + dx) % n) + n) % n, ty);
        }),
      ),
    );
    const px = (gx: number, gy: number): number => {
      const tx = Math.floor(gx / 256) - sx, ty = Math.floor(gy / 256) - sy;
      const t = tiles[(Math.max(-1, Math.min(1, ty)) + 1) * 3 + Math.max(-1, Math.min(1, tx)) + 1];
      if (!t) return 0;
      const ix = Math.max(0, Math.min(255, gx - (sx + Math.max(-1, Math.min(1, tx))) * 256));
      const iy = Math.max(0, Math.min(255, gy - (sy + Math.max(-1, Math.min(1, ty))) * 256));
      return t[iy * 256 + ix]!;
    };
    const pad = size + 2;
    const out = new Float32Array(pad * pad);
    for (let j = 0; j < pad; j++) {
      // Pixel centre of row j-1 of this tile, in source-zoom global pixel coordinates.
      const gy = ((y * size + (j - 1) + 0.5) / size) * (256 / scale) - 0.5;
      const y0 = Math.floor(gy), fy = gy - y0;
      for (let i = 0; i < pad; i++) {
        const gx = ((x * size + (i - 1) + 0.5) / size) * (256 / scale) - 0.5;
        const x0 = Math.floor(gx), fx = gx - x0;
        if (fx === 0 && fy === 0) out[j * pad + i] = px(x0, y0);
        else {
          const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
          out[j * pad + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        }
      }
    }
    return out;
  }

  /**
   * An n×n heightmap over Web Mercator tile (z, x, y), samples on the tile's edges and
   * evenly spaced in Mercator (row 0 north): Cesium's heightmap layout for a Web Mercator
   * tiling scheme, so neighbouring tiles share their edge samples. Bilinear between the
   * Terrarium pixel centres at min(z, this.zoom).
   */
  async mercatorHeightmap(z: number, x: number, y: number, n: number): Promise<Float32Array> {
    const zs = Math.min(z, this.zoom);
    const scale = 2 ** (z - zs);
    const nt = 2 ** zs;
    const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
    const tiles: (Float32Array | undefined)[] = [];
    await Promise.all(
      [-1, 0, 1].flatMap((dy) =>
        [-1, 0, 1].map(async (dx) => {
          const ty = sy + dy;
          tiles[(dy + 1) * 3 + dx + 1] = ty < 0 || ty >= nt ? undefined : await this.loadTile(zs, (((sx + dx) % nt) + nt) % nt, ty);
        }),
      ),
    );
    const centre = tiles[4];
    const px = (gx: number, gy: number): number => {
      const dx = Math.max(-1, Math.min(1, Math.floor(gx / 256) - sx)), dy = Math.max(-1, Math.min(1, Math.floor(gy / 256) - sy));
      const t = tiles[(dy + 1) * 3 + dx + 1] ?? centre;
      if (!t) return 0;
      const ix = Math.max(0, Math.min(255, gx - (sx + dx) * 256)), iy = Math.max(0, Math.min(255, gy - (sy + dy) * 256));
      return t[iy * 256 + ix]!;
    };
    const out = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      const gy = ((y + r / (n - 1)) * 256) / scale - 0.5;
      const y0 = Math.floor(gy), fy = gy - y0;
      for (let c = 0; c < n; c++) {
        const gx = ((x + c / (n - 1)) * 256) / scale - 0.5;
        const x0 = Math.floor(gx), fx = gx - x0;
        out[r * n + c] = (px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx) * (1 - fy) + (px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
    return out;
  }

  /** Height after loading what it needs. */
  async heightAtAsync(latDeg: number, lonDeg: number, zoom = this.zoom): Promise<number> {
    await this.load(latDeg, lonDeg, 50, zoom);
    return this.heightAt(latDeg, lonDeg, zoom) ?? 0;
  }
}
