/**
 * Heads-up display: a glass instrument strip (airspeed, vario, altitude), wind and lift,
 * control positions, launch status, pilot messages and a help card.
 */
import type { FgControls } from "@webflight/fdm-core";

export interface HudData {
  iasKmh: number;
  altM: number;
  aglM: number;
  varioMs: number;
  /** ILEC SC7 total-energy vario reading [m/s] (fg-host). */
  teVarioMs: number;
  glideRatio: number;
  /** True heading [deg] (for the wind arrow). */
  headingDeg?: number;
  controls: FgControls;
  fps: number;
  stepsPerSecond: number;
  shared: boolean;
  input: string;
  view: string;
  paused: boolean;
  /** Air at the aircraft (from the worker, ~1 Hz). */
  air?: { windFromDeg: number; windKt: number; thermalLiftMs: number; ridgeLiftMs: number };
  site?: string;
  /** Launch status line. */
  launch?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

const signed = (v: number, digits = 1) => (v >= 0.05 ? "+" : v <= -0.05 ? "−" : "") + Math.abs(v).toFixed(digits);

export class Hud {
  private readonly ias: HTMLElement;
  private readonly alt: HTMLElement;
  private readonly vario: HTMLElement;
  private readonly varioFill: HTMLElement;
  private readonly agl: HTMLElement;
  private readonly te: HTMLElement;
  private readonly ld: HTMLElement;
  private readonly windArrow: HTMLElement;
  private readonly windText: HTMLElement;
  private readonly lift: HTMLElement;
  private readonly site: HTMLElement;
  private readonly stickDot: HTMLElement;
  private readonly rudderDot: HTMLElement;
  private readonly brakeFill: HTMLElement;
  private readonly trimMark: HTMLElement;
  private readonly launch: HTMLElement;
  private readonly status: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly help: HTMLElement;
  private varioSmooth = 0;

  constructor(root: HTMLElement) {
    // Top left: where, wind and lift.
    const info = el("div", "glass hud-info", root);
    this.site = el("div", "hud-site", info);
    const wind = el("div", "hud-wind", info);
    const rose = el("div", "hud-rose", wind);
    this.windArrow = el("div", "hud-rose-arrow", rose, `<svg viewBox="0 0 24 24"><path d="M12 3 L17 14 L12 11.5 L7 14 Z"/></svg>`);
    this.windText = el("div", "hud-wind-text", wind);
    this.lift = el("div", "hud-lift", info);
    this.launch = el("div", "glass hud-launch", root);

    // Bottom centre: instrument strip.
    const strip = el("div", "glass hud-strip", root);
    const gauge = (label: string, unit: string, cls = "") => {
      const g = el("div", `hud-gauge ${cls}`, strip);
      el("div", "hud-label", g).textContent = label;
      const v = el("div", "hud-value", g);
      el("div", "hud-unit", g).textContent = unit;
      return v;
    };
    this.ias = gauge("AIRSPEED", "km/h");
    const vg = el("div", "hud-gauge hud-vario", strip);
    el("div", "hud-label", vg).textContent = "VARIO";
    this.vario = el("div", "hud-value hud-vario-value", vg);
    el("div", "hud-unit", vg).textContent = "m/s";
    const track = el("div", "hud-vario-track", vg);
    el("div", "hud-vario-zero", track);
    this.varioFill = el("div", "hud-vario-fill", track);
    this.alt = gauge("ALTITUDE", "m");
    const sub = el("div", "hud-strip-sub", strip);
    this.agl = el("span", "", sub);
    this.te = el("span", "", sub);
    this.ld = el("span", "", sub);

    // Bottom left: controls.
    const ctl = el("div", "glass hud-controls", root);
    const stick = el("div", "hud-stick", ctl);
    this.stickDot = el("div", "hud-dot", stick);
    const right = el("div", "hud-ctl-right", ctl);
    const rud = el("div", "hud-rudder", right);
    this.rudderDot = el("div", "hud-dot", rud);
    const brake = el("div", "hud-bar", right);
    el("span", "hud-bar-label", brake).textContent = "Airbrake";
    const bt = el("div", "hud-bar-track", brake);
    this.brakeFill = el("div", "hud-bar-fill", bt);
    const trim = el("div", "hud-bar", right);
    el("span", "hud-bar-label", trim).textContent = "Trim";
    const tt = el("div", "hud-bar-track hud-trim-track", trim);
    this.trimMark = el("div", "hud-trim-mark", tt);

    // Top right: status; centre: messages and pause.
    this.status = el("div", "hud-status", root);
    this.paused = el("div", "glass hud-paused", root, "Paused <small>P to continue</small>");
    this.toasts = el("div", "hud-toasts", root);
    this.help = el("div", "glass hud-help", root);
    this.help.innerHTML = `
      <h3>Controls</h3>
      <div class="hud-help-grid">
        <b>Stick</b><span>arrows · gamepad left stick</span>
        <b>Rudder</b><span>Z / X · triggers or right stick</span>
        <b>Airbrake</b><span>J / K · bumpers (last 10 % is the wheel brake)</span>
        <b>Trim</b><span>[ / ] · d-pad up / down</span>
        <b>View</b><span>V cockpit/chase · drag to look or orbit · wheel to zoom</span>
        <b>Launch</b><span>L start · O release the hook · + / − winch speed · gamepad A / B</span>
        <b>Sim</b><span>P pause · R restart · Esc menu · H this card</span>
      </div>
      <p>In the cockpit, click switches and the canopy, and use the wheel on knobs and levers.</p>`;
    this.help.hidden = true;
    el("div", "hud-hint", root).textContent = "H  controls   ·   Esc  menu";
  }

  /** A pilot message (FG screen.log / popupTip), shown for a few seconds. */
  message(text: string): void {
    const m = /^([a-z-]+): (.*)$/.exec(text);
    const t = el("div", `glass hud-toast${m ? ` hud-toast-${m[1]}` : ""}`, this.toasts);
    if (m) {
      el("span", "hud-toast-who", t).textContent = m[1]!.replace("-", " ");
      el("span", "", t).textContent = m[2]!;
    } else t.textContent = text;
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    setTimeout(() => t.classList.add("hud-toast-out"), 5000);
    setTimeout(() => t.remove(), 5600);
  }

  toggleHelp(): void {
    this.help.hidden = !this.help.hidden;
  }

  update(d: HudData, dt: number): void {
    this.varioSmooth += (d.varioMs - this.varioSmooth) * Math.min(1, dt / 0.6);
    const v = this.varioSmooth;
    this.ias.textContent = d.iasKmh.toFixed(0);
    this.alt.textContent = d.altM.toFixed(0);
    this.vario.textContent = signed(v);
    const sign = v >= 0.05 ? "up" : v <= -0.05 ? "down" : "zero";
    this.vario.dataset["sign"] = sign;
    const frac = Math.max(-1, Math.min(1, v / 5));
    this.varioFill.style.width = `${Math.abs(frac) * 50}%`;
    this.varioFill.style.left = frac >= 0 ? "50%" : `${50 + frac * 50}%`;
    this.varioFill.dataset["sign"] = sign;
    this.agl.textContent = `AGL ${d.aglM.toFixed(0)} m`;
    this.te.textContent = `TE ${signed(d.teVarioMs)}`;
    this.ld.textContent = Number.isFinite(d.glideRatio) && d.glideRatio > 0 && d.glideRatio < 200 ? `L/D ${d.glideRatio.toFixed(0)}` : "L/D –";

    if (d.site) this.site.textContent = d.site;
    if (d.air) {
      const a = d.air;
      // Arrow points where the wind blows to, relative to the nose (up = straight ahead).
      const rel = a.windFromDeg + 180 - (d.headingDeg ?? 0);
      this.windArrow.style.transform = `rotate(${rel}deg)`;
      this.windArrow.style.opacity = a.windKt > 0.5 ? "1" : "0.25";
      this.windText.innerHTML = a.windKt > 0.5 ? `<b>${a.windKt.toFixed(0)}</b> kt <span>from ${a.windFromDeg.toFixed(0).padStart(3, "0")}°</span>` : "<b>Calm</b>";
      this.lift.innerHTML = `<span data-sign="${a.thermalLiftMs > 0.2 ? "up" : "zero"}">Thermal ${signed(a.thermalLiftMs)}</span><span data-sign="${a.ridgeLiftMs > 0.2 ? "up" : a.ridgeLiftMs < -0.2 ? "down" : "zero"}">Ridge ${signed(a.ridgeLiftMs)}</span>`;
    }
    this.launch.textContent = d.launch ?? "";
    this.launch.hidden = !d.launch;

    const c = d.controls;
    this.stickDot.style.left = `${50 + c.aileron * 42}%`;
    this.stickDot.style.top = `${50 + c.elevator * 42}%`;
    this.rudderDot.style.left = `${50 + c.rudder * 45}%`;
    this.brakeFill.style.width = `${c.airbrake * 100}%`;
    this.trimMark.style.left = `${50 - c.elevatorTrim * 50}%`;
    this.status.textContent = `${d.fps.toFixed(0)} fps · FDM ${d.stepsPerSecond.toFixed(0)} Hz · ${d.view} · ${d.input}`;
    this.paused.hidden = !d.paused;
  }
}
