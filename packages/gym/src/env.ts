/**
 * A Gymnasium-style environment around one glider:
 *   const env = await GliderEnv.make({ task, aircraft, … });
 *   let { obs } = await env.reset(seed);
 *   for (;;) { const r = env.step(action); if (r.terminated || r.truncated) break; }
 *
 * Each episode happens at an airfield and in weather drawn from data (sites.ts): wind,
 * ridge lift and thermals come from that weather and the terrain, as in the browser sim.
 *
 * Determinism: every reset builds a fresh JSBSim instance (≈ 20 ms), the site and the
 * episode's randomness come from generators seeded by the reset seed, and terrain is
 * preloaded around the site and frozen, so the same seed and the same actions give
 * bit-identical observations and rewards.
 */
import { applyEnvironment, Environment, mulberry32, type TerrariumTerrain } from "@webflight/environment";
import { RunwayFrame } from "./common.ts";
import type { GymSite, SitePicker } from "./sites.ts";
import { controlsToJsbsim, Fdm, FdmError, LBS_PER_KG, P, type AircraftFiles, type AirbrakeRoute, type FdmOptions } from "@webflight/fdm-core";
import type { BoxSpec, Episode, StepResult, Task } from "./types.ts";

export interface GliderEnvOptions {
  task: Task;
  aircraft: AircraftFiles;
  /** Pointmass index → kg. */
  loadoutKg: Record<number, number>;
  airbrake: AirbrakeRoute;
  /** Where episodes happen: dataSites(…) (random airfields and weather) or fixedSite(…). */
  sites: SitePicker;
  /** Real terrain (preloaded around each episode's runway and frozen), or none: the ellipsoid. */
  terrain?: TerrariumTerrain;
  /** Thermals from the weather (default on). */
  thermals?: boolean;
  /** Agent decisions per second (action repeat = 120 / decisionHz FDM steps). */
  decisionHz?: number;
  /** FDM steps between environment/launch updates. */
  physicsBatch?: number;
  fdm?: FdmOptions;
}

export class GliderEnv {
  readonly observation: BoxSpec;
  readonly action: BoxSpec;
  private ep: Episode | undefined;
  private fdm: Fdm | undefined;
  private readonly obsBuf: Float64Array;
  private siteGroundM = 0;
  private loadedSite = "";
  /** Simulated seconds and FDM steps over the env's lifetime (for speed reports). */
  simSeconds = 0;

  private constructor(private readonly o: GliderEnvOptions) {
    this.observation = o.task.observation;
    this.action = o.task.action;
    this.obsBuf = new Float64Array(this.observation.names.length);
  }

  static async make(o: GliderEnvOptions): Promise<GliderEnv> {
    return new GliderEnv(o);
  }

  /** Terrain around a site, loaded once per site and frozen (no loads during an episode). */
  private async prepareTerrain(site: GymSite): Promise<void> {
    const t = this.o.terrain;
    const key = `${site.ident}/${site.runway.name}`;
    if (!t || key === this.loadedSite) return;
    t.frozen = false;
    await t.load(site.runway.latDeg, site.runway.lonDeg, this.o.task.terrainRadiusM);
    this.siteGroundM = await t.heightAtAsync(site.runway.latDeg, site.runway.lonDeg);
    t.frozen = true;
    this.loadedSite = key;
  }

  get task(): Task {
    return this.o.task;
  }

  /** The current episode (for inspection, rendering, scripted policies that need truth). */
  get episode(): Episode | undefined {
    return this.ep;
  }

  async reset(seed = 0): Promise<{ obs: Float64Array; info: Record<string, unknown> }> {
    const site = await this.o.sites(mulberry32((seed ^ 0x5bd1e995) >>> 0));
    await this.prepareTerrain(site);
    this.fdm?.destroy();
    const fdm = await Fdm.create(this.o.fdm ?? {});
    this.fdm = fdm;
    fdm.load(this.o.aircraft);
    for (const [i, kg] of Object.entries(this.o.loadoutKg)) fdm.set(P.pointmassWeightLbs(Number(i)), kg * LBS_PER_KG);
    fdm.runIc();
    const terrain = this.o.terrain;
    const fallback = this.siteGroundM;
    const hz = this.o.decisionHz ?? 10;
    const repeat = Math.max(1, Math.round(1 / (hz * fdm.dt)));
    const w = site.weather, aloft = w.aloft[0];
    const ep: Episode = {
      fdm,
      site,
      runway: new RunwayFrame(site.runway, site.runway.headingDeg, site.runway.lengthM, site.runway.widthM),
      environment: new Environment(
        {
          windFromDeg: w.windFromDeg,
          windKt: w.windKt,
          ...(aloft ? { aloftFromDeg: aloft.fromDeg, aloftKt: aloft.kt } : {}),
          ridgeLift: !!terrain,
          thermalSky: this.o.thermals !== false && terrain ? { seed: seed >>> 0, weather: w } : false,
        },
        terrain,
      ),
      terrain,
      groundAt: (lat, lon) => (terrain ? (terrain.heightAt(lat, lon) ?? fallback) : 0),
      controls: { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0 },
      launch: undefined,
      applyControls: () => this.applyControls(),
      rand: mulberry32(seed >>> 0),
      t: 0,
      steps: 0,
      dt: repeat * fdm.dt,
      state: { repeat },
    };
    this.ep = ep;
    this.o.task.setup(ep);
    this.applyControls();
    this.o.task.observe(ep, this.obsBuf);
    return { obs: Float64Array.from(this.obsBuf), info: { seed, site: { ident: site.ident, name: site.name, runway: site.runway.name, weather: { source: w.source, timeUtc: w.timeUtc, windFromDeg: w.windFromDeg, windKt: w.windKt } }, ...ep.state } };
  }

  private applyControls(): void {
    const ep = this.ep!;
    for (const [p, v] of Object.entries(controlsToJsbsim(ep.controls, this.o.airbrake))) ep.fdm.set(p, v);
  }

  step(action: readonly number[]): StepResult {
    const ep = this.ep;
    if (!ep) throw new Error("reset() first");
    const a = this.action.low.map((lo, i) => {
      const v = Number(action[i] ?? 0);
      return Math.max(lo, Math.min(this.action.high[i]!, Number.isFinite(v) ? v : 0));
    });
    this.o.task.act(ep, a);
    const repeat = ep.state["repeat"] as number;
    const batch = Math.max(1, Math.min(repeat, this.o.physicsBatch ?? 4));
    let done = 0;
    try {
      while (done < repeat) {
        const n = Math.min(batch, repeat - done);
        const dt = n * ep.fdm.dt;
        applyEnvironment(ep.environment, ep.fdm, dt);
        this.o.task.physics?.(ep, dt);
        this.applyControls();
        ep.fdm.step(n);
        done += n;
      }
    } catch (e) {
      if (!(e instanceof FdmError)) throw e;
      ep.t += done * ep.fdm.dt;
      this.simSeconds += done * ep.fdm.dt;
      this.o.task.observe(ep, this.obsBuf);
      return { obs: Float64Array.from(this.obsBuf), reward: -100, terminated: true, truncated: false, info: { outcome: "fdm_error", error: e.message } };
    }
    ep.t += ep.dt;
    ep.steps++;
    this.simSeconds += ep.dt;
    const ev = this.o.task.evaluate(ep);
    const truncated = ev.truncated || (!ev.terminated && ep.t >= this.o.task.maxSeconds);
    this.o.task.observe(ep, this.obsBuf);
    return { obs: Float64Array.from(this.obsBuf), reward: ev.reward, terminated: ev.terminated, truncated, info: { ...ev.info, ...(truncated && !ev.truncated ? { outcome: "time_limit" } : {}), t: ep.t } };
  }

  close(): void {
    this.fdm?.destroy();
    this.fdm = undefined;
    this.ep = undefined;
  }
}
