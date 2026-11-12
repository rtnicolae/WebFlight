/**
 * Pilot input → FlightGear control semantics (see fdm-core fg-bridge).
 *
 * Gamepad ("standard" mapping):
 *   left stick X/Y      aileron / elevator (push forward = nose down)
 *   triggers LT/RT      rudder left / right (right stick X also works)
 *   bumpers LB/RB       airbrake lever close / open (moves while held)
 *   d-pad up/down       elevator trim nose down / up
 *   Start               reset to start      Back/Y   toggle view
 * Keyboard fallback (self-centring, rate-limited):
 *   arrows              elevator / aileron   Z / X    rudder
 *   J / K               airbrake close/open  [ / ]    trim (up/down)
 *   R reset   V view   P pause   H help
 */
import type { FgControls } from "@webflight/fdm-core";

export interface InputEvents {
  reset(): void;
  toggleView(): void;
  togglePause(): void;
  toggleHelp(): void;
}

const DEADZONE = 0.06;
const EXPO = 0.35;

/** Deadzone and expo shaping for a -1..1 axis. */
export function shapeAxis(v: number, deadzone = DEADZONE, expo = EXPO): number {
  const a = Math.abs(v);
  if (a < deadzone) return 0;
  const x = (a - deadzone) / (1 - deadzone);
  return Math.sign(v) * ((1 - expo) * x + expo * x * x * x);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class PilotInput {
  readonly controls: FgControls = { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, airbrake: 0 };
  /** Name of the active gamepad, or undefined (keyboard). */
  gamepadName: string | undefined;
  private readonly keys = new Set<string>();
  private readonly prevButtons = new Map<number, boolean>();
  private kbd = { aileron: 0, elevator: 0, rudder: 0 };

  constructor(private readonly events: InputEvents) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) {
        if (/^Arrow/.test(e.key)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      switch (e.code) {
        case "KeyR": events.reset(); break;
        case "KeyV": events.toggleView(); break;
        case "KeyP": events.togglePause(); break;
        case "KeyH": events.toggleHelp(); break;
      }
      if (/^Arrow/.test(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** Set the trim (e.g. from the FDM's trim at start/reset). */
  setTrim(t: number): void {
    this.controls.elevatorTrim = clamp(t, -1, 1);
  }

  update(dt: number): FgControls {
    const c = this.controls;
    const pad = [...(navigator.getGamepads?.() ?? [])].find((g): g is Gamepad => !!g && g.connected);
    this.gamepadName = pad?.id;

    // Keyboard: deflect toward ±0.6 while held, recentre when released.
    const k = this.keys;
    const target = {
      aileron: (k.has("ArrowRight") ? 0.6 : 0) - (k.has("ArrowLeft") ? 0.6 : 0),
      elevator: (k.has("ArrowUp") ? 0.6 : 0) - (k.has("ArrowDown") ? 0.6 : 0),
      rudder: (k.has("KeyX") ? 0.8 : 0) - (k.has("KeyZ") ? 0.8 : 0),
    };
    for (const ax of ["aileron", "elevator", "rudder"] as const) {
      const d = target[ax] - this.kbd[ax];
      this.kbd[ax] += clamp(d, -2.5 * dt, 2.5 * dt);
    }
    let airbrakeRate = (k.has("KeyK") ? 1 : 0) - (k.has("KeyJ") ? 1 : 0);
    let trimRate = (k.has("BracketLeft") ? 1 : 0) - (k.has("BracketRight") ? 1 : 0);

    let aileron = this.kbd.aileron, elevator = this.kbd.elevator, rudder = this.kbd.rudder;
    if (pad) {
      const ax = (i: number) => pad.axes[i] ?? 0;
      const btn = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => (pad.buttons[i]?.pressed ?? false) && !this.prevButtons.get(i);
      aileron += shapeAxis(ax(0));
      elevator += -shapeAxis(ax(1));
      rudder += shapeAxis(ax(2), 0.1, 0.2) + (btn(7) - btn(6));
      airbrakeRate += (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
      trimRate += (pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0);
      if (pressed(9)) this.events.reset();
      if (pressed(8) || pressed(3)) this.events.toggleView();
      pad.buttons.forEach((b, i) => this.prevButtons.set(i, b.pressed));
    }
    c.aileron = clamp(aileron, -1, 1);
    c.elevator = clamp(elevator, -1, 1);
    c.rudder = clamp(rudder, -1, 1);
    c.airbrake = clamp(c.airbrake + airbrakeRate * 0.7 * dt, 0, 1);
    c.elevatorTrim = clamp(c.elevatorTrim + trimRate * 0.15 * dt, -1, 1);
    return c;
  }
}
