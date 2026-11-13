/** Chase camera (smoothed heading, fixed elevation) and cockpit camera. */
import { Cartesian3, HeadingPitchRange, Math as CMath, Matrix4, type Camera } from "cesium";

export type ViewMode = "chase" | "cockpit";

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class ChaseCamera {
  mode: ViewMode = "chase";
  range = 22;
  /** Orbit offsets around the aircraft (mouse drag), radians. */
  orbit = { heading: 0, pitch: 0 };
  private heading: number | undefined;
  /** Cockpit field of view (wheel zooms). */
  fovDeg: number;
  private readonly target = new Cartesian3();
  private readonly eye = new Cartesian3();

  constructor(
    private readonly camera: Camera,
    /** Cockpit eye in glTF/AC axes [m] and default pitch. */
    private readonly cockpit: { eye: readonly number[]; pitchDeg: number; fovDeg: number },
  ) {
    this.fovDeg = cockpit.fovDeg;
    let drag: { x: number; y: number } | undefined;
    window.addEventListener("pointerdown", (e) => {
      if (!this.suspended) drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointerup", () => (drag = undefined));
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.orbit.heading += (e.clientX - drag.x) * 0.006;
      this.orbit.pitch = Math.max(-1.4, Math.min(1.2, this.orbit.pitch - (e.clientY - drag.y) * 0.006));
      drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("dblclick", () => (this.orbit = { heading: 0, pitch: 0 }));
    window.addEventListener("wheel", (e) => {
      if (this.suspended) return;
      if (this.mode === "cockpit") {
        this.fovDeg = Math.min(100, Math.max(15, this.fovDeg * Math.exp(e.deltaY * 0.001)));
        return;
      }
      this.range = Math.min(300, Math.max(8, this.range * Math.exp(e.deltaY * 0.001)));
    }, { passive: true });
  }

  /** Drag handling is suspended while a cockpit control is being operated. */
  suspended = false;

  toggle(): void {
    this.mode = this.mode === "chase" ? "cockpit" : "chase";
    this.orbit = { heading: 0, pitch: 0 };
    this.fovDeg = this.cockpit.fovDeg;
    this.camera.lookAtTransform(Matrix4.IDENTITY);
    this.heading = undefined;
  }

  /** `m` is the model's ECEF matrix (column-major); attitude in radians. */
  update(m: Float64Array, att: { phi: number; theta: number; psi: number }, dt: number): void {
    const xf = (v: readonly number[], out: Cartesian3) =>
      Cartesian3.fromElements(
        m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!,
        m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!,
        m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!,
        out,
      );
    const frustum = this.camera.frustum as { fov?: number };
    if (this.mode === "cockpit") {
      if (frustum.fov !== undefined) frustum.fov = CMath.toRadians(this.fovDeg);
      xf(this.cockpit.eye, this.eye);
      this.camera.setView({
        destination: this.eye,
        // Mouse drag looks around the cockpit (orbit offsets as head turn).
        orientation: { heading: att.psi + this.orbit.heading, pitch: att.theta + CMath.toRadians(this.cockpit.pitchDeg) + this.orbit.pitch, roll: att.phi },
      });
      return;
    }
    if (frustum.fov !== undefined) frustum.fov = CMath.toRadians(60);
    // Look at a point slightly above the VRP; follow heading with a lag.
    xf([0, 0.6, 0], this.target);
    if (this.heading === undefined) this.heading = att.psi;
    this.heading += wrapPi(att.psi - this.heading) * Math.min(1, dt / 0.8);
    const pitch = Math.max(-1.5, Math.min(1.4, CMath.toRadians(-9) + this.orbit.pitch));
    this.camera.lookAt(this.target, new HeadingPitchRange(this.heading + this.orbit.heading, pitch, this.range));
  }
}
