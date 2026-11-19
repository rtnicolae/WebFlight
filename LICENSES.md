# Third-party licenses

This repository contains no FlightGear aircraft files. They are downloaded from FGAddon
into the git-ignored `.cache/fgaddon/` (see `pnpm fetch:ask21`). Web bundles built from
them (`apps/web/bundles/`, also git-ignored) include the aircraft's `COPYING`, which is
served and shipped with the bundle.

## Aircraft (FGAddon, https://sourceforge.net/p/flightgear/fgaddon/)

| Aircraft | FGAddon folder | License | Source of license | Authors |
|---|---|---|---|---|
| Schleicher ASK 21 (JSBSim, `ask21-jsb`) | `Aircraft/ASK21` | GPL v2 or later | `COPYING`, `README.md` | Heiko Schulz, Detlef Faber, AJ MacLeod, Thomas Polzer, Viktor Radnai, Bea Wolf, Gilberto Agostinho, Herbert Wagner, Patrice Poly (ASK13 parts), Anders Gidenstam (dual control) |

The ASK 21's outside in the bundle (`packages/converter/src/glider-look.ts`, at bundle time) is derived from its own `Models/Liveries/customcallsign-2.png` (the "Custom Callsign 2" livery of the ASK21 package; its `liveries.txt` calls the custom-callsign liveries not present in real life) and model (GPL v2 or later, like the bundle), with the package's own registration letters (`Models/Immat`, `Nasal/immat.nas` by Zakharov) showing a fictional registration, YR-FLY: the texture enlarged to 4096² (Lanczos), a little bug spatter and belly grime drawn in, ambient occlusion baked by ray casting against the model, roughness and a clearcoat mask from the colours. Nothing from other sources.

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
| Bing Maps aerial imagery via Cesium ion (`api.cesium.com` asset 2; tiles from `*.virtualearth.net`) | aerial photos on the globe (`?world=globe`, and as the fallback when the Google 3D tiles can't be had; `?aerial=s2` for the free layers below) | Cesium ion Terms of Service and the Bing Maps terms Cesium ion passes on; needs a Cesium ion access token (`VITE_CESIUM_ION_TOKEN` in `apps/web/.env.local`; without one, Cesium's evaluation token, which is not meant for production). Attribution (Bing logo, data providers) is shown by Cesium in the credits. Besides the globe, the app reads photo tiles itself: `photo-align-worker.ts` reads 36 zoom-18 tiles per zoom-14 OSM tile (~1.7 km, once a month per browser) to line OSM buildings up with the photo, and the OSM roofs take their colours from the photo: 16 zoom-16 tiles per zoom-14 tile round the glider, 4 zoom-15 tiles per tile for distant towns (to ±3 tiles), 1 zoom-14 tile per tile for the skyline (to ±6). Checked 2026-11-17 (cesium.com pricing page and Content Usage and Attribution Guide): Bing use is metered in sessions, not tiles (the pages don't define a session; forum posts say each page load is one); Community (free, personal and non-commercial) has 1,000 Global Imagery sessions a month, Commercial 5,000, Premium 10,000; Bing assets may be used "only to access and display maps", and may not be combined with non-Bing maps or imagery (whether OSM buildings count is not said; Cesium's own OSM Buildings demos use Bing); deriving data from the imagery (the roof colours, the alignment offsets) is not addressed there — read the Bing third-party terms (cesium.com/legal/terms-for-bing) before deploying; Cesium ion promised Bing "at least through September 2026", it still served tiles on 2026-11-17. Automated test runs each use a session |
| Esri World Imagery (`ibasemaps-api.arcgis.com`, `World_Imagery/MapServer`; Maxar Vivid round Brașov, 2024–25, ~0.3 m) | aerial photos with `?aerial=esri` (a comparison switch, not the default) | ArcGIS Location Platform terms: an ArcGIS account and access token are required (`VITE_ARCGIS_KEY`; without one, Cesium's default ArcGIS key, an evaluation key that shows an on-screen notice). Attribution: "Powered by Esri" and the data providers (Cesium shows the service's credits). Free allowance checked 2026-11-17 on location.arcgis.com/pricing: 2M basemap tiles a month, then $0.15 per 1,000 (or 1,000 basemap sessions, then $4 per 1,000). Like Bing, the app reads these tiles' pixels for roof and grass colours and the OSM alignment; Esri's terms on deriving data from basemap imagery were not read (they are in PDFs linked from developers.arcgis.com/documentation/terms-of-use) |
| Google Map Tiles API via Cesium ion (asset 2275207, Photorealistic 3D Tiles from `tile.googleapis.com`; asset 3830182, 2D satellite) | the scenery by default (3D tiles in place of the globe, our buildings and trees; `?world=globe` for the globe), `?aerial=google` (2D satellite on the globe) | Cesium's Terms for Google and Google's Map Tiles API policies (read 2026-11-17): display only, no "non-visualization use cases" such as image analysis, so the app reads no tile pixels from Google (with the 3D tiles: no photo alignment, roof or grass colours from them; with the 2D layer, roofs keep palette colours); no caching except as Google's terms allow (the service worker does not cache these hosts); no deriving content (tracing, 3D models); Google's attributions shown in full and unchanged (Cesium's credits); "No Use with Non-Google Maps" (Cesium's Terms for Google, Schedule I 3(e): not "with or near a non-Google map"; its examples are Places content on another map, Street View beside another map, links to other maps: no other map is shown with the tiles here). Google's tile policies allow "your own 3D objects" over Photorealistic 3D Tiles as long as they are not derived from them: our grass (placed from OpenStreetMap land use, coloured from Sentinel-2), glider, tow plane, clouds and HUD are ours. In such hybrid scenes the UI must say which parts come from Google (Cesium's credits show Google's logo and data credits; the menu credits the scenery to Google); "High Risk Activities" in Cesium's terms names aviation (this is a game, not navigation). For display the tiles are lowered onto our terrain heights, tinted by the time of day, given a colour grade (greener vegetation, the blue-magenta cast over fields reduced) and, near the camera, the same ground grain as our photo ground (`google3d.ts`): drawing changes, the tiles themselves are not stored or altered. Cesium licenses Google's content and passes the app its own Google key (the ion endpoint returns `tile.googleapis.com` with a key), so ion meters it: the 3D tiles in root tiles (one per session of up to 3 hours, so about one per page load; Community 1,000 a month, Commercial 5,000, Premium 10,000; checked 2026-11-17 on cesium.com/platform/cesium-ion/pricing), separate from the Global Imagery sessions that the 2D satellite layer shares with Bing. Cesium's terms bar using the content "in a manner intended to avoid incurring fees". Google's own prices for a project's own key were not found on its billing page (it links to a price list) |
| swisstopo SWISSIMAGE (`wmts.geo.admin.ch`) | aerial photos over Switzerland | Free geodata (OGD) of the Swiss Confederation; attribution "© swisstopo" (shown in the credits) |
| EOX Sentinel-2 cloudless 2016 (`tiles.maps.eox.at`, layer `s2cloudless_3857`) | imagery elsewhere, the title screen's backdrop before the first flight, the 3D grass's colours with Google 3D | CC BY 4.0: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)". Later years are CC BY-NC-SA, so the 2016 layer is used deliberately |
| swisstopo swissTLM3D 3D Tiles, vegetation 3D Tiles, base vector tiles (`vectortiles*.geo.admin.ch`) | buildings, trees, water, the Grenchen runway geometry | Free geodata (OGD) of the Swiss Confederation; attribution "© swisstopo" |
| IGN Géoplateforme orthophotos (`data.geopf.fr`) | aerial photos in France | Licence Ouverte / Open Licence 2.0 (Etalab); attribution "© IGN" |
| basemap.at orthofoto (`mapsneu.wien.gv.at`) | aerial photos in Austria | CC BY 4.0, "basemap.at" |
| IGN España PNOA (`www.ign.es`, WMTS `pnoa-ma`) | aerial photos in Spain | CC BY 4.0, "PNOA © IGN España (scne.es)" (stated in the service's AccessConstraints) |
| GUGiK Geoportal ortofotomapa (`mapy.geoportal.gov.pl`) | aerial photos in Poland | free, no access constraints ("brak ograniczeń"); use implies the Geoportal terms (geoportal.gov.pl); attribution "© GUGiK" |
| ČÚZK Ortofoto (`ags.cuzk.cz`, `ORTOFOTO_WM`) | aerial photos in Czechia | ČÚZK open data; attribution "© ČÚZK" (the service's copyright text) |
| PDOK Luchtfoto RGB (`service.pdok.nl`, `Actueel_orthoHR`) | aerial photos in the Netherlands | no fees, no access constraints (service metadata); attribution "© Beeldmateriaal Nederland (PDOK)" |
| Digitaal Vlaanderen orthophotos (`geo.api.vlaanderen.be`, `OMWRGBMRVL`) | aerial photos in Flanders | free of charge, under Digitaal Vlaanderen's terms for its geographic web services; attribution "© Digitaal Vlaanderen" |
| OpenFreeMap (`tiles.openfreemap.org`, OpenMapTiles schema) | water, buildings, forests (trees), runway centrelines everywhere | Data © OpenStreetMap contributors (ODbL); tiles © OpenMapTiles (CC BY 4.0) |
| JRC Global Surface Water 1984–2021, occurrence map tiles (`storage.googleapis.com/global-surface-water/tiles2021/occurrence/`) | where our water is drawn on Google's 3D tiles (`water.ts`): lakes, reservoirs, rivers | Copernicus Programme data, free to use with acknowledgement (Earth Engine catalog, JRC_GSW1_4). Attribution shown in the credits: "Water: EC JRC/Google Global Surface Water"; citation: Pekel, Cottam, Gorelick, Belward, "High-resolution mapping of global surface water and its long-term changes", Nature 540, 418–422 (2016). The tile bucket's own terms were not found; the pixels are read (occurrence) to place the water |
| OurAirports (`packages/environment/data/airfields/`, from github.com/davidmegginson/ourairports-data) | European airfields and runways: designators, length, width, surface and its material (for drawing the runways) | Public domain (The Unlicense) |
| Open-Meteo forecast and historical APIs (`api.open-meteo.com`, `archive-api.open-meteo.com`), fetched live | the weather of the chosen hour | Free API, no key; data CC BY 4.0, attribution "Weather data by Open-Meteo.com" |
| earcut (npm, already a Cesium dependency) | roof triangulation | ISC |
| Poly Haven textures painted_plaster_wall, roof_09, bitumen, gravel_road (`apps/web/public/buildings/`, 512 px, normalized to mid-grey as detail maps), red_brick_03 (`brick.jpg`, 512 px, own colours) | building walls and roofs | CC0 (polyhaven.com/license) |
| Poly Haven tree models (tree_small_02, island_tree_02, island_tree_01, jacaranda_tree, fir_tree_01, fir_sapling_medium, pine_tree_01), rendered offline into `apps/web/public/trees/atlas.png` by `tools/tree-atlas/pack.py` (side and top impostor views; the beech-, oak-, hornbeam-, birch- and lime-like crowns are composed there from the small models' foliage; the models are not in the repository) | tree impostors | CC0 (polyhaven.com/license) |
| Poly Haven textures (`apps/web/public/textures/`: leafy_grass, grass_ground, farm_soil, dry_mud_field_001, aerial_mud_1, gravel_road, aerial_asphalt_01; 1K colour maps and 512 px height maps `*_h.jpg`, re-encoded) | HD detail for grass, soil, tracks, gravel and asphalt; the brightness of leafy_grass, grass_ground and farm_soil is also the close-range ground texture over the aerial photos (`ground-detail.ts`), aerial_asphalt_01's the grain of the runways painted on Google's tiles (`runway-paint.ts`) | CC0 (polyhaven.com/license) |
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
| `packages/environment/src/weather.ts` (`windLevels`: wind levels above the ground near the surface, above sea level aloft, the 500 ft boundary transition) | FlightGear `src/Environment/environment_ctrl.cxx`, FGData `Environment/environment.xml` |

Physics used without porting code: the logarithmic surface-layer wind profile with WMO's
standard roughness for open terrain, z0 = 0.03 m (WMO-No. 8, *Guide to Instruments and Methods
of Observation*), for the wind below 10 m; a thermal column's drift as its air is carried by
the wind while it rises (`columnDrift`).
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

## Published techniques (our own code, no third-party code or data)

| Where | After |
|---|---|
| `apps/web/src/atmosphere.ts` (sky, haze, sun) | S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020; E. Bruneton's transmittance parametrisation |
| `apps/web/src/vclouds.ts`, `cloud-noise.ts` (volumetric cumulus) | A. Schneider, "The Real-time Volumetric Cloudscapes of Horizon: Zero Dawn", SIGGRAPH 2015 (Perlin–Worley shape and Worley detail noise); M. Wrenninge et al., "Oz: The Great and Volumetric", SIGGRAPH 2013 (multiple-scattering octaves); S. Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite", SIGGRAPH 2016 (energy-conserving integration) |
| `apps/web/src/hdr.ts` (tonemap) | Khronos PBR Neutral tone mapper (without its toe) |
| `apps/web/src/taa.ts` (temporal anti-aliasing) | B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014 (Halton jitter, reprojection, YCoCg neighbourhood clamping, Catmull-Rom history); M. Salvi, "An Excursion in Temporal Supersampling", GDC 2016 (variance clipping); closest-depth motion as in most TAA since; AMD FidelityFX CAS (the sharpening after it, `scene.ts`) |
| `apps/web/src/runway-paint.ts` (runway markings) | ICAO Annex 14, Volume I, chapter 5 (runway designation, threshold, centreline, aiming point, touchdown zone and side stripe markings: sizes and positions from the runway's length and width) |
