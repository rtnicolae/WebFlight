/**
 * FgHost: the parts of FlightGear around the FDM that aircraft rely on, in one object that
 * runs wherever the FDM runs (Web Worker or Node): property tree with /fdm/jsbsim mounted,
 * FDM interface, pitot/static systems, property rules, instruments, and aircraft scripts
 * (Nasal rewritten in TypeScript).
 *
 * Update order follows FlightGear's main loop: controls → FDM step → FDM outputs →
 * systems → property rules → instruments → script timers/interpolations.
 */
import { FdmInterface, type EnvironmentOptions, type FdmLike } from "./fdm-interface.ts";
import { buildInstrumentation } from "./instruments.ts";
import type { PNode } from "./plist.ts";
import { PropertyTree, type PropRef, type PropValue } from "./props.ts";
import { PropertyRules } from "./rules.ts";

/** Host configuration written by the converter (bundle host.json). */
export interface HostConfig {
  aircraft: string;
  setFile: string;
  /** The aircraft's merged -set.xml property tree (defaults), without /nasal and /input. */
  tree: PNode;
  /** /sim/systems/property-rule[n] and /sim/systems/autopilot[n] files, in index order. */
  propertyRules: { name: string; file: string; root: PNode }[];
  instrumentation?: PNode;
  systems?: PNode;
  /** Number of JSBSim ground contacts (gear/unit[n]). */
  gearCount: number;
}

export interface Timer {
  start(): void;
  stop(): void;
  restart(interval: number): void;
  readonly isRunning: boolean;
}

/** The Nasal-like API given to aircraft scripts. */
export interface ScriptApi {
  readonly tree: PropertyTree;
  readonly fdm: FdmLike;
  /** Simulated time [s] since start. */
  readonly time: number;
  getprop(path: string): PropValue | undefined;
  num(path: string): number;
  setprop(path: string, v: PropValue): void;
  node(path: string): PropRef;
  /** setlistener(path, fn, init, runtime): `changedOnly` = Nasal's runtime=0 behaviour. */
  setlistener(path: string, fn: (value: PropValue) => void, opts?: { initial?: boolean; changedOnly?: boolean }): () => void;
  /** maketimer(interval, fn): interval 0 = every frame. Simulated time. */
  maketimer(intervalSec: number, fn: () => void): Timer;
  settimer(fn: () => void, delaySec: number): void;
  /** interpolate(path, value, time, value, time, ...): linear ramps, like FG's interpolate(). */
  interpolate(path: string, ...steps: number[]): void;
  log(msg: string): void;
}

/** A Nasal module rewritten in TypeScript. */
export interface AircraftScript {
  readonly name: string;
  init(api: ScriptApi): void;
}

interface TimerEntry {
  interval: number;
  next: number;
  running: boolean;
  once: boolean;
  fn: () => void;
}

export interface HostOptions {
  scripts?: AircraftScript[];
  env?: EnvironmentOptions;
  warn?: (msg: string) => void;
  log?: (msg: string) => void;
}

export class FgHost {
  readonly tree = new PropertyTree();
  readonly warnings: string[] = [];
  private readonly fdmIf: FdmInterface;
  private readonly rules: PropertyRules[] = [];
  private readonly updateSystems: (dt: number) => void;
  private readonly updateInstruments: (dt: number) => void;
  private readonly timers: TimerEntry[] = [];
  private readonly ramps = new Map<string, { ref: PropRef; steps: [number, number][]; from: number; t0: number }>();
  private simTime = 0;
  readonly api: ScriptApi;

  constructor(
    readonly config: HostConfig,
    readonly fdm: FdmLike,
    opts: HostOptions = {},
  ) {
    const warn = (m: string) => {
      this.warnings.push(m);
      opts.warn?.(m);
    };
    // 1. JSBSim's tree under /fdm/jsbsim, like FlightGear.
    this.tree.mount("/fdm/jsbsim", {
      get: (rel) => {
        try {
          return fdm.get(rel);
        } catch {
          return undefined;
        }
      },
      set: (rel, v) => fdm.set(rel, v),
    });
    // 2. -set.xml defaults (with aliases), as FG loads them at startup.
    loadTree(this.tree, config.tree, "");
    this.tree.set("/sim/aircraft", config.aircraft);
    this.tree.init("/sim/flight-model", "jsb");
    // 3. FDM interface, systems, rules, instruments.
    this.fdmIf = new FdmInterface(this.tree, fdm, config.gearCount, opts.env);
    this.fdmIf.fromFdm();
    const inst = buildInstrumentation(this.tree, config.systems, config.instrumentation, warn);
    this.updateSystems = inst.updateSystems;
    this.updateInstruments = inst.updateInstruments;
    for (const r of config.propertyRules) this.rules.push(new PropertyRules(`${r.name} (${r.file})`, r.root, this.tree, warn));

    const self = this;
    this.api = {
      tree: this.tree,
      fdm,
      get time() {
        return self.simTime;
      },
      getprop: (p) => this.tree.get(p),
      num: (p) => this.tree.num(p),
      setprop: (p, v) => this.tree.set(p, v),
      node: (p) => this.tree.node(p),
      setlistener: (p, fn, o = {}) => this.tree.listen(p, (_r, v) => fn(v), { changedOnly: o.changedOnly ?? false, initial: o.initial ?? false }),
      maketimer: (interval, fn) => {
        const e: TimerEntry = { interval, next: 0, running: false, once: false, fn };
        this.timers.push(e);
        return {
          start: () => {
            e.running = true;
            e.next = this.simTime + e.interval;
          },
          stop: () => {
            e.running = false;
          },
          restart: (i: number) => {
            e.interval = i;
            e.running = true;
            e.next = this.simTime + i;
          },
          get isRunning() {
            return e.running;
          },
        };
      },
      settimer: (fn, delay) => {
        this.timers.push({ interval: delay, next: this.simTime + delay, running: true, once: true, fn });
      },
      interpolate: (p, ...steps) => {
        const ref = this.tree.node(p);
        const pairs: [number, number][] = [];
        for (let i = 0; i + 1 < steps.length; i += 2) pairs.push([steps[i]!, steps[i + 1]!]);
        if (pairs.length === 0) return;
        this.ramps.set(ref.path, { ref, steps: pairs, from: ref.num(), t0: this.simTime });
      },
      log: (m) => opts.log?.(m),
    };
    for (const s of opts.scripts ?? []) {
      try {
        s.init(this.api);
      } catch (e) {
        warn(`script ${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.tree.set("/sim/signals/fdm-initialized", true);
  }

  /** FG controls → JSBSim. Call before stepping the FDM. */
  preStep(): void {
    this.fdmIf.toFdm();
  }

  /** Everything after the FDM step(s) covering `dt` seconds. */
  update(dt: number): void {
    if (dt <= 0) return;
    this.simTime += dt;
    this.tree.set("/sim/time/elapsed-sec", this.simTime);
    this.tree.set("/sim/time/delta-sec", dt);
    this.tree.set("/environment/gravitational-acceleration-mps2", this.fdm.get("accelerations/gravity-ft_sec2") * 0.3048);
    this.fdmIf.fromFdm();
    this.updateSystems(dt);
    for (const r of this.rules) r.update(dt);
    this.updateInstruments(dt);
    this.runTimers();
    this.runRamps();
  }

  private runTimers(): void {
    for (let i = 0; i < this.timers.length; i++) {
      const t = this.timers[i]!;
      if (!t.running || this.simTime + 1e-9 < t.next) continue;
      t.next = this.simTime + t.interval;
      if (t.once) {
        t.running = false;
        this.timers.splice(i--, 1);
      }
      t.fn();
    }
  }

  private runRamps(): void {
    for (const [k, r] of this.ramps) {
      let t = this.simTime - r.t0;
      let from = r.from;
      let done = true;
      for (const [target, dur] of r.steps) {
        if (t < dur) {
          r.ref.set(from + (target - from) * (dur > 0 ? t / dur : 1));
          done = false;
          break;
        }
        t -= dur;
        from = target;
      }
      if (done) {
        r.ref.set(r.steps[r.steps.length - 1]![0]);
        this.ramps.delete(k);
      }
    }
  }
}

function leafValue(p: PNode): PropValue {
  const v = (p.v ?? "").trim();
  switch ((p.t ?? "").toLowerCase()) {
    case "bool": return v === "true" || (v !== "" && v !== "false" && Number(v) !== 0);
    case "int": case "long": case "double": case "float": return Number(v) || 0;
    case "string": return p.v ?? "";
  }
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

function loadTree(tree: PropertyTree, p: PNode, path: string): void {
  for (const c of p.c ?? []) {
    const cp = `${path}/${c.n}${c.i ? `[${c.i}]` : ""}`;
    if (c.a) tree.alias(cp, c.a);
    else if (c.c?.length) loadTree(tree, c, cp);
    else if (c.v !== undefined) tree.set(cp, leafValue(c));
  }
}
