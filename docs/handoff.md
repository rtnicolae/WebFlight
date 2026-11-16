# Handoff: continuing WebFlight on the owner's Mac

Read this first if you are a new Claude session picking up this project. It was written by the
cloud session that did the work so far (branch `ccr-d0da0398-gcj6f4`, which is also the
repository's default branch). That session ran in a container **without a GPU**: it could only
render in software at ~2 s per frame, so it could never measure frame rate or real loading
time. That is the main reason the work moved to the Mac. Your first job is to measure.

## The project in one paragraph

A browser glider simulator: the ASK21 glider flown by JSBSim compiled to WebAssembly (ported
FlightGear aircraft, Nasal logic and instruments in TypeScript), drawn with CesiumJS on real
terrain, with live or historical weather (Open-Meteo), thermals placed from terrain and sun,
aerotow and winch launches, OSM buildings/trees/roads everywhere in Europe, and a gym for
reinforcement learning. Home base: Ghimbav aerodrome near Brașov, Romania (`?field=RO-0010`).
Everything is data-driven: no scenario is hard-coded. pnpm workspaces, TypeScript strict, Vite,
Vitest. Read `README.md` for the layout, `docs/world.md` for how the world is built, and
`LICENSES.md` for every data and asset source.

## Owner's standing rules

- Verify every JSBSim property name against the JSBSim source or docs before relying on it.
- Only JSBSim (`jsb`) aircraft.
- Keep `LICENSES.md` recording every aircraft, data, texture and model source.
- Small commits with clear messages. Ask before adding heavy dependencies.
- The owner wants an MSFS-2024-like look, Romania first. Visual-only parts (ground detail,
  scenery, buildings) may be procedural or AI-augmented; the simulation must not be.
- The owner judges by what they see. Show screenshots, give numbers you measured, and say
  plainly what you did not verify. Several earlier "fixes" were shipped unverified and made
  things worse; don't repeat that.

## Run it

```sh
pnpm install
pnpm fetch:ask21      # downloads the ASK21 from FlightGear (~58 MB, cached in .cache/)
pnpm bundle:ask21     # → apps/web/bundles/ASK21 (generated, GPL, not committed)
pnpm bundle:models    # tow plane and winch → apps/web/bundles/_models
pnpm test             # 123 tests should pass
pnpm dev              # http://localhost:5173
```

Useful URLs (open in Brave):
- `http://localhost:5173/?field=RO-0010&launch=aerotow` ground start at Ghimbav (L starts the tug)
- `http://localhost:5173/?lat=45.6510&lon=25.6040&agl=30&hdg=330` over Brașov tower blocks
- `http://localhost:5173/?lat=45.6335&lon=25.5900&agl=70&hdg=120` forest south-west of Brașov
- add `&time=2024-07-10T23:30` for night, `&time=2024-07-10T20:25` for dusk

Debug switches: `quality=low|high|ultra`, `shadows=0`, `grass=0`, `trees=0`, `buildings=0`,
`pin=0|<metres>` (glider-pinned ground radius, default 3000), `detailgpu=0` (ground detail on
the CPU), `sw=0` (unregister the tile cache service worker), `dynres=1`, `sharpen=0..1`.
`window.webflight` in the console exposes `viewer`, `cam`, `reader`, `layout`, `send`.
The fps counter is at the top right of the HUD.

The site is also deployed by `.github/workflows/pages.yml` to
https://rtnicolae.github.io/WebFlight/ on every push to the default branch.

## Where things stand (most recent first)

1. **Caching** (`apps/web/public/sw.js`, `apps/web/src/detail/detail-worker.ts`): a service
   worker caches tiles and static assets cache-first; finished detail tiles are stored in
   Cache Storage (`webflight-detail-<build id>`). Owner said "caching is not working at all";
   this is the response. **Not measured on real hardware.**
2. **Ground detail on the GPU** (`apps/web/src/detail/gpu-synth.ts`): the per-pixel synthesis
   runs as a WebGL 2 fragment shader inside the tile workers; `synth.ts` is the CPU reference
   and fallback. CPU and GPU tiles were compared pixel by pixel (mean difference ≤ 0.05/255).
   **Speed not measured** (no GPU in the cloud).
3. **Glider-pinned ground** (`apps/web/src/ground-lod.ts`): within 3 km of the glider, ground
   tiles are chosen by the glider's position, not the camera's, so looking around does not
   reload them; tiles out of view are loaded but not drawn. Owner asked for 30 km; that never
   finished loading and was rolled back to 3 km. Even at 3 km the load queue is about twice
   that of plain Cesium (`pin=0`).
4. **Frame rate**: owner reports **13 fps** on the M1 (and on a Pixel 8), before items 1–3.
   Nothing has been profiled on a GPU yet.
5. **Night lighting, lamps, forests, buildings**: see `docs/world.md` and the commit log;
   these were checked in software renders only.

## Open complaints from the owner (not resolved)

- 13 fps on M1 in Brave and on a Pixel 8. Unknown cause.
- Loading feels slow; tiles appear late.
- "Buildings' basements can be seen through the ground" (walls continue 10 m below ground
  for slopes, `SKIRT_M` in `packages/scenery/src/osm.ts`; below ground they are now
  earth-coloured; it shows when the drawn terrain is still coarse).
- Earlier: tile texture changing as the camera moves (addressed: same colours at every zoom
  from 15 up, and pinned ground), diagonal shadow lines on buildings (shadow bias raised;
  not reproduced).

## Suggested first steps on the Mac

1. Run the dev server, open the Ghimbav URL in Brave, read the fps. Then try, one at a time,
   `shadows=0`, `pin=0`, `grass=0`, `trees=0`, `buildings=0`, `detailgpu=0`, `quality=low`, and
   note which moves the fps. Report the table to the owner.
2. Profile a few seconds in Brave's DevTools Performance panel (main thread and GPU) at the
   Ghimbav start and over Brașov. Look at time in Cesium's globe render, shadow passes,
   building/tree primitives, and main-thread work from `osm-layer.ts` / `grass-layer.ts`.
3. Measure loading: time until the ground under the glider is sharp, first visit vs reload
   (cache), and with `pin=0`.
4. Only then change code, and re-measure after each change.

## Measurement scripts the cloud session used

Playwright scripts (not in the repo; they lived in the session's scratchpad) that you may
want to recreate: load a URL, pause the sim with
`window.webflight.send({ type: "pause", paused: true })`, wait, and read
`viewer.scene.globe._surface._tilesToRender` (levels and distances), the load queues
`_tileLoadQueueHigh/Medium/Low`, `viewer.scene.frameState.commandList.length` (draw calls),
and `caches.keys()`. On a Mac, use Chromium with its real GPU rather than SwiftShader.
