"""
WebFlight gym client: runs the TypeScript gym server (apps/headless, JSBSim in WebAssembly)
as a subprocess and talks JSON lines over its stdin/stdout.

    from webflight_gym import WebFlightEnv
    env = WebFlightEnv("landing")            # or "aerotow"
    obs, info = env.reset(seed=0)
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())

If `gymnasium` is installed, WebFlightEnv is a gymnasium.Env with Box spaces (so vector
envs and RL libraries work); otherwise it offers the same methods with a minimal Box.
Requires Node and pnpm-installed repo dependencies; numpy is required.
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Any

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:  # optional
    import gymnasium
    from gymnasium import spaces

    _Base = gymnasium.Env

    def _box(low, high):
        return spaces.Box(low=np.asarray(low, np.float64), high=np.asarray(high, np.float64), dtype=np.float64)

except ImportError:  # pragma: no cover - exercised when gymnasium is absent
    _Base = object

    class _MiniBox:
        def __init__(self, low, high):
            self.low = np.asarray(low, np.float64)
            self.high = np.asarray(high, np.float64)
            self.shape = self.low.shape
            self.dtype = np.float64
            self._rng = np.random.default_rng()

        def sample(self):
            return self._rng.uniform(self.low, self.high)

        def contains(self, x):
            x = np.asarray(x)
            return x.shape == self.shape and bool(np.all(x >= self.low) and np.all(x <= self.high))

    def _box(low, high):
        return _MiniBox(low, high)


class WebFlightEnv(_Base):  # type: ignore[misc]
    metadata = {"render_modes": []}

    def __init__(self, task: str = "landing", decision_hz: float = 10, loadout: str = "solo", repo: str = REPO, node_cmd: list[str] | None = None):
        cmd = node_cmd or ["npx", "tsx", os.path.join(repo, "apps/headless/src/cli/gym-server.ts")]
        self._proc = subprocess.Popen(cmd, cwd=os.path.join(repo, "apps/headless"), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        spec = self._call({"cmd": "make", "task": task, "decision_hz": decision_hz, "loadout": loadout})
        self.task = spec["task"]
        self.max_seconds = spec["max_seconds"]
        self.observation_names: list[str] = spec["observation"]["names"]
        self.action_names: list[str] = spec["action"]["names"]
        self.observation_space = _box(spec["observation"]["low"], spec["observation"]["high"])
        self.action_space = _box(spec["action"]["low"], spec["action"]["high"])

    def _call(self, msg: dict[str, Any]) -> dict[str, Any]:
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("gym server exited")
        r = json.loads(line)
        if "error" in r:
            raise RuntimeError(r["error"])
        return r

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        # As gymnasium's convention: a seed is used as given and also starts the sequence later
        # unseeded resets draw from (reset(seed=s), reset(), reset() repeats exactly); never
        # seeded, they draw from fresh entropy. (Unseeded resets all sent 0: every episode the same.)
        if _Base is not object:
            super().reset(seed=seed)
        if seed is not None:
            self._seeds = np.random.default_rng(int(seed))
            episode_seed = int(seed)
        else:
            if getattr(self, "_seeds", None) is None:
                self._seeds = np.random.default_rng()
            episode_seed = int(self._seeds.integers(0, 2**31 - 1))
        r = self._call({"cmd": "reset", "seed": episode_seed})
        info = dict(r["info"])
        info.setdefault("seed", episode_seed)
        return np.asarray(r["obs"], np.float64), info

    def step(self, action):
        r = self._call({"cmd": "step", "action": [float(a) for a in np.asarray(action, np.float64).ravel()]})
        return np.asarray(r["obs"], np.float64), float(r["reward"]), bool(r["terminated"]), bool(r["truncated"]), r["info"]

    def close(self):
        if self._proc.poll() is None:
            try:
                self._call({"cmd": "close"})
            except RuntimeError:
                pass
            self._proc.wait(timeout=10)


if __name__ == "__main__":  # smoke run: random actions, then the same seed again
    import sys
    import time

    env = WebFlightEnv(sys.argv[1] if len(sys.argv) > 1 else "landing")
    print(env.task, len(env.observation_names), "observations:", env.observation_names)
    print("actions:", env.action_names)
    rng = np.random.default_rng(0)
    actions = [env.action_space.low + (env.action_space.high - env.action_space.low) * rng.random(env.action_space.shape) for _ in range(3000)]

    def run(seed):
        obs, info = env.reset(seed=seed)
        rows, total = [obs], 0.0
        for a in actions:
            obs, r, term, trunc, info = env.step(a)
            rows.append(obs)
            total += r
            if term or trunc:
                break
        return np.array(rows), total, info

    t0 = time.perf_counter()
    a, ra, ia = run(7)
    wall = time.perf_counter() - t0
    b, rb, _ = run(7)
    print(f"episode: {len(a) - 1} steps, return {ra:.1f}, outcome {ia.get('outcome')}, {ia['t']:.0f} s simulated in {wall:.2f} s ({ia['t'] / wall:.0f}x real time through the pipe)")
    print("same seed, same actions → identical:", bool(np.array_equal(a, b) and ra == rb))
    env.close()
