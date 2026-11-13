/**
 * TypeScript versions of the FGData Nasal helpers the ported scripts use:
 * Aircraft/Generic/soaring-instrumentation-sdk.nas (Anton Gomez Alvedro, GPL-2.0+),
 * Aircraft/Generic/updateloop.nas and Nasal/aircraft.nas (aircraft.door).
 */
import type { ScriptApi, Timer } from "../host.ts";

export const KT2MPS = 0.5144444;
export const FT2M = 0.3048;

export interface Component {
  output: number;
  reset?(): void;
  update(dt: number): void;
}

/** updateloop.UpdateLoop: calls update(dt) on components every `period` seconds (0 = every frame). */
export function updateLoop(api: ScriptApi, components: Component[], period = 0): Timer {
  let last = api.time;
  for (const c of components) c.reset?.();
  // updateloop.nas resets its components on /sim/signals/reinit (sim reset/reposition).
  api.setlistener("/sim/signals/reinit", (v) => {
    if (v === true || v === 1 || v === "true") {
      for (const c of components) c.reset?.();
      last = api.time;
    }
  });
  const t = api.maketimer(period, () => {
    const dt = api.time - last;
    last = api.time;
    if (dt <= 0) return;
    for (const c of components) c.update(dt);
  });
  t.start();
  return t;
}

export const updateProp = (api: ScriptApi, path: string) => (v: number) => api.setprop(path, v);

export class TotalEnergyProbe implements Component {
  output = 0;
  private altitude = 0;
  private airspeed = 0;
  constructor(private readonly api: ScriptApi, private readonly onUpdate?: (v: number) => void) {}
  reset(): void {
    this.airspeed = this.api.num("/velocities/airspeed-kt") * KT2MPS;
    this.altitude = this.api.num("/position/altitude-ft") * FT2M;
    this.output = 0;
  }
  update(dt: number): void {
    const alt = this.api.num("/position/altitude-ft") * FT2M;
    const ias = this.api.num("/velocities/airspeed-kt") * KT2MPS;
    this.output = (alt - this.altitude) / dt + (ias * ias - this.airspeed * this.airspeed) / (19.62 * dt);
    this.altitude = alt;
    this.airspeed = ias;
    this.onUpdate?.(this.output);
  }
}

export class Dampener implements Component {
  output = 0;
  constructor(public input: Component, public dampening = 3, public scale = 1, private readonly onUpdate?: (v: number) => void) {}
  reset(): void {
    this.output = 0;
  }
  update(dt: number): void {
    const a = Math.exp(-dt / this.dampening);
    this.output = this.output * a + this.input.output * this.scale * (1 - a);
    this.onUpdate?.(this.output);
  }
}

export class Averager implements Component {
  output = 0;
  private sum = 0;
  private wp = 0;
  private readonly buffer: number[];
  constructor(private readonly input: Component, private readonly size = 25, private readonly onUpdate?: (v: number) => void) {
    this.buffer = new Array<number>(size).fill(0);
  }
  reset(): void {
    this.sum = this.wp = this.output = 0;
    this.buffer.fill(0);
  }
  update(): void {
    const v = this.input.output;
    this.sum += v - this.buffer[this.wp]!;
    this.output = this.sum / this.size;
    this.buffer[this.wp] = v;
    this.wp = (this.wp + 1) % this.size;
    this.onUpdate?.(this.output);
  }
}

export class YawString implements Component {
  output = 0;
  constructor(private readonly api: ScriptApi, private readonly onUpdate?: (v: number) => void, private readonly rand: () => number = Math.random) {}
  update(): void {
    const ias = this.api.num("/velocities/airspeed-kt");
    const noise = ias < 54 ? Math.sin((Math.PI * ias) / 54) * this.rand() : 0;
    this.output = noise + this.api.num("/orientation/side-slip-deg");
    this.onUpdate?.(this.output);
  }
}

export class PropertyReader implements Component {
  output = 0;
  constructor(private readonly api: ScriptApi, private readonly path: string, private readonly scale = 1) {}
  update(): void {
    this.output = this.scale * this.api.num(this.path);
  }
}

export class InputSwitcher implements Component {
  output = 0;
  constructor(private readonly inputs: Component[], public active = 0, private readonly onUpdate?: (v: number) => void) {}
  select(n: number): void {
    this.active = n;
    this.update();
  }
  update(): void {
    this.output = this.inputs[this.active]?.output ?? 0;
    this.onUpdate?.(this.output);
  }
}

/** SoundPitchController: pitch = max_pitch ^ (clamped input / max_input). */
export class SoundPitchController implements Component {
  output = 1;
  constructor(private readonly input: Component, private readonly maxInput: number, private readonly maxPitch = 2, private readonly onUpdate?: (v: number) => void) {}
  update(): void {
    const x = Math.min(this.maxInput, Math.max(-this.maxInput, this.input.output));
    this.output = Math.pow(this.maxPitch, x / this.maxInput);
    this.onUpdate?.(this.output);
  }
}

/** aircraft.door: <node>/position-norm moves between 0 and 1 over `swingtime` seconds. */
export class Door {
  private target: boolean;
  constructor(private readonly api: ScriptApi, private readonly node: string, private readonly swingtime: number, pos = 0) {
    api.tree.init(`${node}/enabled`, true);
    api.tree.init(`${node}/position-norm`, pos);
    this.target = pos < 0.5;
  }
  get position(): number {
    return this.api.num(`${this.node}/position-norm`);
  }
  move(target: number): void {
    if (!this.api.tree.bool(`${this.node}/enabled`)) return;
    const pos = this.position;
    this.api.interpolate(`${this.node}/position-norm`, target, Math.abs(target - pos) * this.swingtime);
    this.target = target < 0.5;
  }
  open(): void {
    this.move(1);
  }
  close(): void {
    this.move(0);
  }
  toggle(): void {
    this.move(this.target ? 1 : 0);
  }
}
