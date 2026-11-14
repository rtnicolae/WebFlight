# Look and feel

| Title screen | Ridge soaring |
|---|---|
| ![](img/look-menu.jpg) | ![](img/look-ridge-hud.jpg) |

These screenshots were taken in a cloud container whose network blocks the photo servers and which renders in software (SwiftShader, about 15 fps). They therefore show the **painted fallback** with tiles still streaming in. In a normal browser you get aerial photos and sharp tiles.

## What's there

| Piece | Where | Notes |
|---|---|---|
| Title screen | `web/src/menu.ts` | A slow orbit over Grenchen and the Jura under the day's cumulus. Scenario cards (final approach, ridge, thermal, winch, aerotow). Time of day, wind, scenery and quality. Choices are remembered (localStorage), and Enter flies. Everything ends up in URL parameters, so any flight can be bookmarked. An empty URL or `?menu` shows the menu; **Esc** in flight returns to it. |
| Imagery | `web/src/imagery.ts` | **Photos**: swisstopo SWISSIMAGE over Switzerland on top of Sentinel-2 cloudless (2016, CC BY 4.0) elsewhere. A quick probe checks the servers. If they can't be reached, the app uses the **painted** terrain instead. The real runway is visible in the photos, so the drawn runway is added only for the other modes. |
| Painted terrain | `web/src/paint/` | Land cover generated from the Terrarium heights in workers. Fields and hedgerows on flat lowland, forest on slopes and in patches, villages, ridge pastures, alpine meadow, rock, scree and snow, all hillshaded from the actual sun position. The noise works in a fixed metric frame, so features are continuous across tiles and zoom levels. Tiles copy Terrarium pixels directly (`TerrariumTerrain.heightGrid`): about 45 ms per 256² tile in Node. |
| Light | `web/src/scene.ts`, `sun.ts` | Sun position for mid-July at the chosen time (`morning` 07:15, `noon`, `afternoon` 16:30, `evening` 20:50 CEST, or `HH:MM`). Sun-lit globe with dynamic atmosphere, haze and fog. Soft glider shadow on the ground. FXAA. |
| Clouds | `web/src/scene.ts` | A cumulus over each thermal, from Cesium's procedural cloud impostors: a few puffs with a flat base at the thermal's cloud base. They grow while the thermal forms and fade as it dies, so the clouds mark the lift as real ones do. |
| HUD | `web/src/hud.ts`, `style.css` | Frosted-glass panels. A bottom instrument strip (airspeed, a large colour-coded vario with a bar, altitude; AGL, TE, L/D). Wind arrow relative to the nose, with thermal and ridge lift. Stick, rudder, airbrake and trim indicators. Launch status, pilot messages, a pause banner and a help card (**H**). |
| Loading | `index.html`, `style.css` | A quiet title card with a progress shimmer while the aircraft and FDM load. |

## Quality presets (`quality=`)

- `low`: no shadows.
- `high` (default): soft shadows and FXAA.
- `ultra`: adds HDR and 4× MSAA. Under SwiftShader, MSAA alone, and HDR together with shadows, rendered the globe incorrectly (black ground, inverted haze). Real GPUs are expected to be fine, but this isn't verified, so `ultra` is opt-in.

## Fixed along the way

- **Terrain cliffs at tile edges.** `TerrariumTerrain.heightmap()` sampled through the shared tile cache after awaiting its loads. Concurrent requests evicted those tiles in between, so some heights read 0 m, which showed up as walls along tile edges. It now samples from the tile arrays it loaded. Coarse levels went from up to −645 m mean error to about 1 m.
- **Coarse terrain flattened the ridges.** Terrain tiles are now 65×65 samples instead of 33×33.
