/**
 * FlightGear property rules / autopilot components (src/Autopilot/*), driven by the
 * PropertyList JSON of a property-rule file. Supported: <filter> (gain, exponential,
 * double-exponential, moving-average, noise-spike, rate-limit, reciprocal, derivative,
 * integrator, high-pass, lead-lag), <logic>, <pi-simple-controller>, <pid-controller>.
 */
import { compileCondition, compileValue, ValueList, type BoolFn, type CompileContext } from "./expr.ts";
import { kid, kids, kidBool, kidText, parseBool, text, type PNode } from "./plist.ts";
import type { PropRef, PropertyTree } from "./props.ts";

abstract class Component {
  name: string;
  protected enabledBefore = false;
  private enable: BoolFn = () => true;
  private interval = 0;
  private acc = 0;

  constructor(protected readonly cfg: PNode, protected readonly ctx: CompileContext) {
    this.name = kidText(cfg, "name") ?? cfg.n;
    this.interval = Number(kidText(cfg, "update-interval-secs") ?? 0) || 0;
    const en = kid(cfg, "enable");
    if (en) {
      const cond = kid(en, "condition");
      if (cond) this.enable = compileCondition(cond, ctx);
      else {
        const propPath = kidText(en, "property") ?? kidText(en, "prop");
        if (propPath) {
          const ref = ctx.tree.node(propPath);
          const val = kidText(en, "value");
          this.enable = val !== undefined ? () => ref.str() === val : () => ref.bool();
        }
      }
    }
  }

  update(dt: number): void {
    if (this.interval > 0) {
      this.acc += dt;
      if (this.acc < this.interval) return;
      dt = this.acc;
      this.acc = 0;
    }
    if (this.enable()) {
      const first = !this.enabledBefore;
      this.enabledBefore = true;
      this.step(first, dt);
    } else {
      this.enabledBefore = false;
    }
  }

  protected abstract step(first: boolean, dt: number): void;
}

/** AnalogComponent: <input>, <reference>, <min>/<u_min>, <max>/<u_max>, <period>, <output>. */
abstract class AnalogComponent extends Component {
  protected readonly input = new ValueList();
  protected readonly reference = new ValueList();
  protected readonly minV = new ValueList();
  protected readonly maxV = new ValueList();
  protected readonly outputs: PropRef[] = [];
  private periodMin: number | undefined;
  private periodMax: number | undefined;

  constructor(cfg: PNode, ctx: CompileContext) {
    super(cfg, ctx);
    for (const c of kids(cfg)) {
      switch (c.n) {
        case "input": this.input.items.push(compileValue(c, ctx)); break;
        case "reference": this.reference.items.push(compileValue(c, ctx)); break;
        case "min": case "u_min": this.minV.items.push(compileValue(c, ctx)); break;
        case "max": case "u_max": this.maxV.items.push(compileValue(c, ctx)); break;
        case "period":
          this.periodMin = Number(kidText(c, "min") ?? 0);
          this.periodMax = Number(kidText(c, "max") ?? 0);
          break;
        case "output": {
          const props = kids(c).filter((k) => k.n === "property" || k.n === "prop");
          if (props.length) for (const k of props) this.outputs.push(ctx.tree.node(text(k)));
          else if (text(c)) this.outputs.push(ctx.tree.node(text(c)));
          break;
        }
      }
    }
  }

  protected clamp(v: number): number {
    if (this.periodMin !== undefined && this.periodMax !== undefined) {
      const w = this.periodMax - this.periodMin;
      if (w > 0) v = ((((v - this.periodMin) % w) + w) % w) + this.periodMin;
    }
    if (this.minV.size + this.maxV.size > 0) {
      v = Math.min(v, this.maxV.get());
      v = Math.max(v, this.minV.get());
    }
    return v;
  }

  protected get outputValue(): number {
    return this.outputs.length ? this.clamp(this.outputs[0]!.num()) : 0;
  }

  protected setOutput(v: number): void {
    const c = this.clamp(v);
    for (const o of this.outputs) o.set(c);
  }
}

// ---------------------------------------------------------------------------------------
// Digital filters

class DigitalFilter extends AnalogComponent {
  private readonly type: string;
  private readonly gain = new ValueList(1);
  private readonly tf = new ValueList(1);
  private readonly tfb = new ValueList(1);
  private readonly samples = new ValueList(1);
  private readonly rateMax = new ValueList(1);
  private readonly rateMin = new ValueList(1);
  private readonly da = new ValueList(1);
  private readonly db = new ValueList(1);
  private readonly dc = new ValueList(1);
  private readonly initTo: "input" | "output" | "none";
  private out1 = 0;
  private out2 = 0;
  private in1 = 0;
  private queue: number[] = [];

  constructor(cfg: PNode, ctx: CompileContext) {
    super(cfg, ctx);
    this.type = (kidText(cfg, "type") ?? "").trim();
    for (const c of kids(cfg)) {
      switch (c.n) {
        case "gain": this.gain.items.push(compileValue(c, ctx, 1)); break;
        case "filter-time": case "filter-time-a": this.tf.items.push(compileValue(c, ctx, 1)); break;
        case "filter-time-b": this.tfb.items.push(compileValue(c, ctx, 1)); break;
        case "samples": this.samples.items.push(compileValue(c, ctx, 1)); break;
        case "max-rate-of-change": this.rateMax.items.push(compileValue(c, ctx, 1)); break;
        case "min-rate-of-change": this.rateMin.items.push(compileValue(c, ctx, 1)); break;
        case "a": this.da.items.push(compileValue(c, ctx, 1)); break;
        case "b": this.db.items.push(compileValue(c, ctx, 1)); break;
        case "c": this.dc.items.push(compileValue(c, ctx, 1)); break;
      }
    }
    const it = (kidText(cfg, "initialize-to") ?? "input").trim();
    this.initTo = it === "output" ? "output" : it === "none" ? "none" : "input";
    const known = ["damped-oscillation", "gain", "exponential", "double-exponential", "moving-average", "noise-spike", "rate-limit", "reciprocal", "derivative", "integrator", "high-pass", "lead-lag"];
    if (!known.includes(this.type)) ctx.warn(`filter type "${this.type}" not supported (${this.name})`);
  }

  private initialize(v: number): void {
    this.out1 = this.out2 = this.in1 = v;
    this.queue = [];
  }

  protected step(first: boolean, dt: number): void {
    if (first) {
      if (this.initTo === "input") this.initialize(this.input.get());
      else if (this.initTo === "output") this.initialize(this.outputValue);
    }
    const input = this.input.get() - this.reference.get();
    this.setOutput(this.compute(dt, input));
  }

  private compute(dt: number, input: number): number {
    const g = () => this.gain.get();
    switch (this.type) {
      case "gain": return g() * input;
      case "reciprocal": return Math.abs(input) <= Number.MIN_VALUE ? Number.MAX_VALUE : g() / input;
      case "derivative": {
        const out = dt > 0 ? ((input - this.in1) * this.tf.get() * g()) / dt : 0;
        this.in1 = input;
        return out;
      }
      case "exponential":
      case "double-exponential": {
        const x = g() * input;
        const tf = this.tf.get();
        const alpha = tf > 0 ? 1 / (tf / dt + 1) : 1;
        const out = this.type === "double-exponential" ? alpha * alpha * x + 2 * (1 - alpha) * this.out1 - (1 - alpha) * (1 - alpha) * this.out2 : alpha * x + (1 - alpha) * this.out1;
        this.out2 = this.out1;
        return (this.out1 = out);
      }
      case "moving-average": {
        const n = Math.max(1, Math.round(this.samples.get()));
        if (this.queue.length !== n) {
          const shrunk = this.queue.length > n;
          while (this.queue.length < n) this.queue.push(this.out1);
          this.queue.length = n;
          if (shrunk) this.out1 = this.queue.reduce((a, b) => a + b, 0) / n;
        }
        const out = this.out1 + (input - this.queue[n - 1]!) / n;
        this.out1 = out;
        this.queue.pop();
        this.queue.unshift(input);
        return out;
      }
      case "noise-spike": {
        const delta = input - this.out1;
        if (Math.abs(delta) <= Number.MIN_VALUE) return input;
        const maxChange = this.rateMax.get() * dt;
        if (Math.abs(delta) <= maxChange) return (this.out1 = input);
        return (this.out1 = this.out1 + Math.sign(delta) * maxChange);
      }
      case "rate-limit": {
        const delta = input - this.out1;
        if (Math.abs(delta) <= Number.MIN_VALUE) return input;
        let out = input;
        if (delta >= this.rateMax.get() * dt) out = this.out1 + this.rateMax.get() * dt;
        if (delta <= this.rateMin.get() * dt) out = this.out1 + this.rateMin.get() * dt;
        return (this.out1 = out);
      }
      case "integrator": {
        let out = this.out1 + input * g() * dt;
        if (this.maxV.size) out = Math.min(out, this.maxV.get());
        if (this.minV.size) out = Math.max(out, this.minV.get());
        this.in1 = input;
        return (this.out1 = out);
      }
      case "high-pass": {
        // y[n] = a*(y[n-1] + x[n] - x[n-1]),  a = tf/(tf+dt)
        const x = g() * input;
        const tf = this.tf.get();
        const a = tf / (tf + dt);
        const out = a * (this.out1 + x - this.in1);
        this.in1 = x;
        return (this.out1 = out);
      }
      case "lead-lag": {
        // (s*Ta + 1)/(s*Tb + 1), backward Euler.
        const x = g() * input;
        const ta = this.tf.get(), tb = this.tfb.get();
        const out = (x * (ta + dt) - this.in1 * ta + this.out1 * tb) / (tb + dt);
        this.in1 = x;
        return (this.out1 = out);
      }
      case "damped-oscillation": {
        // x0/x1/x2 = out1/in1/out2 slots (DampedOscillationFilterImplementation).
        if (Math.abs(input) > 1e-15) {
          const dz = dt * input;
          this.out1 = this.in1 - dz;
          this.out2 = this.in1 + dz;
        } else {
          const a = this.da.get(), b = this.db.get(), c = this.dc.get();
          this.out1 = (this.in1 * (2 + dt * (a - b * dt)) - this.out2 - c * dt * dt) / (1 + a * dt);
          this.out2 = this.in1;
          this.in1 = this.out1;
        }
        return this.out1;
      }
      default:
        return input;
    }
  }
}

class PiSimpleController extends AnalogComponent {
  private readonly kp = new ValueList();
  private readonly ki = new ValueList();
  private intSum = 0;
  constructor(cfg: PNode, ctx: CompileContext) {
    super(cfg, ctx);
    for (const c of kids(cfg)) {
      if (c.n === "Kp") this.kp.items.push(compileValue(c, ctx));
      if (c.n === "Ki") this.ki.items.push(compileValue(c, ctx));
    }
  }
  protected step(first: boolean, dt: number): void {
    if (first) this.intSum = 0;
    const err = this.reference.get() - this.input.get();
    const prop = this.clamp(err * this.kp.get());
    this.intSum += err * this.ki.get() * dt;
    const out = prop + this.intSum;
    const c = this.clamp(out);
    if (out !== c) this.intSum = c - prop;
    this.setOutput(c);
  }
}

/** Velocity-form PID (FlightGear's pid-controller with Kp, Ti, Td, beta, alpha, gamma). */
class PidController extends AnalogComponent {
  private readonly p: Record<string, ValueList> = {};
  private ep1 = 0;
  private edf1 = 0;
  private edf2 = 0;
  private un1 = 0;
  constructor(cfg: PNode, ctx: CompileContext) {
    super(cfg, ctx);
    const config = kid(cfg, "config") ?? cfg;
    for (const [name, def] of [["Kp", 0], ["Ti", 0], ["Td", 0], ["beta", 1], ["alpha", 0.1], ["gamma", 0]] as const) {
      const l = (this.p[name] = new ValueList(def));
      for (const c of kids(config, name)) l.items.push(compileValue(c, ctx));
    }
  }
  protected step(first: boolean, dt: number): void {
    const v = (n: string) => this.p[n]!.get();
    const yn = this.input.get(), rn = this.reference.get();
    if (first) {
      this.ep1 = this.edf1 = this.edf2 = 0;
      this.un1 = this.outputValue;
    }
    const Kp = v("Kp"), Ti = v("Ti"), Td = v("Td"), beta = v("beta"), alpha = v("alpha"), gamma = v("gamma");
    if (dt <= 0 || Ti <= 0) return;
    const ep = beta * rn - yn;
    const e = rn - yn;
    const ed = gamma * rn - yn;
    const Tf = alpha * Td;
    const edf = Tf > 0 ? this.edf1 / (dt / Tf + 1) + ed * (dt / Tf) / (dt / Tf + 1) : ed;
    const dun = Kp * (ep - this.ep1 + (dt / Ti) * e + (Td / dt) * (edf - 2 * this.edf1 + this.edf2));
    const un = this.clamp(this.un1 + dun);
    this.ep1 = ep;
    this.edf2 = this.edf1;
    this.edf1 = edf;
    this.un1 = un;
    this.setOutput(un);
  }
}

/** <logic>: output(s) = first input condition (optionally inverted). */
class Logic extends Component {
  private readonly input: BoolFn;
  private readonly outputs: { ref: PropRef; inverted: boolean }[] = [];
  private readonly inverted: boolean;
  constructor(cfg: PNode, ctx: CompileContext) {
    super(cfg, ctx);
    const inp = kid(cfg, "input");
    this.input = inp ? compileCondition(inp, ctx) : () => false;
    this.inverted = kidBool(cfg, "inverted", false);
    for (const o of kids(cfg, "output")) {
      const path = o.c?.length ? kidText(o, "property") : text(o);
      if (path) this.outputs.push({ ref: ctx.tree.node(path), inverted: kidText(o, "inverted") !== undefined && parseBool(kidText(o, "inverted")!) });
    }
  }
  protected step(): void {
    let v = this.input();
    if (this.inverted) v = !v;
    for (const o of this.outputs) o.ref.set(o.inverted ? !v : v);
  }
}

const FACTORY: Record<string, new (cfg: PNode, ctx: CompileContext) => Component> = {
  filter: DigitalFilter,
  "pi-simple-controller": PiSimpleController,
  "pid-controller": PidController,
  logic: Logic,
};

/** One property-rule (or autopilot) file. Components update in document order. */
export class PropertyRules {
  private readonly components: Component[] = [];
  constructor(readonly name: string, root: PNode, tree: PropertyTree, warn: (m: string) => void = () => {}) {
    const ctx: CompileContext = { tree, warn: (m) => warn(`${name}: ${m}`) };
    for (const c of kids(root)) {
      const F = FACTORY[c.n];
      if (F) this.components.push(new F(c, ctx));
      else if (!["params", "name", "update-interval-secs", "path", "debug"].includes(c.n)) ctx.warn(`component <${c.n}> not supported`);
    }
  }
  get size(): number {
    return this.components.length;
  }
  update(dt: number): void {
    for (const c of this.components) c.update(dt);
  }
}
