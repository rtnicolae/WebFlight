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

## The glider

The climb a pilot sees is the air's movement less the glider's sink, so the glider's polar comes
first. The ASK 21 (FGAddon's JSBSim model, made with Aeromatic) had a drag term for elevator
travel that the measured polar has no room for, and drag numbers tuned round it: solo it glided
42 to 1 (Schleicher: 34), two-up it sank 0.21 m/s too much near minimum sink. With that term
gone and two numbers fitted to the measured polar at 468 kg (XCSoar's, matching the flight
manual's chart), it agrees at 563 kg too, which was not fitted (`aero-fixes.ts`;
`apps/headless/test/polar-reference.test.ts`). Solo with an 80 kg pilot: best glide 33 at 91
km/h, minimum sink 0.66 m/s at 67 km/h (Schleicher: 34 at 90, 0.64–0.65 at 67). In the browser:
0.81 m/s sink at 90 km/h at 1,450 m in still air, as Node predicts. Still open: two-up the trim
runs out of elevator at 75 km/h (the stall then would be ~71); the model's balance (where the
lift acts, no zero-lift pitching moment) is Aeromatic's estimate.

## Known limits

- **Waves are linear.** Where the mountains are high against the wind (Nh/U well above 1), real
  flow is partly blocked, can break or form rotors; the theory has none of it. In light winds it
  still gives weak waves (±1 m/s at most over the Carpathians on 15 Sep 2026) that the blocked
  real flow probably would not; in gales it may overstate (13 Nov 2026: sink to −13 m/s).
- **Wave layering:** the field still moves 4–12 % aloft, up to 20 % low down in light turning
  winds, with each halving of the 62.5 m layers.
- **No waves without temperatures aloft:** reanalysis days (older than ~3 months) and the gym.
- **No turbulence:** JSBSim's MIL-spec model is not switched on.
- **The weather is the start hour's** for the whole flight.
- **Cumulus thermals' profile** above mid-height is ours (see the table).
- **Overcast days are drawn clear:** when the model's low cloud cover is high (stratus, as on
  many November days) there are no cumulus, but no cloud deck is drawn either.

## Tests

`packages/environment/test/waves.test.ts`, `thermal-placement.test.ts`, `environment.test.ts`,
`weather.test.ts`; flights with JSBSim in `apps/headless/test/soaring.test.ts` (thermal climb at
RASP's rate, ridge lift on the Jura, a lee-wave climb and the same air sinking without waves).
