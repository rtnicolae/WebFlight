/**
 * 3D scenery over Switzerland from swisstopo open data (no key):
 *  - buildings: swissTLM3D buildings as 3D Tiles (real roof shapes)
 *  - trees: swisstopo vegetation 3D Tiles (instanced tree models at surveyed positions)
 *  - water: lakes and rivers from the base vector tiles, drawn with an animated water
 *    material on the terrain (lakes from generalised zoom-11 tiles over the region, ponds
 *    and pools from zoom-14 tiles around the glider)
 * swisstopo's 3D Tiles use the same sea-level heights we use for terrain (checked: building
 * bases sit within ~2 m of our ground, trees ~1 m), so no datum shift is applied.
 */
import {
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
import { fetchWater, type WaterPolygon } from "@webflight/scenery";
import { swissImageProvider } from "./imagery.ts";

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
}

/**
 * Water: over aerial photos a light tint with a soft sun glint (the photo already shows the
 * lake), painted mode a solid lake colour. Waves are broad: a fine normal map tiled thousands
 * of times over a large lake aliases into glitter from altitude.
 */
function waterMaterial(overPhoto: boolean): Material {
  return Material.fromType("Water", {
    baseWaterColor: overPhoto ? new Color(0.16, 0.3, 0.36, 0.35) : new Color(0.17, 0.33, 0.4, 0.95),
    blendColor: new Color(0.12, 0.28, 0.32, 1.0),
    normalMap: buildModuleUrl("Assets/Textures/waterNormals.jpg"),
    frequency: 1200.0,
    animationSpeed: 0.004,
    amplitude: 1.2,
    specularIntensity: overPhoto ? 0.25 : 0.4,
    fadeFactor: 1.0,
  });
}

export class Scenery {
  private readonly waterTiles = new Map<string, GroundPrimitive | null>();
  private nearCentre: [number, number] | undefined;

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
    if (!inSwitzerland(site.latDeg, site.lonDeg)) return s;
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
    if (o.buildings) {
      void Cesium3DTileset.fromUrl(TLM3D, { maximumScreenSpaceError: 12, shadows, dynamicScreenSpaceError: true, skipLevelOfDetail: true })
        .then((ts) => {
          // Drape the aerial photo over the buildings: roofs take their real colours and
          // walls the colours at their footprint, instead of the tiles' flat pastel materials.
          if (o.drape) ts.imageryLayers.add(new ImageryLayer(swissImageProvider()));
          else ts.style = new Cesium3DTileStyle({ color: "color('#ddd5c9')" });
          viewer.scene.primitives.add(ts);
        })
        .catch((e: unknown) => console.warn("buildings:", e));
    }
    if (o.trees) {
      void Cesium3DTileset.fromUrl(VEGETATION, { maximumScreenSpaceError: o.treeDetail, shadows, dynamicScreenSpaceError: true })
        .then((ts) => {
          ts.style = new Cesium3DTileStyle({ color: "color('#5f7c47')" });
          viewer.scene.primitives.add(ts);
        })
        .catch((e: unknown) => console.warn("trees:", e));
    }
    if (o.water) {
      // Lakes and large rivers over the region (generalised zoom 11, ~±30 km).
      const [fx, fy] = lonLatToTile(site.lonDeg, site.latDeg, 11);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) s.loadWater(11, Math.floor(fx) + dx, Math.floor(fy) + dy, (k) => k === "lake" || k === "river");
      this.started = true;
      s.update(site.latDeg, site.lonDeg);
    }
  }

  private started = false;

  private loadWater(z: number, x: number, y: number, kinds: (k: string) => boolean): void {
    const key = `${z}/${x}/${y}`;
    if (this.waterTiles.has(key)) return;
    this.waterTiles.set(key, null);
    void fetchWater(z, x, y, kinds)
      .then((polys) => {
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

  /** Stream small water bodies (ponds, pools, streams) around the aircraft. */
  update(latDeg: number, lonDeg: number): void {
    if (!this.o.water || !this.started || !inSwitzerland(latDeg, lonDeg)) return;
    const [fx, fy] = lonLatToTile(lonDeg, latDeg, 14);
    const c: [number, number] = [Math.floor(fx), Math.floor(fy)];
    if (this.nearCentre && this.nearCentre[0] === c[0] && this.nearCentre[1] === c[1]) return;
    this.nearCentre = c;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.loadWater(14, c[0] + dx, c[1] + dy, (k) => k !== "lake" && k !== "river");
    // Drop near tiles that are far behind.
    for (const [key, prim] of this.waterTiles) {
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      if (z === 14 && (Math.abs(x - c[0]) > 3 || Math.abs(y - c[1]) > 3)) {
        if (prim) this.viewer.scene.primitives.remove(prim);
        this.waterTiles.delete(key);
      }
    }
  }
}

function hierarchy(p: WaterPolygon): PolygonHierarchy {
  const ring = (r: [number, number][]) => Cartesian3.fromDegreesArray(r.slice(0, -1).flat());
  return new PolygonHierarchy(ring(p.rings[0]!), p.rings.slice(1).map((h) => new PolygonHierarchy(ring(h))));
}
