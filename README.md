# WebFlight

Browser glider simulator flying FlightGear (FGAddon) gliders on JSBSim compiled to
WebAssembly. The same flight model core runs headless in Node for training.

## Layout

| Package | Role |
|---|---|
| `packages/fdm-core` | Host-independent JSBSim WASM wrapper (`Fdm`), verified property names, steady-glide trim. No browser or Node APIs. |
| `packages/converter` | FGAddon and FGData fetchers, FlightGear PropertyList reader, JSBSim file set, AC3D→glTF, animation manifest, host config, web bundle. |
| `packages/fg-host` | FlightGear host layer next to the FDM: property tree (`/fdm/jsbsim` mounted), FDM interface, property rules, FG instruments, Nasal rewritten in TS, cockpit bindings. No browser or Node APIs. |
| `packages/environment` | Terrarium terrain heights, FlightGear ridge lift and thermals (ported), seeded thermal field, sites. No browser or Node APIs. |
| `packages/launch` | Winch launch, aerotow rope and tow plane, ported from FlightGear (`hitch.nas`, ASK21 `dragrobot.nas`), forces into JSBSim `external_reactions`. No browser or Node APIs. |
| `packages/gym` | Gymnasium-style environments (`landing`, `aerotow`): seeded, bit-deterministic, ~300–380× real time per core; observation-only baseline policies. No browser or Node APIs. |
| `packages/scenery` | Mapbox Vector Tile decoder and swisstopo water polygons for the renderer. No browser or Node APIs. |
| `apps/headless` | Node experiments: glide run, speed polar, PNG plot, soaring over real terrain (`SoaringSim`), ground launches (`GroundLaunchSim`), the gym over stdio (`gym-server`) and its benchmark. |
| `apps/web` | Browser app: FDM worker (120 Hz), Cesium scene on real terrain, thermal clouds, animated model, chase/cockpit camera, gamepad, HUD. |

## Quick start

```sh
pnpm install
pnpm fetch:ask21   # downloads Aircraft/ASK21 (~58 MB) into .cache/fgaddon (tests do this too)
pnpm test          # includes the timed 120 s headless glide
pnpm glide         # out/ask21-solo-glide.csv + summary
pnpm polar         # out/ask21-solo-polar.csv + out/ask21-solo-polar.png
pnpm bundle:ask21  # web bundle → apps/web/bundles/ASK21
pnpm bundle:models # tow plane and winch models → apps/web/bundles/_models
pnpm gym:bench landing 20   # gym speed and baseline score (see docs/milestone-6.md)
python3 python/webflight_gym.py landing   # Python client (numpy; gymnasium optional)
pnpm dev           # http://localhost:5173: title screen; or deep-link ?field=RO-0010&at=45.6994,25.5284&launch=winch|aerotow&time=2026-07-15T14:00 (see docs/world.md)
```

The FGAddon cache location can be overridden with `WEBFLIGHT_FGADDON_CACHE`.

## Hosting (GitHub Pages)

`.github/workflows/pages.yml` builds the site on every push to the default branch and
publishes it at `https://<owner>.github.io/<repo>/` (here: https://rtnicolae.github.io/WebFlight/).
It downloads and converts the FlightGear aircraft at build time (GPL data, never committed).
One-time setup: make the repository public (Pages on private repositories needs a paid plan),
then Settings → Pages → Source: **GitHub Actions**, and re-run the workflow (Actions → Pages →
Run workflow). Locally: `BASE_PATH=/WebFlight/ pnpm build` builds for that sub-path.
Pages cannot send cross-origin isolation headers, so the flight model hands its state to the
page by message instead of shared memory (same behaviour, slightly more overhead).

See `docs/glider-inventory.md` for the gliders available, `docs/milestone-1.md`,
`docs/milestone-2.md`, `docs/milestone-3.md`, `docs/milestone-4.md`, `docs/milestone-5.md`, `docs/milestone-6.md` and `docs/look.md` for results and findings, and `LICENSES.md`
for licensing.
