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
