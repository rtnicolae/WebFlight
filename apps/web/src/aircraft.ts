/**
 * The aircraft's visual model: places the glTF from the FDM snapshot (VRP + attitude) and
 * drives its FlightGear animations from FDM outputs, pilot controls and -set.xml defaults.
 */
import { Axis, Matrix4, Model, type ModelNode, type Scene } from "cesium";
import {
  controlsToFgProperties,
  fgOutputSource,
  modelMatrixEcef,
  structuralToBodyFt,
  type AirbrakeRoute,
  type BundleManifestCore,
  type FgControls,
  type SnapshotLayout,
} from "@webflight/fdm-core";
import { AnimationRig } from "./animations.ts";

const D2R = Math.PI / 180;

export class AircraftView {
  readonly rig: AnimationRig;
  /** JSBSim properties the animations need in the snapshot. */
  readonly snapshotProperties: string[];
  private readonly sources = new Map<string, { name: string; scale: number }>();
  private readonly nodes = new Map<string, ModelNode>();
  private readonly ecef = new Float64Array(16);
  private readonly scratch = new Matrix4();
  private fgControls: Record<string, number> = {};
  private model: Model | undefined;

  constructor(
    private readonly manifest: BundleManifestCore,
    private readonly bundleUrl: string,
  ) {
    this.rig = new AnimationRig(manifest.model.animations);
    const defaults = manifest.model.properties;
    const maxComp = (n: number) => {
      const base = n === 0 ? "/gear/gear" : `/gear/gear[${n}]`;
      const ft = Number(defaults[`${base}/max-compression-ft`] ?? 0);
      const m = Number(defaults[`${base}/max-compression-m`] ?? 0);
      return ft > 1e-5 ? ft : m > 1e-5 ? m / 0.3048 : 1;
    };
    for (const p of this.rig.properties) {
      const s = fgOutputSource(p, maxComp);
      if (s) this.sources.set(p, { name: s.jsbsim, scale: s.scale });
    }
    this.snapshotProperties = [...new Set([...this.sources.values()].map((s) => s.name))];
  }

  async load(scene: Scene): Promise<void> {
    this.model = await Model.fromGltfAsync({
      url: new URL(this.manifest.model.file, this.bundleUrl).href,
      // The glTF is in AC3D axes; the model matrix does the full transform.
      upAxis: Axis.Z,
      forwardAxis: Axis.X,
      backFaceCulling: true,
    });
    scene.primitives.add(this.model);
    await new Promise<void>((resolve) => {
      const m = this.model!;
      if (m.ready) resolve();
      else m.readyEvent.addEventListener(() => resolve());
    });
    for (const name of this.rig.nodeNames) {
      const node = this.model.getNode(name);
      if (node) this.nodes.set(name, node);
    }
  }

  get loaded(): boolean {
    return !!this.model?.ready;
  }

  setControls(c: FgControls, airbrake: AirbrakeRoute): void {
    this.fgControls = controlsToFgProperties(c, airbrake);
  }

  /** Update pose and animations from the latest snapshot. Returns the ECEF model matrix. */
  update(data: Float64Array, layout: SnapshotLayout, dt: number): Float64Array {
    const g = (n: string) => data[layout.at(n)]!;
    modelMatrixEcef(
      {
        latGeodRad: g("position/lat-geod-deg") * D2R,
        lonRad: g("position/long-gc-deg") * D2R,
        geodAltFt: g("position/geod-alt-ft"),
        phiRad: g("attitude/phi-rad"),
        thetaRad: g("attitude/theta-rad"),
        psiRad: g("attitude/psi-rad"),
        vrpBodyFt: structuralToBodyFt(
          [g("metrics/visualrefpoint-x-in"), g("metrics/visualrefpoint-y-in"), g("metrics/visualrefpoint-z-in")],
          [g("inertia/cg-x-in"), g("inertia/cg-y-in"), g("inertia/cg-z-in")],
        ),
      },
      this.ecef,
    );
    if (this.model) {
      this.model.modelMatrix = Matrix4.fromArray(this.ecef as unknown as number[], 0, this.model.modelMatrix);
      const defaults = this.manifest.model.properties;
      this.rig.update((p) => {
        const s = this.sources.get(p);
        if (s) return data[layout.at(s.name)]! * s.scale;
        if (p in this.fgControls) return this.fgControls[p];
        const d = defaults[p];
        return d === null || d === undefined ? undefined : d;
      }, dt);
      for (const [name, node] of this.nodes) {
        const st = this.rig.state.get(name)!;
        node.matrix = Matrix4.fromArray(st.matrix as unknown as number[], 0, this.scratch);
        node.show = st.show;
      }
    }
    return this.ecef;
  }
}
