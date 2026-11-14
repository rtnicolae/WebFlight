/**
 * A launch (winch or aerotow) attached to a JSBSim glider. Reads the glider's state and its
 * hitch locations from JSBSim, runs the FlightGear tow logic and writes the rope force to
 * the hitch's external force (all names verified against JSBSim's FGExternalForce.cpp):
 *   external_reactions/<name>/magnitude   [lbs]
 *   external_reactions/<name>/x|y|z       direction, BODY frame (x nose, y right, z down)
 *   external_reactions/<name>/location-{x,y,z}-in   hitch, structural frame [in]
 * The hitch names come from the aircraft (-set.xml sim/hitches/<device>/force_name_jsbsim).
 */
import type { Vec3 } from "@webflight/fdm-core";
import { mulberry32 } from "@webflight/environment";
import { AerotowRope, type AerotowConfig } from "./aerotow.ts";
import { bodyPointEcef, geodetic, type Attitude } from "./geo.ts";
import { Tug, type TugConfig } from "./tug.ts";
import type { HitchForce, MessageSink } from "./types.ts";
import { typicalTowSettings, Winch, type WinchConfig } from "./winch.ts";

const N_TO_LBS = 0.224809;
const FT = 0.3048;
const IN = 0.0254;

/** What the launch needs from the FDM (the jsbsim-wasm Fdm fits). */
export interface LaunchFdm {
  get(name: string): number;
  set(name: string, value: number): void;
}

export interface Hitches {
  /** JSBSim external force names (sim/hitches/winch|aerotow/force_name_jsbsim). */
  winch?: string;
  aerotow?: string;
  /** Aircraft-specific winch settings (sim/hitches/winch/*). */
  winchSettings?: Partial<WinchConfig>;
  aerotowSettings?: Partial<AerotowConfig>;
}

export interface LaunchAir {
  windFromDeg: number;
  windKt: number;
  /** Vertical air motion at the tug [m/s], + up. */
  upMs?: number;
}

export interface LaunchOptions {
  kind: "winch" | "aerotow";
  hitches: Hitches;
  /** Ground elevation [m] (same terrain as the FDM). */
  groundAtM: (latDeg: number, lonDeg: number) => number;
  /** Launch direction (runway heading) [deg true]. */
  headingDeg: number;
  seed?: number;
  winch?: Partial<WinchConfig>;
  aerotow?: Partial<AerotowConfig>;
  tug?: Partial<TugConfig>;
  say?: MessageSink;
}

/** Rope and tug state for drawing. */
export interface LaunchView {
  kind: "winch" | "aerotow";
  connected: boolean;
  /** Rope ends (glider hitch → other end), geodetic. */
  rope?: { from: { latDeg: number; lonDeg: number; altM: number }; to: { latDeg: number; lonDeg: number; altM: number }; slack: number };
  winch?: { latDeg: number; lonDeg: number; altM: number };
  tug?: { latDeg: number; lonDeg: number; altM: number; headingDeg: number; rollDeg: number; gone: boolean };
  forceN: number;
}

export function readAttitude(f: LaunchFdm): Attitude {
  return {
    latDeg: f.get("position/lat-geod-deg"),
    lonDeg: f.get("position/long-gc-deg"),
    altM: f.get("position/geod-alt-ft") * FT,
    phiRad: f.get("attitude/phi-rad"),
    thetaRad: f.get("attitude/theta-rad"),
    psiRad: f.get("attitude/psi-rad"),
  };
}

/** A force's location relative to the CG in body axes [m]. */
export function hitchBodyM(f: LaunchFdm, name: string): Vec3 {
  const p = (a: string) => f.get(`external_reactions/${name}/location-${a}-in`);
  const cg = (a: string) => f.get(`inertia/cg-${a}-in`);
  return [-(p("x") - cg("x")) * IN, (p("y") - cg("y")) * IN, -(p("z") - cg("z")) * IN];
}

export function applyHitchForce(f: LaunchFdm, name: string, force: HitchForce | undefined): void {
  const base = `external_reactions/${name}`;
  if (!force || !(force.forceN > 0)) {
    f.set(`${base}/magnitude`, 0);
    return;
  }
  f.set(`${base}/x`, force.dirBody[0]);
  f.set(`${base}/y`, force.dirBody[1]);
  f.set(`${base}/z`, force.dirBody[2]);
  f.set(`${base}/magnitude`, force.forceN * N_TO_LBS);
}

export class Launch {
  readonly kind: "winch" | "aerotow";
  readonly winch: Winch | undefined;
  readonly rope: AerotowRope | undefined;
  tug: Tug | undefined;
  private readonly hitchName: string;
  private readonly rand: () => number;
  private lastForce: HitchForce | undefined;

  constructor(
    private readonly fdm: LaunchFdm,
    private readonly o: LaunchOptions,
  ) {
    this.kind = o.kind;
    this.rand = mulberry32(o.seed ?? 1);
    const say = o.say ?? (() => {});
    const name = o.kind === "winch" ? o.hitches.winch : o.hitches.aerotow;
    if (!name) throw new Error(`aircraft has no ${o.kind} hitch`);
    this.hitchName = name;
    const att = readAttitude(fdm);
    const hitch = this.hitchEcef(att);
    if (o.kind === "winch") {
      const typical = typicalTowSettings(fdm.get("inertia/weight-lbs"));
      this.winch = new Winch(
        {
          typicalTowSpeedKph: typical.speedKph,
          typicalTowForceN: typical.forceN,
          ...o.hitches.winchSettings,
          ...o.winch,
        },
        this.rand,
        say,
      );
      this.winch.place(att, o.headingDeg, o.groundAtM, hitch);
    } else {
      this.rope = new AerotowRope({ ...o.hitches.aerotowSettings, ...o.aerotow }, say);
      this.tug = new Tug(att, o.headingDeg, this.rope.cfg.lengthM, o.groundAtM, this.rand, say, () => this.rope!.release(true), o.tug);
      this.rope.connect(hitch, this.tug.hitchEcef());
    }
  }

  private hitchEcef(att: Attitude): Vec3 {
    return bodyPointEcef(att, hitchBodyM(this.fdm, this.hitchName));
  }

  get connected(): boolean {
    return this.kind === "winch" ? !this.winch!.open : !this.rope!.open;
  }

  /** Start: clutch the winch / start the tow plane. */
  start(air: LaunchAir = { windFromDeg: 0, windKt: 0 }): void {
    if (this.winch) this.winch.run(this.fdm.get("position/h-agl-ft"), air.windFromDeg, air.windKt);
    else this.tug!.start();
  }

  /** Pilot opens the hook. */
  release(): void {
    this.winch?.release();
    this.rope?.release();
    applyHitchForce(this.fdm, this.hitchName, undefined);
  }

  /** Advance the launch by dt and set the hitch force for the next FDM steps. */
  update(dt: number, air: LaunchAir): HitchForce | undefined {
    const att = readAttitude(this.fdm);
    const hitch = this.hitchEcef(att);
    let force: HitchForce | undefined;
    if (this.winch) {
      const hg = geodetic(hitch);
      force = this.winch.update(dt, {
        att,
        hitch,
        hitchAltM: hg.altM,
        hitchGroundM: this.o.groundAtM(hg.latDeg, hg.lonDeg),
        aglFt: this.fdm.get("position/h-agl-ft"),
        groundspeedKt: this.fdm.get("velocities/vg-fps") * FT / 0.514444,
        windFromDeg: air.windFromDeg,
        windKt: air.windKt,
      });
    } else {
      this.tug!.update(dt, { windFromDeg: air.windFromDeg, windKt: air.windKt, upMs: air.upMs ?? 0 });
      force = this.rope!.update(att, hitch, this.tug!.hitchEcef());
    }
    this.lastForce = force;
    applyHitchForce(this.fdm, this.hitchName, force);
    return force;
  }

  view(): LaunchView {
    const att = readAttitude(this.fdm);
    const hitch = geodetic(this.hitchEcef(att));
    const v: LaunchView = { kind: this.kind, connected: this.connected, forceN: this.lastForce?.forceN ?? 0 };
    if (this.winch?.winchGeo) {
      v.winch = this.winch.winchGeo;
      if (this.connected) v.rope = { from: hitch, to: this.winch.winchGeo, slack: Math.max(0, this.winch.towLengthM - this.winch.distM) };
    }
    if (this.tug) {
      const t = this.tug;
      v.tug = { latDeg: t.latDeg, lonDeg: t.lonDeg, altM: t.altM, headingDeg: t.headingDeg, rollDeg: t.rollDeg, gone: t.gone };
      if (this.connected) v.rope = { from: hitch, to: geodetic(t.hitchEcef()), slack: Math.max(0, this.rope!.cfg.lengthM - this.rope!.distM) };
    }
    return v;
  }
}

/**
 * Hitch settings from an aircraft's FG property tree (-set.xml and its includes):
 * /sim/hitches/{winch,aerotow}/force_name_jsbsim, winch typical-tow-speed-kph,
 * typical-tow-force-N, automatic-release-angle-deg, tow/break-force.
 */
export function hitchesFromProperties(get: (path: string) => string | number | boolean | undefined): Hitches {
  const num = (p: string) => {
    const v = get(p);
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (p: string) => {
    const v = get(p);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const h: Hitches = {};
  const w = str("/sim/hitches/winch/force_name_jsbsim"), a = str("/sim/hitches/aerotow/force_name_jsbsim");
  if (w) h.winch = w;
  if (a) h.aerotow = a;
  const ws: Partial<WinchConfig> = {};
  const set = <K extends keyof WinchConfig>(k: K, v: number | undefined) => {
    if (v !== undefined) (ws as Record<string, number>)[k] = v;
  };
  set("typicalTowSpeedKph", num("/sim/hitches/winch/typical-tow-speed-kph"));
  set("typicalTowForceN", num("/sim/hitches/winch/typical-tow-force-N"));
  set("automaticReleaseAngleDeg", num("/sim/hitches/winch/automatic-release-angle-deg"));
  set("breakForceN", num("/sim/hitches/winch/tow/break-force"));
  const type = num("/sim/hitches/winch/type");
  if (type === 0 || type === 1) ws.type = type;
  h.winchSettings = ws;
  const ab = num("/sim/hitches/aerotow/tow/break-force");
  if (ab !== undefined) h.aerotowSettings = { breakForceN: ab };
  return h;
}
