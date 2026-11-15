# Milestone 6: headless gym API

```sh
pnpm gym:bench landing 20            # baseline policy: outcomes, mean return, speed
pnpm gym:bench landing 20 random
pnpm gym:bench aerotow 6
python3 python/webflight_gym.py landing   # Python client smoke run (needs numpy)
```

```ts
import { makeGym } from "./apps/headless/src/gym.ts"; // ASK21 + cached real terrain
const env = await makeGym("landing");                  // or "aerotow"
let { obs } = await env.reset(42);
for (;;) {
  const r = env.step(policy(obs));                     // Float64Array obs, number[] action
  obs = r.obs;
  if (r.terminated || r.truncated) break;
}
```

```python
from webflight_gym import WebFlightEnv   # gymnasium.Env if gymnasium is installed
env = WebFlightEnv("aerotow")
obs, info = env.reset(seed=0)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
```

## Design

| Piece | Where | Notes |
|---|---|---|
| `GliderEnv` | `packages/gym/src/env.ts` | `reset(seed)` → `{obs, info}`; `step(action)` → `{obs, reward, terminated, truncated, info}` (Gymnasium semantics). Actions are clipped to the box. 10 decisions per second by default (action repeat of 12 FDM steps at 120 Hz). Wind, ridge lift and launch update every 4 FDM steps. No browser or Node APIs. |
| Determinism | env | Every `reset` builds a **fresh JSBSim instance**: about 20 ms once the WASM module is warm. Reusing one instance with `ResetToInitialConditions` left differences around 1e-13 that grow along a trajectory. The episode's randomness comes from one `mulberry32` stream seeded by `reset(seed)`. Terrain is preloaded around the site and then **frozen** (`TerrariumTerrain.frozen`), so a tile finishing its download mid-episode cannot change results. Tests check that the same seed and actions give bit-identical observations and rewards, regardless of what ran before. |
| Tasks | `packages/gym/src/tasks/` | `landing` and `aerotow`. Each defines its spaces (named dimensions), randomized setup, termination and reward. |
| Baselines | `packages/gym/src/policies.ts` | Scripted policies that see **only the observation vector**. They show the observations are sufficient, give a reference score, and can serve as demonstrations. |
| Node glue | `apps/headless/src/gym.ts` | ASK21 from the FGAddon cache, terrain from the disk cache. |
| Server | `apps/headless/src/cli/gym-server.ts` | JSON lines over stdio: `make`, `reset`, `step`, `close`. Doubles round-trip exactly, so episodes stay bit-identical through the pipe. |
| Python | `python/webflight_gym.py` | Starts the server and maps it to `gymnasium.Env` with `Box` spaces when gymnasium is installed. Otherwise it offers the same API with a minimal box. Only numpy is required. Run several envs as several processes, for example with gymnasium's `AsyncVectorEnv`. |

### Shared observation (first 16) and actions

`ias_mps/50, climb_mps/10, agl_m/100, roll_rad, pitch_rad, p, q, r (rad/s), alpha_rad, beta_rad, aileron, elevator, rudder, airbrake, main_wheel_on_ground, groundspeed_mps/50`.

Actions use FlightGear conventions: `aileron`, `elevator` (+ = nose down), `rudder` (+ = yaw right), each in −1..1, and `airbrake` in 0..1. On the ASK21, the last 10 % of airbrake travel is the wheel brake.

### `landing`

the episode's airfield and runway in use (drawn from data with the weather, see docs/world.md) on real terrain; up to 300 s.

- **Start (per seed):** 600–2500 m before the threshold, on a 3–8° path ±20 m (at least 40 m above the threshold elevation). Up to ±60 m off the centreline (scaled with distance), heading ±15°, 80–110 km/h. Wind 0–12 kt from any direction; ridge lift on.
- **Extra observations:** distance to the aim point (150 m past the threshold), cross-track, heading error (sin/cos), headwind and crosswind (a windsock), height above the threshold.
- **Rewards:**
  - Shaping: Φ(s′) − Φ(s), with Φ = −(|along − aim| + 2·|cross|)/500. It is potential-based, so the optimal policy is unchanged.
  - Stopped on the ground: +50, plus a runway bonus of +50 − 20·|cross|/15, minus 10 per m/s of touchdown sink rate above 1 m/s.
  - Crash: −100. A crash is wing structure contact, a touchdown sink rate over 3 m/s, a nose strike, or more than 60° of bank below 20 m.
- **Out of bounds** is truncated. Touchdown sink is the last airborne value before the main wheel's first contact, sampled every physics batch.

### `aerotow`

On runway 07 behind FG's drag robot (ported in M5); up to 600 s.

- **Start (per seed):** wind 0–8 kt, and the tug's seeded legs and turns.
- **Extra action:** `release` (> 0.5 opens the hook).
- **Extra observations:**
  - the tug's hitch relative to ours, in body axes, and its relative velocity;
  - the rope force as a fraction of the weak link, and the rope distance relative to its length;
  - the tug's roll, whether it is airborne, and its relative heading (sin/cos);
  - whether we are still on tow.
- **Rewards:**
  - Each step: 0.1·exp(−(cross² + vertical²)/15²) for the high-tow position (8 m above the tug once it is airborne). −0.05 above 70 % of the weak link; −0.02 when slack.
  - +100 when the tug releases the glider.
  - Released by the agent: +100·min(1, height gained / 800 m) if at least 300 m was gained, otherwise −50.
  - Failure: −100. A failure is a broken weak link, structure contact, more than 70° of bank, or touching down again while on tow.

## Results

One core of the cloud container, Node 22:

| Run | Outcome | Mean return | Speed |
|---|---|---|---|
| landing, baseline, 20 seeds | 18 landed on the runway, 2 off it | 93.5 | **382× real time** (3820 decisions/s) |
| landing, random, 20 seeds | 14 crashed, 6 off the runway | −58.4 | 340× |
| aerotow, baseline, 6 seeds | 6 towed to the tug's release (815–1055 m gained) | 327.5 | **306×** |
| Python client over the pipe | bit-identical repeat of a seed | — | ≈ 100× (JSON round trip per step) |

Tests (`apps/headless/test/gym.test.ts`):
- Observations stay within the declared box.
- Determinism across unrelated episodes, for both tasks.
- The landing baseline lands at least 7 of 8 seeds on the runway with touchdown sink below 2 m/s, and beats random control by more than 100.
- The aerotow baseline is towed to the tug's release on 3 seeds.
- Releasing on the ground is penalized, and random control loses.
- Speed is above 100× real time.

## Findings

- **JSBSim instance reuse is not bit-deterministic.** After `ResetToInitialConditions`, an episode matched a fresh instance only to about 1e-13, and chaotic flight amplifies that. Two fresh instances are bit-identical, and creating one costs about 20 ms, so the env does that.
- **Lazy terrain loading breaks determinism.** `heightAt` starts tile downloads, and their completion time would leak into later episodes. Hence the preload-then-freeze.
- **The aerotow baseline needed speed management.** Without the airbrake, the glider overran the tug in its turns: slack rope, then a sideways jerk into an excessive bank. That is a useful hint for reward design and curricula.
- **An outlanding counts as a landing (+50)** without the runway bonus. A random agent occasionally collects it, which seems the right ordering: crash < outlanding < runway landing.

## Next

- M7: Web MIDI controls and head tracking in the browser.
- For training at scale: a batched multi-env server (several envs per process, to amortize the JSON round trip), a winch-launch task and a soaring task (thermal centring) on the same base, and curricula over the start distributions.
