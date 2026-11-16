/**
 * 3D scenery. Elsewhere in Europe: OpenStreetMap buildings and forest trees (osm-layer.ts).
 * Over Switzerland from swisstopo open data (no key):
 *  - buildings: swissTLM3D buildings as 3D Tiles (real roof shapes)
 *  - trees: swisstopo vegetation 3D Tiles (instanced tree models at surveyed positions)
 *  - water: lakes and rivers from the base vector tiles, drawn with an animated water
 *    material on the terrain (lakes from generalised zoom-11 tiles over the region, ponds
 *    and pools from zoom-14 tiles around the glider)
 * swisstopo's 3D Tiles use the same sea-level heights we use for terrain (checked: building
 * bases sit within ~2 m of our ground, trees ~1 m), so no datum shift is applied.
 */
import { LOOK } from "./lighting.ts";
import {
  Cartesian2,
  buildModuleUrl,
  Cartesian3,
  Cesium3DTileset,
  Cesium3DTileStyle,
  ClassificationType,
  Color,
  GeometryInstance,
  GroundPrimitive,
  ImageryLayer,
  Material,
  MaterialAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  ShadowMode,
  type Viewer,
} from "cesium";
import { lonLatToTile } from "@webflight/environment";
import { BASE_VT, fetchWater, type WaterPolygon } from "@webflight/scenery";
import { swissImageProvider } from "./imagery.ts";
import { OsmLayer } from "./osm-layer.ts";

const TLM3D = "https://vectortiles0.geo.admin.ch/3d-tiles/ch.swisstopo.swisstlm3d.3d/20190313/tileset.json";
const VEGETATION = "https://vectortiles0.geo.admin.ch/3d-tiles/ch.swisstopo.vegetation.3d/20190313/tileset.json";

/** Switzerland (+ margin): where the swisstopo layers exist. */
export const inSwitzerland = (latDeg: number, lonDeg: number) => latDeg > 45.7 && latDeg < 47.9 && lonDeg > 5.8 && lonDeg < 10.6;

export interface SceneryOptions {
  buildings: boolean;
  trees: boolean;
  water: boolean;
  shadows: boolean;
  /**
   * Trees' maximum screen-space error: the vegetation set holds every surveyed tree, so a
   * fine value fills the view with tens of thousands of instances (it stalled a software
   * renderer at 8). 24 keeps trees near the glider and thins them with distance.
   */
  treeDetail: number;
  /** Drape SWISSIMAGE on the buildings (photo mode). */
  drape: boolean;
  /** OSM trees elsewhere: spacing [m] and zoom-16 cells around the aircraft. */
  osmTreeSpacingM?: number;
  osmTreeRings?: number;
}

/**
 * Water: over aerial photos a light tint with a soft sun glint (the photo already shows the
 * lake), painted mode a solid lake colour. Waves are broad: a fine normal map tiled thousands
 * of times over a large lake aliases into glitter from altitude.
 */
function waterMaterial(overPhoto: boolean): Material {
  const g = LOOK.ground;
  return Material.fromType("Water", {
    // Unlit material: the time of day comes from LOOK (dark water at night).
    baseWaterColor: overPhoto ? new Color(0.16 * g, 0.3 * g, 0.36 * g, 0.35) : new Color(0.17 * g, 0.33 * g, 0.4 * g, 0.95),
    blendColor: new Color(0.12 * g, 0.28 * g, 0.32 * g, 1.0),
    normalMap: buildModuleUrl("Assets/Textures/waterNormals.jpg"),
    frequency: 1200.0,
    animationSpeed: 0.004,
    amplitude: 1.2,
    specularIntensity: (overPhoto ? 0.25 : 0.4) * g,
    fadeFactor: 1.0,
  });
}

/** OpenFreeMap (OpenStreetMap, OpenMapTiles schema; free, no key): water everywhere. */
const OPENFREEMAP = "https://tiles.openfreemap.org/planet";

async function waterSource(): Promise<{ url: string; global: boolean }> {
  try {
    const r = await fetch(OPENFREEMAP);
    const tj = (await r.json()) as { tiles?: string[] };
    if (tj.tiles?.[0]) return { url: tj.tiles[0], global: true };
  } catch {}
  return { url: BASE_VT, global: false }; // swisstopo: Switzerland only
}

export class Scenery {
  private readonly waterTiles = new Map<string, GroundPrimitive | null>();
  private osm: OsmLayer | undefined;
  private centres: Record<number, string> = {};
  private water: { url: string; global: boolean } | undefined;

  private constructor(
    private readonly viewer: Viewer,
    private readonly o: SceneryOptions,
  ) {}

  /**
   * Start loading around a site once the globe's terrain and imagery have settled (at most
   * `maxWaitMs`): the tilesets would otherwise compete with the ground for requests and CPU.
   * Call update() as the aircraft moves.
   */
  static create(viewer: Viewer, site: { latDeg: number; lonDeg: number }, o: SceneryOptions, maxWaitMs = 20000): Scenery {
    const s = new Scenery(viewer, o);
    const t0 = performance.now();
    const off = viewer.scene.postRender.addEventListener(() => {
      if (!viewer.scene.globe.tilesLoaded && performance.now() - t0 < maxWaitMs) return;
      off();
      s.start(site);
    });
    return s;
  }

  private start(site: { latDeg: number; lonDeg: number }): void {
    const { viewer, o } = this;
    const s = this;
    const shadows = o.shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED;
    // swisstopo's 3D Tiles cover Switzerland; they stream by view wherever we fly there.
    if (o.buildings) {
      void Cesium3DTileset.fromUrl(TLM3D, { maximumScreenSpaceError: 12, shadows, dynamicScreenSpaceError: true, skipLevelOfDetail: true })
        .then((ts) => {
          // Drape the aerial photo over the buildings: roofs take their real colours and
          // walls the colours at their footprint, instead of the tiles' flat pastel materials.
          if (o.drape) ts.imageryLayers.add(new ImageryLayer(swissImageProvider()));
          else ts.style = new Cesium3DTileStyle({ color: "color('#ddd5c9')" });
          ts.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(LOOK.ground, LOOK.ground); // time of day
          viewer.scene.primitives.add(ts);
        })
        .catch((e: unknown) => console.warn("buildings:", e));
    }
    if (o.trees) {
      void Cesium3DTileset.fromUrl(VEGETATION, { maximumScreenSpaceError: o.treeDetail, shadows, dynamicScreenSpaceError: true })
        .then((ts) => {
          ts.style = new Cesium3DTileStyle({ color: "color('#5f7c47')" });
          ts.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(LOOK.ground, LOOK.ground); // time of day
          viewer.scene.primitives.add(ts);
        })
        .catch((e: unknown) => console.warn("trees:", e));
    }
    // Elsewhere: OpenStreetMap buildings and forests, streamed around the aircraft.
    if (o.buildings || o.trees)
      void OsmLayer.create(viewer, {
        buildings: o.buildings,
        trees: o.trees,
        shadows: o.shadows,
        treeSpacingM: o.osmTreeSpacingM ?? 10,
        treeRings: o.osmTreeRings ?? 2,
        covered: inSwitzerland,
      }).then((l) => {
        this.osm = l;
        l?.update(site.latDeg, site.lonDeg);
      });
    if (o.water)
      void waterSource().then((w) => {
        this.water = w;
        this.started = true;
        s.update(site.latDeg, site.lonDeg);
      });
  }

  private started = false;

  private loadWater(z: number, x: number, y: number, kinds: (k: string) => boolean, minAreaM2: number): void {
    const key = `${z}/${x}/${y}`;
    if (this.waterTiles.has(key)) return;
    this.waterTiles.set(key, null);
    void fetchWater(z, x, y, kinds, this.water!.url)
      .then((all) => {
        // Ground-clamped polygons are expensive: a Dutch tile holds thousands of ditches.
        // Keep the bodies big enough to see, largest first, at most 120 per tile.
        const polys = all
          .map((p) => ({ p, a: areaM2(p.rings[0]!) }))
          .filter((e) => e.a >= minAreaM2)
          .sort((a, b) => b.a - a.a)
          .slice(0, 120)
          .map((e) => e.p);
        if (!polys.length || !this.waterTiles.has(key)) return;
        const prim = this.viewer.scene.primitives.add(
          new GroundPrimitive({
            geometryInstances: polys.map((p) => new GeometryInstance({ geometry: new PolygonGeometry({ polygonHierarchy: hierarchy(p), vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }) })),
            appearance: new MaterialAppearance({ material: waterMaterial(this.o.drape), materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, faceForward: true }),
            classificationType: ClassificationType.TERRAIN,
            asynchronous: true,
          }),
        ) as GroundPrimitive;
        this.waterTiles.set(key, prim);
      })
      .catch(() => {});
  }

  /**
   * Stream water around the aircraft: lakes, rivers and sea from generalised zoom-11 tiles
   * (±2 tiles, ~±30 km) and ponds, pools and streams from zoom-14 tiles (±1). Tiles left
   * behind are dropped, so a cross-country flight keeps a constant amount of scenery.
   */
  update(latDeg: number, lonDeg: number): void {
    this.osm?.update(latDeg, lonDeg);
    if (!this.o.water || !this.started || !this.water) return;
    if (!this.water.global && !inSwitzerland(latDeg, lonDeg)) return;
    const ring = (z: number, r: number, keep: number, kinds: (k: string) => boolean, minAreaM2: number) => {
      const [fx, fy] = lonLatToTile(lonDeg, latDeg, z);
      const cx = Math.floor(fx), cy = Math.floor(fy);
      const key = `${cx}/${cy}`;
      if (this.centres[z] === key) return;
      this.centres[z] = key;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.loadWater(z, cx + dx, cy + dy, kinds, minAreaM2);
      for (const [k, prim] of this.waterTiles) {
        const [tz, x, y] = k.split("/").map(Number) as [number, number, number];
        if (tz === z && (Math.abs(x - cx) > keep || Math.abs(y - cy) > keep)) {
          if (prim) this.viewer.scene.primitives.remove(prim);
          this.waterTiles.delete(k);
        }
      }
    };
    const big = (k: string) => k === "lake" || k === "river" || k === "ocean";
    ring(11, 2, 3, big, 20_000);
    ring(14, 1, 3, (k) => !big(k), 1500);
  }
}

/** Area of a closed [lon, lat] ring [m²] (local equirectangular). */
function areaM2(r: [number, number][]): number {
  const k = 111_320 * Math.cos(((r[0]?.[1] ?? 0) * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * k * (r[j]![1] + r[i]![1]) * 111_132;
  return Math.abs(a / 2);
}

function hierarchy(p: WaterPolygon): PolygonHierarchy {
  const ring = (r: [number, number][]) => Cartesian3.fromDegreesArray(r.slice(0, -1).flat());
  return new PolygonHierarchy(ring(p.rings[0]!), p.rings.slice(1).map((h) => new PolygonHierarchy(ring(h))));
}
