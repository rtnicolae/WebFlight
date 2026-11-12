/**
 * Thin, host-independent wrapper around JSBSim WASM (@0x62/jsbsim-wasm).
 * No browser or Node APIs: the same class runs in a Web Worker and in Node.
 */
import { JSBSimSdk, TrimMode, type LoadJSBSimModuleOptions } from "@0x62/jsbsim-wasm";
import { wasmBinaryUrl, wasmModuleUrl } from "@0x62/jsbsim-wasm/wasm";
import type { IcProperty, InitialConditions } from "./props.ts";

/** A JSBSim aircraft as files in memory (produced by the converter). */
export interface AircraftFiles {
  /** Folder name, e.g. "ASK21". */
  aircraft: string;
  /** JSBSim model name: `<model>.xml` must be in `files`. */
  model: string;
  /** Paths relative to the JSBSim aircraft directory. */
  files: Record<string, string | Uint8Array>;
  /** Host-owned (FlightGear) properties the FDM reads, with defaults. */
  hostProperties?: Record<string, number>;
}

export interface FdmOptions {
  /** Fixed integration rate. Default 120 Hz. */
  rateHz?: number;
  moduleUrl?: LoadJSBSimModuleOptions["moduleUrl"];
  wasmUrl?: LoadJSBSimModuleOptions["wasmUrl"];
  /** Receives every JSBSim stdout/stderr line. */
  onLog?: (line: string) => void;
  /** JSBSim debug level (0 = quiet). Default 0. */
  debugLevel?: number;
}

/** JSBSim C++ exceptions reach JS as bare numbers; the reason is only in the log. */
export class FdmError extends Error {
  constructor(
    message: string,
    readonly jsbsimLog: readonly string[],
  ) {
    super(`${message}\n  JSBSim log (last lines):\n    ${jsbsimLog.join("\n    ")}`);
    this.name = "FdmError";
  }
}

const IC_ORDER: readonly IcProperty[] = [
  // Terrain and position before altitude, altitude before speeds (calibrated/equivalent
  // speeds depend on density), speeds before angles.
  "ic/terrain-elevation-ft",
  "ic/lat-geod-deg",
  "ic/long-gc-deg",
  "ic/h-sl-ft",
  "ic/h-agl-ft",
  "ic/vw-north-fps",
  "ic/vw-east-fps",
  "ic/vw-down-fps",
  "ic/vc-kts",
  "ic/ve-kts",
  "ic/vt-kts",
  "ic/psi-true-deg",
  "ic/phi-deg",
  "ic/beta-deg",
  "ic/gamma-deg",
  "ic/alpha-deg",
  "ic/theta-deg",
];

export class Fdm {
  readonly dt: number;
  private readonly recentLog: string[] = [];
  private loaded: AircraftFiles | undefined;

  private constructor(
    private readonly sdk: JSBSimSdk,
    rateHz: number,
  ) {
    this.dt = 1 / rateHz;
  }

  static async create(opts: FdmOptions = {}): Promise<Fdm> {
    const sdk = await JSBSimSdk.create({
      moduleUrl: opts.moduleUrl ?? wasmModuleUrl,
      wasmUrl: opts.wasmUrl ?? wasmBinaryUrl,
      log: { console: false, stripAnsi: true },
    });
    const fdm = new Fdm(sdk, opts.rateHz ?? 120);
    sdk.on("log", (e) => {
      fdm.recentLog.push(e.message);
      if (fdm.recentLog.length > 40) fdm.recentLog.shift();
      opts.onLog?.(e.message);
    });
    sdk.setDebugLevel(opts.debugLevel ?? 0);
    return fdm;
  }

  private guard<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new FdmError(`${what} failed (JSBSim exception ${String(err)})`, this.recentLog.slice(-12));
    }
  }

  /** Load an aircraft. Can be called once per Fdm instance. */
  load(ac: AircraftFiles): void {
    if (this.loaded) throw new Error("Fdm.load: an aircraft is already loaded; create a new Fdm");
    const base = `aircraft/${ac.aircraft}`;
    for (const [rel, data] of Object.entries(ac.files)) this.sdk.writeDataFile(`${base}/${rel}`, data);
    const ok = this.guard("loadModel", () =>
      this.sdk.loadModel(base, `${base}/Engines`, `${base}/Systems`, ac.model, false),
    );
    if (!ok) throw new FdmError(`loadModel(${ac.model}) returned false`, this.recentLog.slice(-12));
    for (const [p, v] of Object.entries(ac.hostProperties ?? {})) this.sdk.setPropertyValue(p, v);
    this.sdk.setDt(this.dt);
    this.loaded = ac;
  }

  get(property: string): number {
    return this.sdk.getPropertyValue(property);
  }

  set(property: string, value: number): void {
    this.sdk.setPropertyValue(property, value);
  }

  get simTime(): number {
    return this.sdk.getSimTime();
  }

  /** Write ic/* properties in a dependency-safe order. Call runIc() afterwards. */
  setInitialConditions(ic: InitialConditions): void {
    for (const key of IC_ORDER) {
      const v = ic[key];
      if (v !== undefined) this.sdk.setPropertyValue(key, v);
    }
  }

  /** Apply the initial conditions (also evaluates all models once, dt = 0). */
  runIc(): void {
    const ok = this.guard("RunIC", () => this.sdk.runIc());
    if (!ok) throw new FdmError("RunIC returned false", this.recentLog.slice(-12));
  }

  /** Advance n fixed steps. */
  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      const ok = this.guard("Run", () => this.sdk.run());
      if (!ok) throw new FdmError(`Run returned false at t=${this.simTime}`, this.recentLog.slice(-12));
    }
  }

  /**
   * While set, JSBSim filters and actuators pass their input straight through
   * (FGFCS trim status), so RunIC evaluates the settled control-surface positions.
   */
  setTrimStatus(on: boolean): void {
    this.sdk.setTrimStatus(on);
  }

  /** JSBSim's built-in trim. Note: tLongitudinal needs thrust; it fails for gliders. */
  doTrim(mode: TrimMode): void {
    this.guard("DoTrim", () => this.sdk.doTrim(mode));
  }

  /** Property catalog lines ("name (RW)") under a prefix. */
  propertyCatalog(prefix = ""): string[] {
    return this.sdk
      .queryPropertyCatalog(prefix)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  destroy(): void {
    this.sdk.destroy();
  }
}

export { TrimMode };
