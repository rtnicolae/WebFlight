/*
 * Disk cache for everything the sim downloads that does not change: map, terrain and photo
 * tiles from the tile servers, and the app's own heavy static files (aircraft, textures,
 * trees, CesiumJS assets, the flight model, airfield data). Cache first: once a tile has been
 * fetched it comes from disk, on this visit and the next, also offline.
 *
 * Not cached: the page and its scripts (so a new deploy is picked up), weather (changes), and
 * anything that is not a successful GET.
 */
const VERSION = "v1";
const TILES = `webflight-tiles-${VERSION}`;
const STATIC = `webflight-static-${VERSION}`;
/** Tile servers whose URLs name immutable content (a tile, a dated planet build, a fixed mosaic). */
const TILE_HOSTS = [
  "tiles.maps.eox.at", "tiles.openfreemap.org", "s3.amazonaws.com", "elevation-tiles-prod.s3.amazonaws.com",
  "www.ign.es", "data.geopf.fr", "mapy.geoportal.gov.pl", "ags.cuzk.cz", "service.pdok.nl",
  "geo.api.vlaanderen.be", "mapsneu.wien.gv.at", "wmts.geo.admin.ch", "vectortiles.geo.admin.ch",
  "vectortiles0.geo.admin.ch", "vectortiles1.geo.admin.ch", "3d.geo.admin.ch", "geoportal.ancpi.ro",
];
/** Same-origin static paths (relative to the app's base) worth keeping. */
const STATIC_DIRS = ["bundles/", "textures/", "buildings/", "trees/", "cesium/Assets/", "cesium/Workers/", "cesium/ThirdParty/", "jsbsim/", "data/"];
/** Rough cap on cached tiles; the oldest are dropped beyond it. */
const MAX_TILES = 60000;
const base = new URL(self.registration.scope).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("webflight-") && !k.startsWith("webflight-detail-") && k !== TILES && k !== STATIC) await caches.delete(k);
    await self.clients.claim();
  })());
});

function bucket(url) {
  if (TILE_HOSTS.includes(url.hostname) && !url.pathname.endsWith("/planet")) return TILES;
  if (url.origin === self.location.origin && url.pathname.startsWith(base)) {
    const rel = url.pathname.slice(base.length);
    if (STATIC_DIRS.some((d) => rel.startsWith(d))) return STATIC;
  }
  return undefined;
}

let stored = 0;
async function trim() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  const name = bucket(url);
  if (!name) return;
  e.respondWith((async () => {
    const cache = await caches.open(name);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && (res.type === "basic" || res.type === "cors")) {
      e.waitUntil(cache.put(req, res.clone()).then(() => (++stored % 500 === 0 && name === TILES ? trim() : undefined)).catch(() => {}));
    }
    return res;
  })());
});
