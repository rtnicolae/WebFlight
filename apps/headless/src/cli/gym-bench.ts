/**
 * Usage: gym-bench [task] [episodes] [baseline|random]
 * Runs episodes in-process and reports outcomes, mean return and speed (× real time).
 */
import { mulberry32 } from "@webflight/environment";
import { aerotowBaseline, landingBaseline, randomPolicy } from "@webflight/gym";
import { makeGym } from "../gym.ts";

const [task = "landing", nArg = "20", which = "baseline"] = process.argv.slice(2);
const env = await makeGym(task);
const n = Number(nArg);
const outcomes: Record<string, number> = {};
let total = 0, steps = 0;
const t0 = performance.now(), sim0 = env.simSeconds;
for (let seed = 0; seed < n; seed++) {
  const policy = which === "random" ? randomPolicy(env.action.low, env.action.high, mulberry32(seed + 1000)) : task === "aerotow" ? aerotowBaseline() : landingBaseline();
  let { obs } = await env.reset(seed);
  for (;;) {
    const r = env.step(policy(obs));
    obs = r.obs;
    total += r.reward;
    steps++;
    if (r.terminated || r.truncated) {
      const o = String(r.info["outcome"]);
      outcomes[o] = (outcomes[o] ?? 0) + 1;
      break;
    }
  }
}
const wall = (performance.now() - t0) / 1000, sim = env.simSeconds - sim0;
console.log(`${task} · ${which} · ${n} episodes: ${JSON.stringify(outcomes)}, mean return ${(total / n).toFixed(1)}`);
console.log(`${sim.toFixed(0)} s simulated in ${wall.toFixed(1)} s: ${(sim / wall).toFixed(0)}× real time, ${(steps / wall).toFixed(0)} decisions/s (one core)`);
env.close();
