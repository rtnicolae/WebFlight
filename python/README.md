# Python client

`webflight_gym.py` drives the TypeScript gym (`apps/headless/src/cli/gym-server.ts`) over
stdio. It needs Node and the repository installed (`pnpm install`, and the ASK21 is fetched
on first use), plus numpy. With `gymnasium` installed, `WebFlightEnv` is a `gymnasium.Env`.

```sh
python3 python/webflight_gym.py landing   # random actions, determinism check, speed
```

See `docs/milestone-6.md` for the tasks, observations, actions and rewards.
