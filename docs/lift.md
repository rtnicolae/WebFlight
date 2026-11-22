# The air the glider flies in

Everything that moves the air round the glider comes from the day's weather data and published
models; where a model leaves a number open, the number and its source are stated here. JSBSim
flies the glider; this is what it is given as wind (`atmosphere/wind-*-fps`), as FlightGear
gives its JSBSim.

| Part | Model | Data | Checked against |
|---|---|---|---|
| Wind by height | the weather's levels (10, 80, 120, 180 m over the model's own ground; 925–400 hPa), layered as FlightGear's environment (`environment_ctrl.cxx`); within 10 m of the ground the logarithmic surface layer (WMO open terrain, z0 0.03 m) | Open-Meteo forecast, or the reanalysis (10 and 100 m, a power law above) | 1 Oct 2026: 4 kt at the ground, 18 kt at 1,630 m in a browser flight |
| Thermals: where, how many, how high | FlightGear's thermal (life cycle, nearest-thermal rule); placement by sun and terrain; cloud base: the mixed-layer parcel's condensation level (lowest 100 hPa averaged, as the US Storm Prediction Center lifts it; Bolton 1980), else 125 m per degree of 2 m spread; one height above sea level for the air mass, no thermal where the ground reaches it; tops from the boundary layer; strength scale w* (Deardorff) | temperature and dew point at 2 m and the pressure levels, surface pressure, sunshine, boundary-layer depth | 12 Nov 2026: base 150 m by the 2 m rule, 736 m by the parcel (the model: 86 % low cloud, no thermals) |
| Thermals: the lift in them | NASA's updraft model (Allen 2006, from Lenschow & Stephens' and Konovalov's measurements); strength ×1.46 so an average thermal at mid-height gives a glider w*, RASP's rule (vario = w* − sink); under cumulus the updraft holds up to the base (RASP: stronger than the dry figure, no number given: our profile) | as above | Allen's check case (r2 79.4 m); 10 Jul 2024: ASK21 (JSBSim) centring an average thermal climbs 1.3–1.7 m/s at every height, in calm and in the day's wind (the same with the corrected polar, 20 Nov 2026) |
| Thermal lean | the column's air carried by the wind at each height while it rises at the thermal's core speed | wind by height | — |
| Clouds over thermals | appear when the thermal reaches cloud base, grow, fade as it dies (visual); ray-marched volumes to 45 km, beyond them to ~160 km the same sky model's clouds drawn from a top-down map in the same pass (sprites under the atmosphere's sky were painted over by it: nothing showed past 45 km) | — | 10 Jul 2024: a visible cloud has climbable lift under it 85 % of the time; lift at mid-height ~550 m upwind of the cloud's centre; from the runway the field now reaches the horizon |
| Ridge lift | FlightGear's ridge lift, driven by the wind at the glider's height (FG: the surface wind) | terrain, wind by height | Jura (test); 12 Nov 2026, Bucegi crest: +4.3 windward, −3.8 lee in a browser flight |
| Mountain waves | linear theory (Queney, Scorer, Smith); layers joined by displacement and pressure (Jiang, Doyle & Smith 2006); absorption at critical levels (Booker & Bretherton 1967); the boundary layer absorbing at the ground with Smith, Jiang & Doyle (2006)'s values for rough ground; near the slopes FG's ridge lift, the waves taking over as it fades with height | terrain; wind and temperature at the pressure levels (forecast days only) | Queney's exact solution (8 %); the papers' worked example (R̂, q̂); trapped-wave decay in the simulations' range; undamped limit (< 1 %); 12 Nov 2026: ASK21 crabbing along the Bucegi lee wave climbs +224 m in 4 min in a browser flight (Node: same path) |

## Weather over time

The flight's clock is the start's time plus the simulated time (it stands still while paused; a
reset starts it again). Every simulated minute the air takes the weather of that moment between
the forecast's hours (`weatherAt`: linear in time, winds as vectors, visibility as extinction;
Open-Meteo's shortwave is the preceding hour's mean, so it sits half an hour earlier):

- **Wind by height** in the flight model, as at the start (a wind set by hand stays).
- **Thermals** keep their place and their life cycle; strength, width, top and lean follow the
  new weather. Where the day has room for more (the morning) new ones start forming; where it has
  room for fewer (a deeper layer spaces them wider, the evening) the spare ones die out through
  their cycle and are not reborn. Cumulus appear and go with the day.
- **On the page:** the near clouds follow the flight model's thermals; the far ones (to 160 km)
  every 5 simulated minutes; the mountain waves are built again every 30. When the day turns blue
  (the thermals no longer reach the condensation level, in the evening) the clouds there dissolve
  over 10 minutes and new thermals get none; when it turns cloudy they grow in.
- **The sun** moves with the clock: the light on everything (Cesium's sun light, its colour, and
  below 5° the dusk light), the shadows, the sky and the haze with the eye's adaptation, the cirrus
  and the cloud shadows on the ground; the dusk and night tints of the sun's height on Google's
  tiles (their light and haze), the globe and its imagery, and the glider (its environment map
  made again when the clock has moved 15 minutes, one short stall then).
- **The haze** takes the hour's visibility (or humidity) and the boundary layer's depth (its top);
  **the cirrus** the hour's high cloud, drifting with the wind aloft.

The clock (`WeatherClock`, environment package) is the same in Node: `SoaringSim` takes one
(`weather` option), and gym episodes follow their site's hours: the estimate's hours (the sun's
day, in the episode's wind) where a site has no recorded weather, the recorded hours round each
snapshot otherwise (`record-weather.ts` now keeps 2 h before to 6 h after; snapshot files from
before keep their one hour). The clock runs on simulated time, so episodes stay deterministic.

Checked on 10 Jul 2024 at Ghimbav with the weather's clock at 60× (`?wxrate=60`, for testing):
from 08:30 no thermals, at 09:30 the first (no cloud: the base above the layer), at 10:30
cumulus near and far, the tops rising from 1,440 to 2,000 m by 16:30 and the wind turning from
240° to 70° as the reanalysis has it. From 15:30, facing west: the sun lowers ahead, the clouds
turn backlit, and at 20:30 its disc sits on the horizon in an orange glow, with pink cirrus; at
19:00 the cumulus end and the clouds dissolve (half gone after 5 real minutes). From 19:30: at
20:30 the disc on the horizon, at 21:30 an orange band under a purple sky over a dark ground.

## Weather by place

The weather used to be one column's, the start's, everywhere. Now the browser also fetches
Open-Meteo's columns on a 5 × 5 grid round the start, 16.5 km apart (±33 km; one request for
the same days and model as the start's), each on the forecast model's own smooth ground
(`elevation=nan`: without downscaling to a 90 m height model, one node landed on a peak and the
next in a valley). `weatherOnGrid` blends the four columns round a point bilinearly, by physical
height (`blendWeather`): each column's 2 m air and surface pressure at the blended ground
(`air.ts`), the convective layer's top above sea level, winds as vectors, levels by pressure.

- **The flight model** takes the weather where the glider is (`WeatherClock.step` with its
  position, every simulated minute): wind by height, temperature, humidity and pressure.
- **Thermals:** every sky cell, near (the flight model's) and far (the page's, to 160 km), takes
  the convective layer over its centre: strength, spacing and width, cloud base, cumulus or
  blue. On 10 Jul 2024 at 13:00 near Ghimbav: thermal tops from 2,170 to 2,645 m (the
  mountains to the south 2,520 m on average, the basin 2,300 m), against one 2,157 m with the
  start's column. Same frame rate.
- **Along the flight** (`GridFollower`): once the glider is within one spacing (16.5 km) of the
  grid's edge, the grid moves on its own lattice to have it at the middle node again, and asks
  for only the columns it lacks (a row or column: 5; checked every 5 s, as the mountain waves'
  re-centring). The columns it keeps are the same places asked for the same days, so the weather
  over the ground both grids cover, the glider's included, doesn't change with the move; only
  cells that had the old edge's weather do (far thermals 26.0–26.2° E on that day: mean top
  2,548 → 2,456 m), and their clouds follow gradually (`cloud-follow.ts`). Every column fetched is kept for the flight: flying back, or a reset to the
  start (the grid moved back before the reset reaches the flight model), asks for none. A failed
  request keeps the grid (its edge's weather beyond) and is retried a minute later. Checked in
  the browser: a glider put 20 km east fetched 5 columns, and its weather across the swap went
  on 1,884 → 1,885 m layer, 28.58 → 28.58 °C (the trend of its motion); after a reset the
  start's weather minute for minute as on the first run.
- **Not by place yet:** the wind the thermal columns lean in (the glider's weather's, one wind
  table for all cells), the haze, cirrus and light (the glider's), and the gym and headless
  flights (the start's column). `?wxgrid=0`: the start's column everywhere. Columns are cached in
  the browser's Cache Storage (archive days kept, forecasts an hour); each counts as one of
  Open-Meteo's free calls (× ~6 for the number of variables): ~150 for the first grid, ~30 a
  move (one every ~16 km flown away from the start).

## The air's temperature, humidity and pressure

JSBSim used to fly in the standard atmosphere (15 °C and 1013.25 hPa at sea level, dry) whatever
the day. Now it gets the day's air at the glider's height, as FlightGear hands it to JSBSim
(`FGJSBsim::copy_to_JSBsim`: temperature and dew point at the aircraft, sea-level pressure),
from the weather's own column (`air.ts`, environment package):

- **Temperature and dew point:** the 2 m values over the model's ground, then the pressure
  levels' (925 to 600 hPa), linear in height between them; beyond them the standard lapse
  (6.5 K/km), the dew point keeping its spread. Without levels (the reanalysis), the standard
  lapse from 2 m: FG's own fallback from a station report.
- **Pressure:** the surface pressure at the model's ground (now also fetched from the
  reanalysis), then the levels' pressures; log-linear in height between them, hydrostatic
  beyond. With no pressure at all (the offline estimate): 1013.25 hPa at sea level under the
  day's temperatures.
- **Into JSBSim** every step batch: its temperature bias (uniform in height) set for the
  temperature at the glider, its sea-level pressure for the pressure at the glider (its own
  hydrostatics through the biased column), then the dew point (JSBSim keeps the moisture as a
  vapour fraction). At a start, before the trim (airspeed → true airspeed). The air follows the
  weather's clock.
- **The altimeters** (front and rear seat) are set to the day's QNH at the start, as before
  take-off: on the runway they read the field's height; aloft, a hot day's temperature error
  (10 Jul 2024, 28 °C at Ghimbav: 840 m shown at 854 m).

The effect: on a hot afternoon the air is a few per cent thinner, the true airspeed and sink a
few per cent higher at the same indicated speed (10 Jul 2024 at 850 m: true/indicated 1.070, a
November day 1.038, the standard atmosphere 1.042). Checks: `packages/environment/test/air.test.ts`
(the column, QNH, no change on a standard day) and `apps/headless/test/air.test.ts` (JSBSim's own
temperature, pressure and dew point at the glider, standing and gliding, against the column).
The gym and `SoaringSim` set it too.

## The glider

The climb a pilot sees is the air's movement less the glider's sink, so the glider comes first.
FGAddon's ASK 21 (JSBSim, made with Aeromatic, then hand-tuned) is corrected where its files are
read (`packages/converter/src/aero-fixes.ts`), for the browser and Node alike:

| Part | Was | Now | From |
|---|---|---|---|
| Datum (wing-root leading edge) | an XML comment implied x = −1.215 m | x = −1.64 m | the model's own 3D geometry |
| Empty mass and CG | 360.15 kg, 740 mm aft of the datum | 379.9 kg, 771 mm | an ASK 21's weighing record (JA2747) |
| Seats (ahead of the datum) | front 1,160, rear 160 mm | 1,217.5 and 80 mm | Schleicher's weight and balance sheet |
| Lift | a wing section's table (slope 6.9/rad) | × 0.867 | lifting-line theory, aspect ratio 16.1 |
| Elevator's pitching moment | −0.5 /rad | −0.8 | the model's own elevator lift × tail arm |
| Elevator travel | ±20° | 22.6° up, 16.2° down | type data sheet (90 and 65 mm at 230 mm from the hinge); ASK 21 B manual |
| Pitch trim's forward reach | the elevator's whole travel (hands-off at any speed) | 0.25 of the down travel: full forward trims at 155 km/h with an 80 kg pilot | Schleicher's continued-airworthiness instructions: 150–160 km/h with one pilot |
| Static stability | −0.7 /rad: neutral point 423 mm, ahead of the certified aft CG limit (469) | −1.06: 486 mm | tail volume (the model's tail geometry; Raymer) |
| Airbrakes' lift loss | −0.05 | −0.12 | fitted: solo stall +3 km/h with them out (manual) |
| Drag per unit of elevator travel | 0.02 (more than the airframe's two-up) | 0 | no drag numbers fit the measured polar with it |
| Profile drag, induced factor | 0.007, 0.018 | 0.0099, 0.0214 | fitted to the measured polar at 468 kg |

Checks (`apps/headless/test/polar-reference.test.ts`):

- **CG:** loaded as for the flight manual's stall speeds (470 kg solo; 600 kg two-up, 110/110), the
  CG is 390 and 250 mm aft of the datum, inside the certified 234–469 mm (FGAddon's numbers put the
  600 kg loading at 180 mm, ahead of the limit).
- **Polar:** within 0.024 m/s of the measured polar at 468 kg, used for the fit, and at 563 kg,
  not used (XCSoar's polar, matching the manual's chart). Solo with an 80 kg pilot (460 kg): best
  glide 32.8 at 92 km/h, minimum sink 0.67 m/s at 70 km/h (Schleicher: 34 at 90). Before: best
  glide 42.
- **Stall speeds:** the lowest steady speed is 65.5 km/h solo at 470 kg (manual 65; not fitted:
  it follows from the lifting-line lift), 75.25 two-up at 600 kg (manual 74; 76.25 with FGAddon's
  ±20° elevator) and, with the airbrakes out, 68.5 and 78.5 (manual 68 and 77). Slowing at 1 kt/s
  as in a flight test: 63.2 solo (just past the break), 73.7 two-up.
- **Browser:** 0.82 m/s sink at 90 km/h at 1,450 m in still air, as Node predicts.

Still open:

- **Two-up stall** 1.25 km/h above the manual's. The whole glider's pitching moment at zero lift
  isn't published; the model's is +0.059 (nose-up, from its reference at zero incidence), needing
  4.5° of down elevator at zero lift.
- **Trim and pilot weight:** the trim is an elevator offset (the real one is a spring on the
  stick). Full forward it holds 155 km/h with an 80 kg pilot (the web's loading), but the speed
  swings with the CG: under 100 km/h with 70 kg, 221 km/h with 90 kg, because the model's neutral
  point (estimated, above) is close behind a light pilot's CG. The published check doesn't give
  the pilot's weight. Faster than the trim reaches, air starts (and the test tools) hold the stick.
- Indicated speeds near the stall carry the real airspeed system's error, which the manual doesn't
  give.

## Known limits

- **Waves are linear.** Where the mountains are high against the wind (Nh/U well above 1), real
  flow is partly blocked, can break or form rotors; the theory has none of it. In light winds it
  still gives weak waves (±1 m/s at most over the Carpathians on 15 Sep 2026) that the blocked
  real flow probably would not; in gales it may overstate (13 Nov 2026: sink to −13 m/s).
- **Wave layering:** the field still moves 4–12 % aloft, up to 20 % low down in light turning
  winds, with each halving of the 62.5 m layers.
- **No waves without temperatures aloft:** reanalysis days (older than ~3 months) and the gym.
- **No turbulence:** JSBSim's MIL-spec model is not switched on.
- **Weather over time, in part:** tints baked into shaders when they are built keep the start's
  sun (the globe's ground shader's sky light and dusk haze, OSM buildings and trees in globe mode,
  the twilight sky added for starts below 5°) and the sun a thermal's place was scored with
  (each sky cell keeps the sun of the hour it came alive).
- **Cumulus thermals' profile** above mid-height is ours (see the table).
- **Overcast days are drawn clear:** when the model's low cloud cover is high (stratus, as on
  many November days) there are no cumulus, but no cloud deck is drawn either.

## Tests

`packages/environment/test/waves.test.ts`, `thermal-placement.test.ts`, `environment.test.ts`,
`weather.test.ts`; flights with JSBSim in `apps/headless/test/soaring.test.ts` (thermal climb at
RASP's rate, ridge lift on the Jura, a lee-wave climb and the same air sinking without waves).
