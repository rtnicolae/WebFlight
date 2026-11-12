# WebFlight

Browser glider simulator flying FlightGear (FGAddon) gliders on JSBSim compiled to
WebAssembly. The same flight model core runs headless in Node for training.

## Layout

| Package | Role |
|---|---|
| `packages/fdm-core` | Host-independent JSBSim WASM wrapper (`Fdm`), verified property names, steady-glide trim. No browser or Node APIs. |
| `packages/converter` | FGAddon fetcher, FlightGear PropertyList reader, JSBSim file-set extraction (glTF and animation manifest come in Milestone 2). |
| `apps/headless` | Node experiments: glide run, speed polar, PNG plot. Later the gym API. |
| `apps/web` | Browser app (Milestone 2). |

## Quick start

```sh
pnpm install
pnpm fetch:ask21   # downloads Aircraft/ASK21 (~58 MB) into .cache/fgaddon (tests do this too)
pnpm test          # includes the timed 120 s headless glide
pnpm glide         # out/ask21-solo-glide.csv + summary
pnpm polar         # out/ask21-solo-polar.csv + out/ask21-solo-polar.png
```

The FGAddon cache location can be overridden with `WEBFLIGHT_FGADDON_CACHE`.

See `docs/glider-inventory.md` for the gliders available, `docs/milestone-1.md` for the
physics proof notes, and `LICENSES.md` for licensing.
