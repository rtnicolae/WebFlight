# WebFlight

Browser glider simulator flying FlightGear (FGAddon) gliders on JSBSim compiled to
WebAssembly. The same flight model core runs headless in Node for training.

## Layout

| Package | Role |
|---|---|
| `packages/fdm-core` | Host-independent JSBSim WASM wrapper (`Fdm`), verified property names, steady-glide trim. No browser or Node APIs. |
| `packages/converter` | FGAddon and FGData fetchers, FlightGear PropertyList reader, JSBSim file set, AC3D→glTF, animation manifest, host config, web bundle. |
| `packages/fg-host` | FlightGear host layer next to the FDM: property tree (`/fdm/jsbsim` mounted), FDM interface, property rules, FG instruments, Nasal rewritten in TS, cockpit bindings. No browser or Node APIs. |
| `apps/headless` | Node experiments: glide run, speed polar, PNG plot. Later the gym API. |
| `apps/web` | Browser app: FDM worker (120 Hz), Cesium scene, animated model, chase/cockpit camera, gamepad, HUD. |

## Quick start

```sh
pnpm install
pnpm fetch:ask21   # downloads Aircraft/ASK21 (~58 MB) into .cache/fgaddon (tests do this too)
pnpm test          # includes the timed 120 s headless glide
pnpm glide         # out/ask21-solo-glide.csv + summary
pnpm polar         # out/ask21-solo-polar.csv + out/ask21-solo-polar.png
pnpm bundle:ask21  # web bundle → apps/web/bundles/ASK21
pnpm dev           # browser sim at http://localhost:5173
```

The FGAddon cache location can be overridden with `WEBFLIGHT_FGADDON_CACHE`.

See `docs/glider-inventory.md` for the gliders available, `docs/milestone-1.md`,
`docs/milestone-2.md` and `docs/milestone-3.md` for results and findings, and `LICENSES.md`
for licensing.
