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
  every 5 simulated minutes; the mountain waves are built again every 30.

Checked on 10 Jul 2024 at Ghimbav with the weather's clock at 60× (`?wxrate=60`, for testing):
from 08:30 no thermals, at 09:30 the first (no cloud: the base above the layer), at 10:30
cumulus near and far, the tops rising from 1,440 to 2,000 m by 16:30 and the wind turning from
240° to 70° as the reanalysis has it.

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
- **Weather over time, in part:** the sun's position (the light, the shadows, how candidate
  thermal spots are scored), the haze and the cirrus stay the start hour's; flights in Node
  (headless, the gym) keep the start hour's weather throughout.
- **Cumulus thermals' profile** above mid-height is ours (see the table).
- **Overcast days are drawn clear:** when the model's low cloud cover is high (stratus, as on
  many November days) there are no cumulus, but no cloud deck is drawn either.

## Tests

`packages/environment/test/waves.test.ts`, `thermal-placement.test.ts`, `environment.test.ts`,
`weather.test.ts`; flights with JSBSim in `apps/headless/test/soaring.test.ts` (thermal climb at
RASP's rate, ridge lift on the Jura, a lee-wave climb and the same air sinking without waves).
