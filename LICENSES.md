# Third-party licenses

This repository contains no FlightGear aircraft files. They are downloaded from FGAddon
into the git-ignored `.cache/fgaddon/` (see `pnpm fetch:ask21`). Any bundle built from
them (Milestone 2 and later) must carry the aircraft's license alongside it.

## Aircraft (FGAddon, https://sourceforge.net/p/flightgear/fgaddon/)

| Aircraft | FGAddon folder | License | Source of license | Authors |
|---|---|---|---|---|
| Schleicher ASK 21 (JSBSim, `ask21-jsb`) | `Aircraft/ASK21` | GPL v2 or later | `COPYING`, `README.md` | Heiko Schulz, Detlef Faber, AJ MacLeod, Thomas Polzer, Viktor Radnai, Bea Wolf, Gilberto Agostinho, Herbert Wagner, Patrice Poly (ASK13 parts), Anders Gidenstam (dual control) |

Check each new aircraft's `COPYING` before adding it to this table.

## Software

| Component | License | Notes |
|---|---|---|
| JSBSim 1.2.4 (inside `@0x62/jsbsim-wasm`) | LGPL-2.1 | WebAssembly build, loaded at runtime |
| `@0x62/jsbsim-wasm` SDK | MIT | npm dependency of `packages/fdm-core` |
| `fast-xml-parser` | MIT | npm dependency of `packages/converter` |
