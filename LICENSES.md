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
| Poly Haven textures (`apps/web/public/textures/`: leafy_grass, grass_ground, farm_soil, dry_mud_field_001, aerial_mud_1, gravel_road, aerial_asphalt_01; 1K colour maps, re-encoded) | HD detail for grass, soil, tracks, gravel and asphalt | CC0 (polyhaven.com/license) |
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
