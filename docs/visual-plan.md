# From "good in places" to stunning: visual audit and plan

Audit of 18 November 2026, branch `mac/msfs-look` at e44fdab.

## How it was measured
- **Machine:** Brave on the M1 Pro, one window of 1440×900 CSS pixels at 2× (Retina).
- **Day:** cumulus day, 10 July 2024 at 13:00 near Ghimbav. 213 near and about 1,000 far clouds were drawn.
- **Tour:** 9 viewpoints, 20 screenshots and the fps of each view:
  - the runway: chase, side, wide and cockpit;
  - fields at 60 m;
  - Brașov at 300 m;
  - the basin at 1,000 m;
  - cloud level at 1,500 m AGL;
  - Postăvarul at 500 m;
  - golden hour at 19:45;
  - 24 s of flight at 300 m.
- **Pipeline options**, switched at runtime in 3 views: render scale, HDR and MSAA.
- **Not committed:** the screenshots. They show Google's tiles, which are display-only under Google's terms.

## Progress
**18 Nov 2026.** Phase 0 is done, and phase 1 except MSAA.

| Item | Status |
|---|---|
| D1 grass vanishing | Fixed (63875dd). Cause: the ground correction sampled the tiles round the glider before they could answer, then clamped to a field-wide median. |
| E1 canopy seam and milky haze | Fixed (f809425). The outer glass is hidden from the cockpit; the model has two glass layers. |
| E2 cockpit | Shadow steps fixed (fe175f1): a 2.5 m nearest cascade in the cockpit. The olive panels are the model's colour, not holes. |
| C2 streaky grain | Fixed (17c0e27): near-only on Google's tiles. |
| C3 colour | Better (17c0e27): vegetation +20% saturation, mauve soil turned brown. |
| A4 ground stutter | Fixed (5e52466). Cause: Cesium reads tile geometry back from the GPU on every pick; now cached. Parked fps 59 → 76, P95 frame 34 → 15 ms. |
| A1 resolution | Dynamic 1.0–1.5× (6e5cea0). |
| A2 HDR | HDR with bloom and our tonemap after the clouds (52343a0). The clouds are white now. |

Still open from phase 1: 4× MSAA, which costs 5–10%.

**Phase 2, same day:** one atmosphere (da8f28a, 639d459).
- **The model:** Hillaire's sky and aerial perspective, with lookup tables computed on the GPU. It replaces Cesium's sky, sun and fog.
- **The boundary layer:** its haze is set by humidity (about 60 km visibility on 10 July 2024) and by the depth of the layer. Since 20 Nov 2026 the forecast's visibility (Open-Meteo; over Europe ICON's) sets it where the air is murky (under 35 km: moist air, cloud, rain, fog); in clear air ICON's figure is a fixed curve of humidity (the same from Brașov to Berlin), so it is only a lower bound and humidity still sets the haze.
- **The sun:** a disc that blooms.
- **Dusk:** the sky brightens as the eye adapts.
- **A bug fixed on the way:** Cesium's perspective depth has no precision left at our near and far planes. The atmosphere and the clouds now decode the logarithmic depth directly.
- **Result:** fps unchanged (±3). It replaces A3 (three skies) and the twilight dome.
- **Still to do from phase 2:**
  - relighting Google's tiles at low sun (4);
  - a stronger inversion line (it shows only as a pale band from above).
- **Tuning:** `?vis=`, `?apk=`, `?skyk=`; `?atm=0` brings back the old sky.

**Grade, same day (14190a1):** the haze reduced, plus a cinematic grade: saturation 1.35, contrast 1.22, teal shadows and warm highlights, a light vignette.

**Phase 3, same day:** clouds v2 (5921e3a and the commit after it).
- **Shape:** Perlin–Worley shape and Worley detail in 3D textures, made in a worker. Each cloud's towers are laid out in JS and shared with its shadow.
- **Light:**
  - three multiple-scattering octaves;
  - sky light read back from the atmosphere;
  - the atmosphere's haze applied to the clouds.
- **Range:** volumes reach 45 km and sprites only beyond, so B4 (the lilac band) is gone.
- **Shadows:** cast tower by tower, lumpy; drawn without a canvas readback (B5).
- **Bounds:** tight cylinders and 6 slots, with no cut-off clouds.
- **Cost:** about 10 fps under the cloud base, none above the clouds.
- **Still open from phase 3:**
  - temporal reconstruction (the edges are fine at 1.0×, unverified at other scales);
  - decaying evening cumulus (B6);
  - cirrus (B7);
  - cloud streets.

**Phase 4, started (3068ca1 and the commit after it):** our own water on Google's tiles (C5).
- **Bodies:** OSM lakes and ponds, each a plane at Google's water level, measured by height picks with terrain sanity checks.
- **Outline:** drawn 40 m past OSM's, so Google's shore forms the shoreline.
- **Light:** sky reflection with Fresnel, the hills reflected below the terrain's horizon round each lake, footprint-faded ripples, and a glittering sun glint.
- **Rivers:** off, because OSM maps whole gravel beds.
- **Teal water:** no longer turned neon by the grade.
- **Grass:** toned down under the grade.
- **Still open from phase 4:**
  - the airfield surface and markings;
  - grass ground cover;
  - near forests;
  - ground materials;
  - teal patches where Google's photo shows water that OSM doesn't map (we must not detect water from Google's imagery).

**Water reflections, same day (42408df, baf3604):**
- **Screen-space reflections:** hills, trees and clouds, via a mask target.
- **Ripple smear:** reflections stretched vertically, as on rippled water.
- **Fixes:**
  - bounding spheres sat on the ellipsoid, culling small ponds;
  - the same lake appeared twice (zoom 11 and 14);
  - levels now come from probes in view;
  - the plane gets a small pull towards the camera instead of clipping Google's tiles (clipping cost 20–25% fps).
- **Cost:** about 4% where a lake fills the view.

**Airfields, 19 Nov 2026:** runways painted on Google's tiles (C1, `runway-paint.ts`).
- **How:** in the tiles' own shader, as a vertical projection of each runway near the camera. No heights to match, no extra geometry; the same light, haze and cloud shadows as the ground round it.
- **From data, nothing per airport:**
  - position and direction from OSM runway lines (as the sim resolves the runway the glider stands on);
  - designators, width and the surface's material (asphalt, concrete, grass, gravel, dirt) from OurAirports, now kept in the airfield tiles.
- **Paved:**
  - markings after ICAO Annex 14 from length and width: threshold stripes, designation (letters L, C, R too), centreline, aiming point, touchdown zone on long wide runways, side stripes;
  - asphalt or concrete (slab joints) with a CC0 asphalt grain close up, rubber in the touchdown zones;
  - a little of the photo's tone kept, its melted paint clamped away, and its offset edge line darkened just outside ours.
- **Grass strips:** mown lighter, in 4 m mower lanes that are lighter or darker with the view along them, on the ground and in the 3D grass (blades laid along the cut).
- **Fixed on the way:** a long runway split in OSM's tiles came out in two halves (Bucharest 08L: 1,461 m of 3,500), which also moved where the glider starts on such runways.
- **Cost:** about 1 fps (69.7 → 70.8 with it off on the Ghimbav strip, 75.1 → 76.1 low over Brașov's runway).
- **Windsocks** (`windsocks.ts`): placed as sims do without a survey (past the first threshold, left of the landing direction, clear of the edge; a second on runways of 1,500 m or more), pointing with the day's 10 m wind and drooping in light air; standing on Google's ground (height picked once their tiles are in view).
- **Taxiways and aprons, tried and dropped:** at large airports Google's photos are sharp from a few hundred metres (yellow lines, stands, slabs), and OSM's centrelines lie a few metres off theirs: painted over, the lines doubled and the aprons went flat.
- **Still open:** strip markers, hangars.

**Image quality, 19 Nov 2026 (A1):** "everything looks grainy/sandy". Measured first:
- **Render scale:** 1.0–1.125× of 1440×900 on a 2880×1800 screen, so every aliased pixel shows as a 2×2 block.
- **Google's textures:** no mipmaps, no anisotropic filtering (their samplers are unset; Cesium's default is plain LINEAR). Slanting views point-sampled their photos: moiré in crop rows, sand in tree crowns.
- **Grass:** far blades were lone bright green pixels.
- **4× MSAA:** 15–28% of the frame rate for smoother geometry edges only. Not the default (`?msaa=4`).

Done:
- **Mipmaps and 8× anisotropic filtering** on Google's textures (`google3d.ts`; 4× was softer towards the horizon, 16× no sharper).
- **Grass:** blades past ~6 m take a patch's average light instead of glinting.
- **Temporal anti-aliasing** (`taa.ts`): a Halton sub-pixel jitter (as an angle: Cesium moves each pass's near plane), history reprojected by depth with the nearest surface's motion, things moving with the camera (glider, cockpit) kept to their screen spot, YCoCg variance clipping, Catmull-Rom history, then light contrast-adaptive sharpening (0.35). Still views converge to 8 samples a pixel; in flight the wings, the tow rope and the forest stay clean. About 5% (`?taa=0`: FXAA; `?taadbg=1` shows which history each pixel took).

Still open: the clouds' half-resolution edges (now jittered and averaged, but not reconstructed), and the render scale itself.

**Cirrus, 19 Nov 2026 (B7):** a high layer from the weather's high cloud cover (Open-Meteo `cloud_cover_high`, now in the weather snapshot; drawn only, the simulation doesn't read it). Painted with the sky (`atmosphere.ts`), so cumulus and mountains stand in front of it: at 9 km, in patches covering the weather's share, fibres bent and broken along the wind aloft and drifting with it, a milky veil when overcast (cirrostratus); lit by the sun as it is at that height (pink at sunset, a glow towards the sun) and the sky above. Checked on real days: 21 Jun 2024 13:00 (100%), 7 Jun 14:00 (59%), the sunset of 20 Jun (55%); 10 Jul 2024 has 3% and stays blue. No measurable cost. `?cirrus=0..1` tries a cover, `?cik=` its brightness.

**Glider, 19 Nov 2026 (phase 5, E3):** the gelcoat and the canopy mirror the sky our atmosphere draws (its zenith and horizon, read back every 10 s: the same blue, the same sunset) instead of fixed colours. The canopy glass, seen from outside (more than ~3 m away), is smoked and mirrors the sky with Fresnel (from 7% face-on to most of it at a glancing view): before, with the model's 15% tint and a true 4% reflection, it was an empty frame. From the cockpit it stays as clear as before.

## What already works
- Google 3D over towns from about 200 m up. Brașov at 300 m looks photographic.
- Mountains in the middle distance.
- Cloud shadows on the ground, and a cloud field that follows the thermals.
- The glider's livery and registration, and the instrument panel.
- The loading hold: the runway is in before the flight starts.

## Artifacts, by how much they hurt

### A. The whole image

**A1. A quarter of the pixels.**
- What you see: everything is soft.
- Cause: Cesium renders at CSS pixels (canvas 1440×900), and the browser upscales it 2× to the Retina screen. FXAA softens it further.
- Measured (fps, vsync off):

  | View | 1.0× (now) | 1.25× | 1.5× | 2.0× (native) | 4× MSAA at 1.0× | HDR at 1.0× |
  |---|---|---|---|---|---|---|
  | Runway, grass | 57–63 | 50 | 42 | 30 | 53 | 56 |
  | Brașov, 300 m | 54 | 50 | 46 | 34 | 51 | 53 |
  | Cloud level, 1,500 m | 102–104 | 84 | 66 | 42 | 94 | 100 |

  Native resolution is not affordable as things stand. HDR is almost free, and 4× MSAA costs 5–10%.

**A2. LDR, no tonemapping.**
- What you see:
  - The sun at low elevation is a flat cream disc with a posterised, rainbow-fringed halo.
  - Clouds cannot be brighter than "white", so they stay grey.
  - There is no bloom or glare.
- Cause: the default quality ("high") runs without `highDynamicRange`.
- The fix is not a switch. Turned on at runtime, HDR washes the picture out, because our haze, tile-light and cloud constants were tuned for LDR (`LOOK.globeAir.hdr`).

**A3. Three skies that don't meet.**
- What you see:
  - a cyan-green band above the horizon;
  - a white stripe where the ground's haze meets the sky;
  - in the evening, golden hour looks like a dimmed midday.
- Cause: Cesium's `SkyAtmosphere`, our patched globe fog and Cesium's `scene.atmosphere` on the tiles are three different models with hand-matched colours.

**A4. Uneven frames.**
- Measured: on the ground the 95th-percentile frame is 33–34 ms even at 55–63 fps average, so about one frame in twenty is doubled.
- Suspect: the grass correction grid re-runs nonstop while parked (`corrNext` cycles every ~20 s). Unverified.

**A5. A banner along the bottom of the screen:** "This application is using Cesium's default ion access token". It goes once our own token is set.

### B. Clouds

**B1. Grey cotton balls.**
- What you see: the tops never reach the brilliant white of sunlit cumulus, and the bodies are uniformly mid-grey.
- Cause: single scattering only (no multiple-scattering term), an ambient that is too grey, and LDR.

**B2. Blocky edges.**
- What you see: 2–4 px stair-steps on every cloud edge.
- Cause: the half-resolution march is upscaled without any temporal reconstruction.

**B3. Shapes all alike.**
- What you see: "balloons", too many small puffs (a popcorn sky), few big clouds, and bases that are not flat enough from the side.
- Cause: 7 spheres plus value noise. There are no wisps.

**B4. Two kinds of cloud.**
- What you see: beyond 22 km the sprite clouds are lilac, translucent and flat, in a band at one height. The change from the near clouds is obvious.

**B5. Shadows are round discs,** not cloud-shaped.

**B6. An empty evening sky.**
- What you see: 0 clouds at 19:45, just when the light would make them beautiful.
- Cause: the thermals are over and nothing decays slowly.

**B7. Missing layers.**
- There is no boundary-layer haze top at the cloud base. That inversion line is the look of a soaring day, and a visible cue to the thermal top.
- There is no high cirrus.

### C. Ground (Google 3D)

**C1. Near the ground it is a smear.**
- At the airfield: dark grey-green ground, runway markings as melted white blobs, melted hangars, and a flat tow plane.

**C2. The ground grain shows as a streaky repeating pattern** on fields from about 60 to 300 m.

**C3. Colour.**
- What you see: forests are a saturated moss green, bare fields mauve-pink, and the whole reads as "Google Earth", not a photograph.
- Cause: `wfGrade` adds +55% saturation to vegetation.

**C4. Baked midday light.**
- The photos carry their own midday shading and shadows. Away from midday we only dim and tint them: no long shadows, no warm side light.

**C5. Water is a flat photo:** no reflection of the sky or clouds, no sun glint.

**C6. A blurred mid-distance band** beyond about 3–5 km. This is the price of dynamic SSE density 1e-3, which buys the fps.

**C7. Forests up close are melted** (known).

### D. Grass

**D1. Missing altogether in 3 of 4 runway loads today.**
- Reproduced in every view from 3 to 30 s.
- `grass.ready`, `show` and `fade` all say the grass is drawn.
- Suspect: blades placed below Google's ground after the tile offset changed (40.1 m on this load, 37.9 m on another). Unverified.

**D2. When present, it looks sprinkled on.**
- What you see: sparse lime tufts on dark grey ground, reading as sprinkles rather than a lawn.
- Cause: the tuft colour is far more saturated than the ground, and there is no layer under the tufts.

### E. Glider and cockpit

**E1. The canopy shows a seam down its middle:** a vertical brightness step through sky and terrain (cockpit views at Brașov and the mountains).

**E2. The cockpit tub has holes** where the grass shows through (beside the knees), plus shadow-map staircases on the interior.

**E3. The glider looks flat white in chase views:** no visible sky reflection or highlight. This is a consequence of A2 and of the environment map.

**E4. To check:** no glider shadow was seen at 60 m AGL. It may simply have been off-screen.

## Why it falls short of MSFS
MSFS's look rests on five things, in order of effect:
1. **One atmosphere and HDR exposure for everything.** Sky, haze, sun, clouds, ground and aircraft are lit by the same sky. We have three hazes and LDR (A2, A3).
2. **Clouds that are big, bright and detailed, consistent to the horizon.** They are temporally reconstructed (no blocky edges) and come in several layers. We have grey balls with half-res edges and sprites at distance (B).
3. **Ground replaced where photogrammetry fails.** Procedural 3D vegetation, ground materials, hand-built airports, live water. We show Google's tiles as they are (C).
4. **A clean image.** TAA or upscaling at native resolution. We render a quarter of the pixels with FXAA (A1).
5. **Lighting detail.** Ambient occlusion, contact shadows, reflections, glare.

Google's photogrammetry is already at least as good as MSFS's in towns. The gap is everything around it: light, air, clouds, water, and the last 100 m to the ground.

## The plan
Sizes are rough working time: **S** about a day, **M** 2–4 days, **L** 1–2 weeks. Every phase ends by re-running the tour script with the same views. It passes only when the artifacts are gone in the shots and the fps meets the stated target.

### Phase 0: fix what is broken (S–M)
| # | Item | Size |
|---|---|---|
| 0.1 | Grass missing (D1): find the cause and fix it. Then 5 runway loads, all with grass | S |
| 0.2 | Canopy seam (E1): reflection shader or canopy normals | S |
| 0.3 | Cockpit holes (E2): converter, double-sided interior or fixed normals. Cockpit shadow staircase: bias or cascade | S |
| 0.4 | Grain streaks (C2): isotropic detail, faded out beyond about 40 m | S |
| 0.5 | Colour (C3): less vegetation saturation, cooler fields, tuned by eye (no pixel analysis of Google imagery) | S |
| 0.6 | Frame pacing (A4): the grass correction loop while parked. Goal: p95 below 20 ms on the ground | S |

### Phase 1: image pipeline (M)
1. **HDR on**, with a tonemapper (try PBR Neutral, ACES and Filmic) and exposure. Retune the haze, tile light and cloud constants for HDR.
2. **Sun and glare:** a real sun disc plus a cheap thresholded bloom (half-res mip chain), giving glare, silver linings and glints on the canopy.
3. **Resolution:** dynamic render scale 1.0–1.5× aiming at 60 fps; the `dynres` code exists but is off. 4× MSAA if the budget allows.
4. **Target:** ≥ 55 fps at Brașov 300 m and on the runway; ≥ 90 fps at cloud level.

### Phase 2: one sky (L), the largest single improvement
1. **A physically based atmosphere** after Hillaire (2020), written for WebGL2:
   - lookup tables for transmittance, multiple scattering, the sky view and aerial perspective;
   - it replaces Cesium's sky, our globe fog and the tiles' atmosphere, and feeds the clouds and the glider.
2. **Boundary-layer haze from the weather:** dense below the convective top (the cloud base), clear above. Flying above it shows the inversion line, and the haze gives away the thermal top.
3. **Sun and twilight from the model:** a sun disc with limb darkening. Golden hour and twilight come out of the model; twilight-sky.ts special cases go.
4. **Experimental: relighting Google's tiles** at low sun.
   - Normals from screen derivatives.
   - The photo divided by an estimate of its baked midday light, then lit by our sun and sky.
   - Falls back to today's tint if it looks wrong.
5. **Target:** the sky and ground meet without a band; golden-hour shots read as golden; ≤ 1.5 ms per frame.

### Phase 3: clouds v2 (L)
1. **Shape:** 3D Perlin-Worley textures (base 128³, detail 32³) made once on the GPU at start. Each cloud gets a height profile (flat base, rounded top) and edge erosion, which gives wisps. As in Guerrilla's Nubis.
2. **Light:**
   - multiple scattering by octaves (Wrenninge);
   - ambient from the sky model, blue from above and ground bounce from below;
   - in HDR, so tops go brilliant white.
3. **Reconstruction:** a quarter-resolution march with jittered start and temporal reprojection, depth-aware. This gives crisp edges and fewer steps per frame.
4. **One system to the horizon:** the same clouds marched with fewer steps far away (or impostors baked from them) replace the 22 km sprites.
5. **Sizes:** fewer, bigger clouds plus small fractus, still from thermal strength (as you asked). Cloud streets along the wind when it blows.
6. **Shadows from the clouds' own density,** projected along the sun, not discs.
7. **Evening:** decaying cumulus that outlive their thermals, so the sky does not empty. A high cirrus layer if the weather data gives high cloud.
8. **Target:** ≥ 90 fps at cloud level. Compared against photos of Carpathian cumulus.

### Phase 4: the last 100 m (L)
1. **Cut Google's tiles where we draw our own,** using Cesium's `ClippingPolygonCollection` on the tileset (in 1.147; Cesium shows it with Google's tiles):
   - **water** from OSM: a water surface reflecting the sky and clouds, with sun glint, wind ripples and a soft shoreline;
   - **the airfield** from OSM: our own surface with ground materials (grass, asphalt, gravel), runway markings and numbers from the runway data, and simple hangars;
   - **optional, forests** within 1–2 km at low height: our instanced 3D trees on our terrain (what you asked for earlier).
2. **Grass v3:**
   - a ground-cover layer under the tufts, so no grey shows between them;
   - colour taken from the ground's colour (grass adapts to the ground, not the reverse, as you asked);
   - less saturation, and clumps.
3. **Ground materials near the camera:** detail and normal maps chosen by surface type, lit by our sun. They replace the streaky grain.

### Phase 5: glider and cockpit (M)
1. **Image-based light:** our new sky captured into a cube map once per flight, giving a real sky reflection and ground bounce on the gelcoat.
2. **Canopy glass:** Fresnel reflection of the sky, slight tint, and dust and scratches that light up towards the sun.
3. **Cockpit:** occlusion and contact shadows.
4. **A better tow-plane model** (licence to check).

### Phase 6: performance, all along
- **A committed tour script** (tools/), so every change is compared before and after.
- **Per-subsystem toggles** for the fps budget.
- **Dynamic resolution** as the safety valve.

### Order
0 → 1 → 2 → 3 → 4 → 5.
- HDR comes before the sky, because the sky model needs HDR.
- The sky comes before the clouds, because the clouds' colours come from the sky.
- Phase 4 can run alongside 2 and 3: it touches other files.

## Needs a decision
1. **Frame rate against sharpness:**
   - dynamic 1.0–1.5× at 60 fps (recommended);
   - native Retina at 30–40 fps;
   - or 1.0× as now.
2. **Cutting Google's tiles** for water, the airfield and (optionally) near forests, and drawing our own there.
3. **The Cesium ion token:** yours, to remove the banner (you set it in `apps/web/.env.local`).
4. **CC0 ground textures** (ambientCG or Poly Haven) for the airfield and ground materials: a few MB, recorded in LICENSES.md, no code dependency.
