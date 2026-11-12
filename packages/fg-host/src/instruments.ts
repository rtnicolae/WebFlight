/**
 * Ports of FlightGear's C++ pitot/static systems and instruments, configured by the
 * aircraft's instrumentation and systems PropertyLists (/sim/instrumentation/path,
 * /sim/systems/path). Sources: src/Systems/{pitot,static}.cxx,
 * src/Instrumentation/{airspeed_indicator,altimeter,vertical_speed_indicator,
 * mag_compass,slip_skid_ball,turn_indicator,AbstractInstrument,gyro}.cxx.
 */
import { kid, kidBool, kidNum, kidText, type PNode } from "./plist.ts";
import type { PropertyTree, PropRef } from "./props.ts";

const INHG_TO_PA = 3386.389;
const MPS_TO_KT = 1.9438445;
const P0_PA = 101325;
const RHO0 = 1.225;
const T0_K = 288.15;
const SG_GAMMA = 1.4;
const SG_R = 287.058;
const SG_CP = 1004.68;
const D2R = Math.PI / 180;

/** fgGetLowPass (src/Main/util.cxx). */
export function lowPass(current: number, target: number, timeratio: number): number {
  if (timeratio < 0) return timeratio < -1 ? target : current;
  if (timeratio < 0.2) return current * (1 - timeratio) + target * timeratio;
  if (timeratio > 5) return target;
  const keep = Math.exp(-timeratio);
  return current * keep + target * (1 - keep);
}

/** ISA pressure altitude [ft] for a pressure [inHg] (FGAltimeter / FGAtmo, troposphere + lower stratosphere). */
export function pressureAltitudeFt(pInHg: number): number {
  const p = Math.max(pInHg, 1e-6) * INHG_TO_PA;
  const g = 9.80665, mm = 0.0289644, R = 8.31432, L = 0.0065;
  const p11 = 22632.1;
  let h: number;
  if (p >= p11) h = (T0_K / L) * (1 - Math.pow(p / P0_PA, (L * R) / (g * mm)));
  else h = 11000 - ((R * 216.65) / (g * mm)) * Math.log(p / p11);
  return h / 0.3048;
}

interface Updatable {
  update(dt: number): void;
}

const branch = (kind: "instrumentation" | "systems", name: string, n: number) => `/${kind}/${name}${n ? `[${n}]` : ""}`;

function serviceable(tree: PropertyTree, base: string): PropRef {
  return tree.init(`${base}/serviceable`, true);
}

class PitotSystem implements Updatable {
  private readonly ok: PropRef;
  private readonly total: PropRef;
  private readonly measured: PropRef;
  private readonly stallFactor: number;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("systems", kidText(cfg, "name") ?? "pitot", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.total = t.node(`${base}/total-pressure-inhg`);
    this.measured = t.node(`${base}/measured-total-pressure-inhg`);
    const sf = Math.cos(kidNum(cfg, "stall-deg", 60) * D2R);
    this.stallFactor = sf < 0 ? Math.cos(60 * D2R) : sf;
  }
  update(): void {
    if (!this.ok.bool()) return;
    const p = this.t.num("/environment/pressure-inhg"), mach = this.t.num("/velocities/mach");
    const a = this.t.num("/orientation/alpha-deg") * D2R, b = this.t.num("/orientation/side-slip-deg") * D2R;
    const x = Math.cos(a) * Math.abs(Math.cos(b));
    let pt = p, ptm = p;
    if (x > this.stallFactor) {
      pt = p * Math.pow(1 + 0.2 * mach * mach * x * x, 3.5);
      ptm = mach > 1 ? p * Math.pow(1.2 * mach * mach, 3.5) * Math.pow((2.8 / 2.4) * mach * mach - 0.4 / 2.4, -2.5) : pt;
    }
    this.total.set(pt);
    this.measured.set(ptm);
  }
}

class StaticSystem implements Updatable {
  private readonly ok: PropRef;
  private readonly out: PropRef;
  private readonly tau: number;
  private readonly errorFactor: number;
  private readonly type: number;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("systems", kidText(cfg, "name") ?? "static", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.out = t.node(`${base}/pressure-inhg`);
    this.tau = Math.max(0, kidNum(cfg, "tau", 1));
    this.errorFactor = Math.min(1, Math.max(0, kidNum(cfg, "error-factor", 0)));
    this.type = kidNum(cfg, "type", 0);
    this.out.set(t.num("/environment/pressure-inhg"));
  }
  update(dt: number): void {
    if (!this.ok.bool()) return;
    let pNew = this.t.num("/environment/pressure-inhg");
    if (this.type === 1 || this.type === 2) {
      const b = this.t.num("/orientation/side-slip-deg") * D2R, a = this.t.num("/orientation/alpha-deg") * D2R;
      const proj = this.type === 1 ? Math.sin(b) : Math.sqrt(1 - Math.cos(b) ** 2 * Math.cos(a) ** 2);
      const mach = this.t.num("/velocities/mach");
      const pt = pNew * Math.pow(1 + 0.2 * mach * mach * proj * proj, 3.5);
      pNew += (pt - pNew) * this.errorFactor;
    }
    const p = this.out.num() || pNew;
    this.out.set(this.tau > 0 ? lowPass(p, pNew, dt / this.tau) : pNew);
  }
}

class AirspeedIndicator implements Updatable {
  private readonly ok: PropRef;
  private readonly speed: PropRef;
  private readonly tas: PropRef;
  private readonly mach: PropRef;
  private readonly pt: PropRef;
  private readonly ps: PropRef;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("instrumentation", kidText(cfg, "name") ?? "airspeed-indicator", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.speed = t.node(`${base}/indicated-speed-kt`);
    this.tas = t.node(`${base}/true-speed-kt`);
    this.mach = t.node(`${base}/indicated-mach`);
    this.pt = t.node(kidText(cfg, "total-pressure") ?? "/systems/pitot/total-pressure-inhg");
    this.ps = t.node(kidText(cfg, "static-pressure") ?? "/systems/static/pressure-inhg");
  }
  update(dt: number): void {
    if (!this.ok.bool()) return;
    const pt = this.pt.num(), p = this.ps.num();
    const qc = Math.max(0, (pt - p) * INHG_TO_PA);
    const vcal = Math.sqrt(((7 * P0_PA) / RHO0) * (Math.pow(1 + qc / P0_PA, 1 / 3.5) - 1));
    this.speed.set(lowPass(this.speed.num(), vcal * MPS_TO_KT, dt * 50));
    // computeMach()
    const oatK = Math.max(0.001, this.t.num("/environment/temperature-degc") + 273.15);
    const c = Math.sqrt(SG_GAMMA * SG_R * oatK);
    const pPa = Math.max(0.001, p * INHG_TO_PA);
    const ptPa = Math.max(pt * INHG_TO_PA, pPa);
    const rho = Math.max(0.001, this.t.num("/environment/density-slugft3") * 515.379);
    const vTrue = Math.sqrt(((7 * pPa) / rho) * (Math.pow(1 + (ptPa - pPa) / pPa, 1 / 3.5) - 1));
    this.mach.set(vTrue / c);
    this.tas.set(vTrue * MPS_TO_KT);
  }
}

class Altimeter implements Updatable {
  private readonly ok: PropRef;
  private readonly ps: PropRef;
  private readonly pressAlt: PropRef;
  private readonly indicated: PropRef;
  private readonly setting: PropRef;
  private readonly settingHpa: PropRef;
  private readonly tau: number;
  private readonly quantum: number;
  private rawPA = 0;
  private kollsman = 0;
  private first = true;
  constructor(t: PropertyTree, cfg: PNode) {
    const base = branch("instrumentation", kidText(cfg, "name") ?? "altimeter", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.ps = t.node(kidText(cfg, "static-pressure") ?? "/systems/static/pressure-inhg");
    this.pressAlt = t.node(`${base}/pressure-alt-ft`);
    this.indicated = t.node(`${base}/indicated-altitude-ft`);
    this.setting = t.init(`${base}/setting-inhg`, 29.92126);
    this.settingHpa = t.init(`${base}/setting-hpa`, 1013.25);
    this.tau = kidNum(cfg, "tau", 0.1);
    this.quantum = kidNum(cfg, "quantum", 0);
  }
  update(dt: number): void {
    if (!this.ok.bool()) return;
    const trat = this.tau > 0 ? dt / this.tau : 100;
    const target = pressureAltitudeFt(this.ps.num());
    const kTarget = pressureAltitudeFt(this.setting.num());
    // First update snaps (FG starts the filters at 0 and converges within a second).
    this.rawPA = this.first ? target : lowPass(this.rawPA, target, trat);
    this.kollsman = this.first ? kTarget : lowPass(this.kollsman, kTarget, trat);
    this.first = false;
    const pa = this.quantum ? this.quantum * Math.round(this.rawPA / this.quantum) : this.rawPA;
    this.pressAlt.set(pa);
    this.indicated.set(pa - this.kollsman);
    this.settingHpa.set((this.setting.num() * INHG_TO_PA) / 100);
  }
}

class VerticalSpeedIndicator implements Updatable {
  // vertical_speed_indicator.hxx
  private static readonly VOL = 1.25e-4; // casing volume [m3]
  private static readonly A_ORIFICE = 7.853982e-9; // [m2]
  private static readonly FACTOR_CAL = 189.145628;
  private readonly ok: PropRef;
  private readonly ps: PropRef;
  private readonly fpm: PropRef;
  private readonly mps: PropRef;
  private casingP = 0;
  private casingRho = 0;
  private casingMass = 0;
  private massflow = 0;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("instrumentation", kidText(cfg, "name") ?? "vertical-speed-indicator", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.ps = t.node(kidText(cfg, "static-pressure") ?? "/systems/static/pressure-inhg");
    this.fpm = t.node(`${base}/indicated-speed-fpm`);
    this.mps = t.node(`${base}/indicated-speed-mps`);
  }
  private reinit(): void {
    this.casingP = this.ps.num() * INHG_TO_PA;
    const tK = this.t.num("/environment/temperature-degc") + 273.15;
    this.casingRho = this.casingP / (tK * SG_R);
    this.casingMass = this.casingRho * VerticalSpeedIndicator.VOL;
    this.massflow = 0;
  }
  update(dt: number): void {
    if (!this.ok.bool()) return;
    const p = this.ps.num() * INHG_TO_PA;
    if (this.casingP < 1e-3) {
      if (p > 1e3) this.reinit();
      else return;
    }
    this.casingMass -= this.massflow * dt;
    const rho = this.casingMass / VerticalSpeedIndicator.VOL;
    this.casingP *= Math.pow(rho / this.casingRho, SG_GAMMA);
    const tK = this.casingP / (rho * SG_R);
    const sign = this.casingP - p > 0 ? 1 : -1;
    const m = Math.abs(this.casingP - p) < 0.01 ? 0 : Math.sqrt(Math.abs(((2 * SG_CP) / (SG_GAMMA * SG_R)) * (Math.pow(p / this.casingP, (SG_GAMMA - 1) / SG_GAMMA) - 1)));
    this.massflow = ((sign * this.casingP) / Math.sqrt(tK)) * Math.sqrt(SG_GAMMA / SG_R) * m * Math.pow(1 + ((SG_GAMMA - 1) / 2) * m * m, -(SG_GAMMA + 1) / (2 * (SG_GAMMA - 1))) * VerticalSpeedIndicator.A_ORIFICE;
    const vsFpm = sign * Math.sqrt(Math.abs(p - this.casingP)) * VerticalSpeedIndicator.FACTOR_CAL;
    this.fpm.set(vsFpm);
    this.mps.set((vsFpm / 60) * 0.3048);
    this.casingRho = rho;
  }
}

class MagCompass implements Updatable {
  private readonly ok: PropRef;
  private readonly out: PropRef;
  private rate = 0;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("instrumentation", kidText(cfg, "name") ?? "magnetic-compass", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.out = t.node(`${base}/indicated-heading-deg`);
    this.out.set(t.num("/orientation/heading-magnetic-deg"));
  }
  update(dt: number): void {
    if (!this.ok.bool()) return;
    let phi = this.t.num("/orientation/roll-deg") * D2R;
    let theta = this.t.num("/orientation/pitch-deg") * D2R;
    const psi = this.t.num("/orientation/heading-magnetic-deg") * D2R;
    const mu = this.t.num("/environment/magnetic-dip-deg") * D2R;
    theta -= (0.07 * this.t.num("/accelerations/pilot/x-accel-fps_sec")) / 32;
    phi -= (0.07 * this.t.num("/accelerations/pilot/y-accel-fps_sec")) / 32;
    const a = Math.cos(phi) * Math.sin(psi) * Math.cos(mu) - Math.sin(phi) * Math.cos(theta) * Math.sin(mu) - Math.sin(phi) * Math.sin(theta) * Math.cos(mu) * Math.cos(psi);
    const b = Math.cos(theta) * Math.cos(psi) * Math.cos(mu) - Math.sin(theta) * Math.sin(mu);
    let target = (Math.atan2(a, b) * 180) / Math.PI;
    const old = this.out.num();
    while (target - old > 180) target -= 360;
    while (target - old < -180) target += 360;
    this.rate = lowPass(this.rate, target - old, dt / 5);
    this.out.set((((old + this.rate * dt) % 360) + 360) % 360);
  }
}

class SlipSkidBall implements Updatable {
  private readonly ok: PropRef;
  private readonly out: PropRef;
  private readonly override: PropRef;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const base = branch("instrumentation", kidText(cfg, "name") ?? "slip-skid-ball", kidNum(cfg, "number", 0));
    this.ok = serviceable(t, base);
    this.out = t.node(`${base}/indicated-slip-skid`);
    this.override = t.node(`${base}/override`);
  }
  update(dt: number): void {
    if (!this.ok.bool() || this.override.bool()) return;
    const d = Math.max(1, -this.t.num("/accelerations/pilot/z-accel-fps_sec"));
    const pos = (this.t.num("/accelerations/pilot/y-accel-fps_sec") / d) * 10;
    this.out.set(lowPass(this.out.num(), pos, dt));
  }
}

class TurnIndicator implements Updatable {
  private readonly ok: PropRef;
  private readonly powerBtn: PropRef;
  private readonly supply: PropRef;
  private readonly minVolts: number;
  private readonly out: PropRef;
  private readonly spin: PropRef;
  private readonly valid: PropRef;
  private readonly maxOut: number;
  private readonly spinUp: number;
  private readonly spinDown: number;
  private readonly validFrom: number;
  private last = 0;
  constructor(private readonly t: PropertyTree, cfg: PNode) {
    const name = kidText(cfg, "name") ?? "turn-indicator", n = kidNum(cfg, "number", 0);
    const base = `/instrumentation/${name}${n ? `[${n}]` : ""}`;
    this.ok = serviceable(t, base);
    this.powerBtn = t.init(`${base}/power-btn`, true);
    const supplyPath = kidText(cfg, "power-supply") ?? (kidBool(cfg, "new-default-power-path", false) ? `/systems/electrical/outputs/${name}${n ? `[${n}]` : ""}` : "/systems/electrical/outputs/turn-coordinator");
    this.supply = t.node(supplyPath);
    this.minVolts = kidNum(cfg, "minimum-supply-volts", 1);
    this.out = t.node(`${base}/indicated-turn-rate`);
    this.spin = t.node(`${base}/gyro/spin`);
    this.valid = t.node(`${base}/is-valid`);
    this.maxOut = kidNum(cfg, "max-indicated-degsec", 6);
    const gyro = kid(cfg, "gyro");
    this.spinUp = kidNum(gyro, "spin-up-sec", 4);
    this.spinDown = kidNum(gyro, "spin-down-sec", 180);
    this.validFrom = kidNum(gyro, "gyro-spin-valid-norm", 0.93);
  }
  update(dt: number): void {
    const powered = this.ok.bool() && this.powerBtn.bool() && this.supply.num() >= this.minVolts ? 1 : 0;
    // Gyro::update
    let spin = this.spin.num() - (1 / this.spinDown) * dt;
    if (this.ok.bool()) {
      const step = (1 / this.spinDown) * dt + (1 / this.spinUp) * powered * dt;
      if (spin + step <= powered) spin += step;
    } else spin = 0;
    spin = Math.min(1, Math.max(0, spin));
    this.spin.set(spin);
    this.valid.set(spin >= this.validFrom);
    const resp = 1 - Math.pow(1 - spin, 3);
    const yaw = this.t.num("/orientation/yaw-rate-degps"), roll = 0.15 * this.t.num("/orientation/roll-rate-degps");
    const sign = Math.abs(roll) > Math.abs(yaw) ? roll : yaw;
    let rate = Math.hypot(resp * yaw, resp * roll) * (sign < 0 ? -1 : 1);
    rate = Math.min(this.maxOut, Math.max(-this.maxOut, rate)) - (1 - resp) * this.maxOut;
    this.last = lowPass(this.last, rate, dt * 50);
    this.out.set(this.last);
  }
}

const INSTRUMENTS: Record<string, new (t: PropertyTree, cfg: PNode) => Updatable> = {
  "airspeed-indicator": AirspeedIndicator,
  altimeter: Altimeter,
  "vertical-speed-indicator": VerticalSpeedIndicator,
  "magnetic-compass": MagCompass,
  "slip-skid-ball": SlipSkidBall,
  "turn-indicator": TurnIndicator,
};
const SYSTEMS: Record<string, new (t: PropertyTree, cfg: PNode) => Updatable> = {
  pitot: PitotSystem,
  static: StaticSystem,
};

/** Build systems (pitot/static) and instruments from their config files. */
export function buildInstrumentation(tree: PropertyTree, systems: PNode | undefined, instrumentation: PNode | undefined, warn: (m: string) => void) {
  const sys: Updatable[] = [];
  const inst: Updatable[] = [];
  for (const c of systems?.c ?? []) {
    const S = SYSTEMS[c.n];
    if (S) sys.push(new S(tree, c));
    else if (c.n !== "electrical") warn(`system <${c.n}> not supported`);
  }
  for (const c of instrumentation?.c ?? []) {
    const I = INSTRUMENTS[c.n];
    if (I) inst.push(new I(tree, c));
    else warn(`instrument <${c.n}> not supported`);
  }
  return {
    updateSystems: (dt: number) => sys.forEach((s) => s.update(dt)),
    updateInstruments: (dt: number) => inst.forEach((s) => s.update(dt)),
  };
}
