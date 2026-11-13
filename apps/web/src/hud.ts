/** HUD overlay: airspeed, altitude, vario, plus control positions and sim status. */
import type { FgControls } from "@webflight/fdm-core";

export interface HudData {
  iasKmh: number;
  altM: number;
  aglM: number;
  varioMs: number;
  /** ILEC SC7 total-energy vario reading [m/s] (fg-host). */
  teVarioMs: number;
  glideRatio: number;
  controls: FgControls;
  fps: number;
  stepsPerSecond: number;
  shared: boolean;
  input: string;
  view: string;
  paused: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
};

export class Hud {
  private readonly ias: HTMLElement;
  private readonly alt: HTMLElement;
  private readonly agl: HTMLElement;
  private readonly vario: HTMLElement;
  private readonly varioBar: HTMLElement;
  private readonly ld: HTMLElement;
  private readonly stickDot: HTMLElement;
  private readonly rudderDot: HTMLElement;
  private readonly brake: HTMLElement;
  private readonly trim: HTMLElement;
  private readonly status: HTMLElement;
  private readonly help: HTMLElement;
  private varioSmooth = 0;
  private readonly toasts: HTMLElement;
  private readonly te: HTMLElement;

  constructor(root: HTMLElement) {
    const panel = el("div", "hud-panel", root);
    const cell = (label: string, unit: string) => {
      const c = el("div", "hud-cell", panel);
      el("div", "hud-label", c).textContent = label;
      const v = el("div", "hud-value", c);
      el("div", "hud-unit", c).textContent = unit;
      return v;
    };
    this.ias = cell("IAS", "km/h");
    this.alt = cell("ALT", "m MSL");
    this.vario = cell("VARIO", "m/s");
    const varioTrack = el("div", "hud-vario-track", panel);
    this.varioBar = el("div", "hud-vario-bar", varioTrack);
    const sub = el("div", "hud-sub", root);
    this.agl = el("span", "", sub);
    this.ld = el("span", "", sub);

    const ctl = el("div", "hud-controls", root);
    const stick = el("div", "hud-stick", ctl);
    this.stickDot = el("div", "hud-dot", stick);
    const rud = el("div", "hud-rudder", ctl);
    this.rudderDot = el("div", "hud-dot", rud);
    const right = el("div", "hud-levers", ctl);
    this.brake = el("div", "", right);
    this.trim = el("div", "", right);

    this.status = el("div", "hud-status", root);
    this.toasts = el("div", "hud-toasts", root);
    this.te = el("span", "", sub);
    this.help = el("div", "hud-help", root);
    this.help.innerHTML = `
      <b>Gamepad</b>: left stick = aileron/elevator · LT/RT or right stick = rudder · LB/RB = airbrake ·
      d-pad ↑/↓ = trim · Start = reset · Back/Y = view · mouse drag = orbit, wheel = zoom<br>
      <b>Cockpit</b> (V): click switches and canopy, mouse wheel on knobs and the airbrake lever, drag to look around<br>
      <b>Keyboard</b>: arrows = stick · Z/X = rudder · J/K = airbrake · [ / ] = trim · R reset · V view · P pause · H hide help`;
  }

  /** A pilot message (FG screen.log / popupTip), shown for a few seconds. */
  message(text: string): void {
    const t = el("div", "hud-toast", this.toasts);
    t.textContent = text;
    setTimeout(() => t.remove(), 6000);
  }

  toggleHelp(): void {
    this.help.hidden = !this.help.hidden;
  }

  update(d: HudData, dt: number): void {
    this.varioSmooth += (d.varioMs - this.varioSmooth) * Math.min(1, dt / 0.6);
    const v = this.varioSmooth;
    this.ias.textContent = d.iasKmh.toFixed(0);
    this.alt.textContent = d.altM.toFixed(0);
    this.vario.textContent = (v >= 0 ? "+" : "") + v.toFixed(1);
    this.vario.dataset["sign"] = v >= 0.05 ? "up" : v <= -0.05 ? "down" : "zero";
    const frac = Math.max(-1, Math.min(1, v / 5));
    this.varioBar.style.height = `${Math.abs(frac) * 50}%`;
    this.varioBar.style.top = frac >= 0 ? `${50 - frac * 50}%` : "50%";
    this.varioBar.dataset["sign"] = frac >= 0 ? "up" : "down";
    this.agl.textContent = `AGL ${d.aglM.toFixed(0)} m`;
    this.te.textContent = `TE ${d.teVarioMs >= 0 ? "+" : ""}${d.teVarioMs.toFixed(1)}`;
    this.ld.textContent = Number.isFinite(d.glideRatio) && d.glideRatio > 0 && d.glideRatio < 200 ? `L/D ${d.glideRatio.toFixed(0)}` : "L/D –";
    const c = d.controls;
    this.stickDot.style.left = `${50 + c.aileron * 45}%`;
    this.stickDot.style.top = `${50 + c.elevator * 45}%`;
    this.rudderDot.style.left = `${50 + c.rudder * 45}%`;
    this.brake.textContent = `Airbrake ${(c.airbrake * 100).toFixed(0)} %`;
    this.trim.textContent = `Trim ${(c.elevatorTrim * 100).toFixed(0)} %`;
    this.status.textContent =
      `${d.fps.toFixed(0)} fps · FDM ${d.stepsPerSecond.toFixed(0)} Hz${d.shared ? " (shared)" : " (postMessage)"} · ${d.view} · ${d.input}` + (d.paused ? " · PAUSED" : "");
  }
}
