/**
 * Cockpit interaction: FlightGear pick / knob / slider animations driven by the mouse.
 *  - click: run the control's <action> bindings (mouse-up runs <mod-up>)
 *  - wheel over a knob/slider: <increase>/<decrease>, or the action with offset ±1
 *  - hover: pointer cursor and the control's tooltip label
 * Bindings execute in the FDM worker (fg-host), where the property tree lives.
 */
import { Cartesian2, type Viewer } from "cesium";
import type { AircraftView } from "./aircraft.ts";
import type { ChaseCamera } from "./camera.ts";
import type { PickEntry } from "./animations.ts";
import type { ToWorker } from "./protocol.ts";

export class CockpitInteraction {
  private held: PickEntry[] = [];
  private lastHover = 0;
  /** Count of fired actions (diagnostics/tests). */
  fired = 0;

  constructor(
    private readonly viewer: Viewer,
    private readonly aircraft: AircraftView,
    private readonly send: (m: ToWorker) => void,
    private readonly cam: ChaseCamera,
  ) {
    const canvas = viewer.scene.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const entries = this.pickAt(e.clientX, e.clientY);
      if (!entries.length) return;
      this.cam.suspended = true;
      this.held = entries;
      for (const p of entries) if (p.action) this.fire(p.action, "down");
    });
    window.addEventListener("pointerup", () => {
      if (!this.held.length) return;
      for (const p of this.held) if (p.action) this.fire(p.action, "up");
      this.held = [];
      this.cam.suspended = false;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        const entries = this.pickAt(e.clientX, e.clientY).filter((p) => p.kind === "knob" || p.kind === "slider" || p.increase || p.decrease);
        if (!entries.length) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? 1 : -1;
        for (const p of entries) {
          const inc = dir > 0 ? p.increase : p.decrease;
          if (inc) this.fire(inc, "down");
          else if (p.action) this.fire(p.action, "down", dir);
        }
      },
      { passive: false },
    );
    canvas.addEventListener("pointermove", (e) => {
      const now = performance.now();
      if (now - this.lastHover < 120 || this.held.length) return;
      this.lastHover = now;
      const entries = this.pickAt(e.clientX, e.clientY);
      canvas.style.cursor = entries.length ? "pointer" : "";
      canvas.title = entries.find((p) => p.tooltip)?.tooltip?.replace(/%s|%%|%d/g, "").trim() ?? "";
    });
  }

  private fire(action: NonNullable<PickEntry["action"]>, phase: "down" | "up", offset?: number): void {
    this.fired++;
    this.send({ type: "action", action, phase, ...(offset !== undefined ? { offset } : {}) });
  }

  /** Pick entries under a screen position (empty if not on an interactive part). */
  pickAt(clientX: number, clientY: number): PickEntry[] {
    const model = this.aircraft.gltfModel;
    if (!model) return [];
    const rect = this.viewer.scene.canvas.getBoundingClientRect();
    const picked = this.viewer.scene.pick(new Cartesian2(clientX - rect.left, clientY - rect.top)) as
      | { primitive?: unknown; detail?: { node?: { _name?: string } } }
      | undefined;
    if (!picked || picked.primitive !== model) return [];
    const name = picked.detail?.node?._name;
    return name ? this.aircraft.picksFor(name) : [];
  }
}
