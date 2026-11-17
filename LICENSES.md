# Third-party licenses

This repository contains no FlightGear aircraft files. They are downloaded from FGAddon
into the git-ignored `.cache/fgaddon/` (see `pnpm fetch:ask21`). Web bundles built from
them (`apps/web/bundles/`, also git-ignored) include the aircraft's `COPYING`, which is
served and shipped with the bundle.

## Aircraft (FGAddon, https://sourceforge.net/p/flightgear/fgaddon/)

| Aircraft | FGAddon folder | License | Source of license | Authors |
|---|---|---|---|---|
| Schleicher ASK 21 (JSBSim, `ask21-jsb`) | `Aircraft/ASK21` | GPL v2 or later | `COPYING`, `README.md` | Heiko Schulz, Detlef Faber, AJ MacLeod, Thomas Polzer, Viktor Radnai, Bea Wolf, Gilberto Agostinho, Herbert Wagner, Patrice Poly (ASK13 parts), Anders Gidenstam (dual control) |

Check each new aircraft's `COPYING` before adding it to this table.

## FGData (https://gitlab.com/flightgear/fgdata, branch `next`)

Shared files an aircraft references (e.g. `Aircraft/Instruments-3d/glider/vario/ilec-sc7`,
`Aircraft/Generic/...`) are fetched on demand into the git-ignored `.cache/fgdata/` and end up
in that aircraft's bundle. FGData is GPL-2.0-or-later; the bundle's `COPYING` (GPL) covers them.

Standalone FGData models are converted the same way into `apps/web/bundles/_models/` (also
git-ignored): the AI tow plane `AI/Aircraft/DR400/Models/dr400-ai.xml` (with its light
submodels) and the winch `Models/Airport/supacat_winch.xml`, both GPL-2.0-or-later as part of
FGData.

## Imagery

Fetched at runtime by the browser, never stored in the repository:

| Source | Use | License / terms |
|---|---|---|
| Bing Maps aerial imagery via Cesium ion (`api.cesium.com` asset 2; tiles from `*.virtualearth.net`) | aerial photos on the globe (`?world=globe`, and as the fallback when the Google 3D tiles can't be had; `?aerial=s2` for the free layers below) | Cesium ion Terms of Service and the Bing Maps terms Cesium ion passes on; needs a Cesium ion access token (`VITE_CESIUM_ION_TOKEN` in `apps/web/.env.local`; without one, Cesium's evaluation token, which is not meant for production). Attribution (Bing logo, data providers) is shown by Cesium in the credits. Besides the globe, the app reads photo tiles itself: the 3D grass takes its colours from zoom-17 tiles, and `photo-align-worker.ts` reads 36 zoom-18 tiles per zoom-14 OSM tile (~1.7 km, once a month per browser) to line OSM buildings up with the photo, and the OSM roofs take their colours from the photo: 16 zoom-16 tiles per zoom-14 tile round the glider, 4 zoom-15 tiles per tile for distant towns (to ±3 tiles), 1 zoom-14 tile per tile for the skyline (to ±6). Checked 2026-11-17 (cesium.com pricing page and Content Usage and Attribution Guide): Bing use is metered in sessions, not tiles (the pages don't define a session; forum posts say each page load is one); Community (free, personal and non-commercial) has 1,000 Global Imagery sessions a month, Commercial 5,000, Premium 10,000; Bing assets may be used "only to access and display maps", and may not be combined with non-Bing maps or imagery (whether OSM buildings count is not said; Cesium's own OSM Buildings demos use Bing); deriving data from the imagery (the roof colours, the alignment offsets) is not addressed there — read the Bing third-party terms (cesium.com/legal/terms-for-bing) before deploying; Cesium ion promised Bing "at least through September 2026", it still served tiles on 2026-11-17. Automated test runs each use a session |
| Esri World Imagery (`ibasemaps-api.arcgis.com`, `World_Imagery/MapServer`; Maxar Vivid round Brașov, 2024–25, ~0.3 m) | aerial photos with `?aerial=esri` (a comparison switch, not the default) | ArcGIS Location Platform terms: an ArcGIS account and access token are required (`VITE_ARCGIS_KEY`; without one, Cesium's default ArcGIS key, an evaluation key that shows an on-screen notice). Attribution: "Powered by Esri" and the data providers (Cesium shows the service's credits). Free allowance checked 2026-11-17 on location.arcgis.com/pricing: 2M basemap tiles a month, then $0.15 per 1,000 (or 1,000 basemap sessions, then $4 per 1,000). Like Bing, the app reads these tiles' pixels for roof and grass colours and the OSM alignment; Esri's terms on deriving data from basemap imagery were not read (they are in PDFs linked from developers.arcgis.com/documentation/terms-of-use) |
| Google Map Tiles API via Cesium ion (asset 2275207, Photorealistic 3D Tiles from `tile.googleapis.com`; asset 3830182, 2D satellite) | the scenery by default (3D tiles in place of the globe, our buildings and trees; `?world=globe` for the globe), `?aerial=google` (2D satellite on the globe) | Cesium's Terms for Google and Google's Map Tiles API policies (read 2026-11-17): display only, no "non-visualization use cases" such as image analysis, so the app reads no tile pixels from Google (with the 3D tiles: no photo alignment, roof or grass colours from them; with the 2D layer, roofs keep palette colours); no caching except as Google's terms allow (the service worker does not cache these hosts); no deriving content (tracing, 3D models); Google's attributions shown in full and unchanged (Cesium's credits); "No Use with Non-Google Maps" (our own 3D grass, glider, tow plane, clouds and HUD are drawn over the tiles; Cesium's terms allow 3D overlays that are not derived from the tiles); "High Risk Activities" in Cesium's terms names aviation (this is a game, not navigation). For display the tiles are lowered onto our terrain heights, tinted by the time of day, given a colour grade (greener vegetation, the blue-magenta cast over fields reduced) and, near the camera, the same ground grain as our photo ground (`google3d.ts`): drawing changes, the tiles themselves are not stored or altered. Metered by Cesium ion as Global Imagery sessions (with Bing; 1,000 a month on the free plan). Google's own direct prices were not checked |
| swisstopo SWISSIMAGE (`wmts.geo.admin.ch`) | aerial photos over Switzerland | Free geodata (OGD) of the Swiss Confederation; attribution "© swisstopo" (shown in the credits) |
| EOX Sentinel-2 cloudless 2016 (`tiles.maps.eox.at`, layer `s2cloudless_3857`) | imagery elsewhere | CC BY 4.0: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)". Later years are CC BY-NC-SA, so the 2016 layer is used deliberately |
| swisstopo swissTLM3D 3D Tiles, vegetation 3D Tiles, base vector tiles (`vectortiles*.geo.admin.ch`) | buildings, trees, water, the Grenchen runway geometry | Free geodata (OGD) of the Swiss Confederation; attribution "© swisstopo" |
| IGN Géoplateforme orthophotos (`data.geopf.fr`) | aerial photos in France | Licence Ouverte / Open Licence 2.0 (Etalab); attribution "© IGN" |
| basemap.at orthofoto (`mapsneu.wien.gv.at`) | aerial photos in Austria | CC BY 4.0, "basemap.at" |
| IGN España PNOA (`www.ign.es`, WMTS `pnoa-ma`) | aerial photos in Spain | CC BY 4.0, "PNOA © IGN España (scne.es)" (stated in the service's AccessConstraints) |
| GUGiK Geoportal ortofotomapa (`mapy.geoportal.gov.pl`) | aerial photos in Poland | free, no access constraints ("brak ograniczeń"); use implies the Geoportal terms (geoportal.gov.pl); attribution "© GUGiK" |
| ČÚZK Ortofoto (`ags.cuzk.cz`, `ORTOFOTO_WM`) | aerial photos in Czechia | ČÚZK open data; attribution "© ČÚZK" (the service's copyright text) |
| PDOK Luchtfoto RGB (`service.pdok.nl`, `Actueel_orthoHR`) | aerial photos in the Netherlands | no fees, no access constraints (service metadata); attribution "© Beeldmateriaal Nederland (PDOK)" |
| Digitaal Vlaanderen orthophotos (`geo.api.vlaanderen.be`, `OMWRGBMRVL`) | aerial photos in Flanders | free of charge, under Digitaal Vlaanderen's terms for its geographic web services; attribution "© Digitaal Vlaanderen" |
| OpenFreeMap (`tiles.openfreemap.org`, OpenMapTiles schema) | water, buildings, forests (trees), runway centrelines everywhere | Data © OpenStreetMap contributors (ODbL); tiles © OpenMapTiles (CC BY 4.0) |
| OurAirports (`packages/environment/data/airfields-eu.json`, from github.com/davidmegginson/ourairports-data) | European airfields and runways | Public domain (The Unlicense) |
| Open-Meteo forecast and historical APIs (`api.open-meteo.com`, `archive-api.open-meteo.com`), fetched live | the weather of the chosen hour | Free API, no key; data CC BY 4.0, attribution "Weather data by Open-Meteo.com" |
| earcut (npm, already a Cesium dependency) | roof triangulation | ISC |
| Poly Haven textures painted_plaster_wall, roof_09, bitumen, gravel_road (`apps/web/public/buildings/`, 512 px, normalized to mid-grey as detail maps), red_brick_03 (`brick.jpg`, 512 px, own colours) | building walls and roofs | CC0 (polyhaven.com/license) |
| Poly Haven tree models (tree_small_02, island_tree_02, island_tree_01, jacaranda_tree, fir_tree_01, fir_sapling_medium, pine_tree_01), rendered offline into `apps/web/public/trees/atlas.png` by `tools/tree-atlas/pack.py` (side and top impostor views; the beech-, oak-, hornbeam-, birch- and lime-like crowns are composed there from the small models' foliage; the models are not in the repository) | tree impostors | CC0 (polyhaven.com/license) |
| Poly Haven textures (`apps/web/public/textures/`: leafy_grass, grass_ground, farm_soil, dry_mud_field_001, aerial_mud_1, gravel_road, aerial_asphalt_01; 1K colour maps and 512 px height maps `*_h.jpg`, re-encoded) | HD detail for grass, soil, tracks, gravel and asphalt; the brightness of leafy_grass, grass_ground and farm_soil is also the close-range ground texture over the aerial photos (`ground-detail.ts`) | CC0 (polyhaven.com/license) |
| Painted terrain | fallback when the photo servers can't be reached | generated in the browser from Terrarium heights (no third-party imagery) |

## Code ported from FlightGear (GPL-2.0-or-later)

Several modules are TypeScript ports of FlightGear code and are therefore derivative works
of GPL-2.0-or-later sources. This repository has no license file of its own yet; whatever
is chosen must be compatible with these:

| Module | Ported from |
|---|---|
| `packages/fg-host/src/rules.ts`, `instruments.ts`, `expr.ts` | FlightGear `src/Autopilot`, `src/Instrumentation`, SimGear `props/condition.cxx`, `structure/SGExpression.cxx`, `inputvalue.cxx` |
| `packages/fg-host/src/nasal/ask21.ts` | ASK21 `Nasal/*.nas` (FGAddon) |
| `packages/environment/src/ridge.ts`, `thermals.ts` | FlightGear `src/Environment/ridge_lift.cxx`, `src/AIModel/AIThermal.cxx`, `AIManager.cxx` |
| `packages/launch/src/winch.ts`, `aerotow.ts` | FGData `Nasal/towing/hitch.nas` (D-NXKT, Bea Wolf) |
| `packages/launch/src/tug.ts` | ASK21 `Nasal/dragrobot.nas` (Klaus Kerner, Bea Wolf) |

## Terrain data

Elevation comes from the AWS Terrain Tiles open dataset (Terrarium encoding, originally by
Mapzen), fetched at runtime and cached only in the git-ignored `.cache/terrain/` for headless
runs; none of it is redistributed. Attribution required by the dataset: "Terrain Tiles,
© Mapzen and others", with sources SRTM (public domain, NASA/USGS), GMTED2010 (USGS),
ETOPO1 (NOAA), and others listed at https://github.com/tilezen/joerd/blob/master/docs/attribution.md.
The browser shows this credit in the Cesium credit line.

## Software

| Component | License | Notes |
|---|---|---|
| JSBSim 1.2.4 (inside `@0x62/jsbsim-wasm`) | LGPL-2.1 | WebAssembly build, loaded at runtime |
| `@0x62/jsbsim-wasm` SDK | MIT | npm dependency of `packages/fdm-core` |
| `fast-xml-parser` | MIT | npm dependency of `packages/converter` |
| CesiumJS 1.147 | Apache-2.0 | npm dependency of `apps/web` |
| Vite | MIT | dev dependency of `apps/web` |
