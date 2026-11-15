import { beforeAll, describe, expect, it } from "vitest";
import { airfieldAt, estimateWeather, mulberry32, type Weather } from "@webflight/environment";
import { aerotowBaseline, fixedSite, landingBaseline, randomPolicy, type GliderEnv, type Policy, type SitePicker, type StepResult } from "@webflight/gym";
import { ASK21, ensureAircraft } from "../src/gliders.ts";
import { makeGym } from "../src/gym.ts";

/** Grenchen (LSZG) runway 06/24 from the data, in a light south-westerly without thermals. */
async function grenchen(): Promise<SitePicker> {
  const lszg = (await airfieldAt("LSZG", 47.18, 7.42))!;
  const calm = estimateWeather(lszg.latDeg, lszg.lonDeg, new Date("2026-07-15T22:00:00Z"), lszg.elevM);
  const w: Weather = { ...calm, windFromDeg: 240, windKt: 6, aloft: calm.aloft.map((l) => ({ ...l, fromDeg: 240, kt: 9 })) };
  return fixedSite(lszg, w);
}

async function episode(env: GliderEnv, seed: number, policy: Policy, record?: number[][]) {
  let { obs } = await env.reset(seed);
  let total = 0;
  let r: StepResult;
  for (;;) {
    r = env.step(policy(obs));
    total += r.reward;
    obs = r.obs;
    record?.push([...obs, r.reward]);
    if (r.terminated || r.truncated) break;
  }
  return { total, info: r.info, steps: record?.length };
}

describe("gym: landing (Grenchen from the data, randomized final)", () => {
  let env: GliderEnv;
  beforeAll(async () => {
    await ensureAircraft(ASK21);
    env = await makeGym("landing", { sites: await grenchen() });
  }, 300_000);

  it("describes its spaces, and observations stay inside them", async () => {
    expect(env.observation.names.length).toBe(23);
    expect(env.action.names).toEqual(["aileron", "elevator", "rudder", "airbrake"]);
    const rec: number[][] = [];
    await episode(env, 3, landingBaseline(), rec);
    for (const row of rec) row.slice(0, -1).forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(env.observation.low[i]!);
      expect(v).toBeLessThanOrEqual(env.observation.high[i]!);
    });
  }, 60_000);

  it("is deterministic: same seed and actions → bit-identical observations and rewards, regardless of history", async () => {
    const a: number[][] = [], b: number[][] = [];
    await episode(env, 11, landingBaseline(), a);
    await episode(env, 5, randomPolicy(env.action.low, env.action.high, mulberry32(1))); // something else in between
    await episode(env, 11, landingBaseline(), b);
    expect(b).toEqual(a);
    const c: number[][] = [];
    await episode(env, 12, landingBaseline(), c);
    expect(c[0]).not.toEqual(a[0]);
  }, 120_000);

  it("the scripted baseline lands on the runway; random control crashes", async () => {
    const base = [], rand = [];
    for (let seed = 100; seed < 108; seed++) {
      base.push(await episode(env, seed, landingBaseline()));
      rand.push(await episode(env, seed, randomPolicy(env.action.low, env.action.high, mulberry32(seed))));
    }
    expect(base.filter((e) => e.info["outcome"] === "landed").length).toBeGreaterThanOrEqual(7);
    for (const e of base.filter((e) => e.info["outcome"] === "landed")) expect(e.info["touchdownSinkMs"] as number).toBeLessThan(2);
    const mean = (xs: { total: number }[]) => xs.reduce((s, x) => s + x.total, 0) / xs.length;
    expect(mean(base)).toBeGreaterThan(80);
    expect(mean(base) - mean(rand)).toBeGreaterThan(100);
  }, 300_000);

  it("runs many times faster than real time", async () => {
    const sim0 = env.simSeconds, t0 = performance.now();
    for (let seed = 200; seed < 204; seed++) await episode(env, seed, landingBaseline());
    const factor = (env.simSeconds - sim0) / ((performance.now() - t0) / 1000);
    expect(factor).toBeGreaterThan(100);
  }, 120_000);
});

describe("gym: aerotow take-off", () => {
  let env: GliderEnv;
  beforeAll(async () => {
    env = await makeGym("aerotow", { sites: await grenchen() });
  }, 300_000);

  it("the scripted baseline stays on tow until the tug releases it 800 m up", async () => {
    for (const seed of [0, 1, 2]) {
      const e = await episode(env, seed, aerotowBaseline());
      expect(e.info["outcome"]).toBe("towed");
      expect(e.info["gainM"] as number).toBeGreaterThan(780);
      expect(e.total).toBeGreaterThan(200);
    }
  }, 300_000);

  it("releasing at once on the ground is penalized; random control fails", async () => {
    const early = await episode(env, 0, () => [0, 0, 0, 0, 1]);
    expect(early.info["outcome"]).toBe("released_low");
    expect(early.total).toBeLessThan(0);
    const r = await episode(env, 0, randomPolicy(env.action.low, env.action.high, mulberry32(3)));
    expect(r.total).toBeLessThan(0);
  }, 120_000);

  it("is deterministic", async () => {
    const a: number[][] = [], b: number[][] = [];
    const run = async (rec: number[][]) => {
      let { obs } = await env.reset(4);
      const pol = aerotowBaseline();
      for (let i = 0; i < 600; i++) {
        const r = env.step(pol(obs));
        obs = r.obs;
        rec.push([...obs, r.reward]);
        if (r.terminated || r.truncated) break;
      }
    };
    await run(a);
    await run(b);
    expect(b).toEqual(a);
  }, 120_000);
});

describe("gym: sites from data", () => {
  let env: GliderEnv;
  beforeAll(async () => {
    env = await makeGym("landing");
  }, 300_000);

  it("draws airfields and weather by seed, reproducibly, and lands at them", async () => {
    const sites = new Set<string>();
    for (const seed of [1, 2, 3]) {
      const a = await env.reset(seed);
      const site = a.info["site"] as { ident: string; runway: string; weather: { source: string } };
      sites.add(site.ident);
      expect(site.weather.source).toMatch(/forecast|archive|estimated/);
      const b = await env.reset(seed);
      expect(b.obs).toEqual(a.obs);
      expect(b.info["site"]).toEqual(site);
    }
    expect(sites.size).toBeGreaterThan(1);
    const e = await episode(env, 2, landingBaseline());
    expect(["landed", "landed_off_runway", "crashed", "out_of_bounds", "time_limit"]).toContain(e.info["outcome"]);
  }, 300_000);
});
