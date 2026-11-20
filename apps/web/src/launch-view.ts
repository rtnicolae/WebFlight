/**
 * What a launch looks like: the tow plane (FGData's AI DR400, as FlightGear's drag robot
 * uses), the winch (FGData's supacat winch), and the rope between the glider's hitch and the
 * tug/winch. Positions come from the FDM worker's snapshot under FG property names.
 */
import { ENVIRONMENT_MAP_ONCE, lightModel, LOOK } from "./lighting.ts";
import { Axis, Cartesian3, Color, Material, Matrix4, Model, PolylineCollection, type ModelNode, type Polyline, type Scene } from "cesium";
import { modelMatrixEcef, type AnimationEntry, type SnapshotLayout } from "@webflight/fdm-core";
import { AnimationRig } from "./animations.ts";

const D2R = Math.PI / 180;

export const LAUNCH_PROPERTIES = [
  "/sim/hitches/rope/exist",
  "/sim/hitches/rope/start-lat-deg",
  "/sim/hitches/rope/start-lon-deg",
  "/sim/hitches/rope/start-alt-m",
  "/sim/hitches/rope/end-lat-deg",
  "/sim/hitches/rope/end-lon-deg",
  "/sim/hitches/rope/end-alt-m",
  "/sim/hitches/rope/slack-m",
  "/sim/hitches/rope/force-N",
  "/sim/hitches/winch/open",
  "/sim/hitches/aerotow/open",
  "/sim/hitches/winch/winch/exist",
  "/sim/hitches/winch/winch/latitude-deg",
  "/sim/hitches/winch/winch/longitude-deg",
  "/sim/hitches/winch/winch/altitude-m",
  "/sim/hitches/winch/winch/heading-deg",
  "/sim/hitches/winch/winch/rel-speed",
  "/sim/hitches/winch/tow/length",
  "/ai/models/dragger/valid",
  "/ai/models/dragger/position/latitude-deg",
  "/ai/models/dragger/position/longitude-deg",
  "/ai/models/dragger/position/altitude-ft",
  "/ai/models/dragger/orientation/true-heading-deg",
  "/ai/models/dragger/orientation/roll-deg",
  "/ai/models/dragger/velocities/true-airspeed-kt",
];

interface SharedManifest {
  model: { file: string; animations: AnimationEntry[] };
}

/** A converted FGData model placed by position/heading/roll, with its FG animations. */
class SharedModelView {
  private model: Model | undefined;
  private rig: AnimationRig | undefined;
  private readonly nodes = new Map<string, ModelNode>();
  private readonly ecef = new Float64Array(16);
  private readonly scratch = new Matrix4();

  constructor(
    private readonly baseUrl: string,
    /** AI-relative animation properties ("velocities/…") resolve under this prefix. */
    private readonly propPrefix: string,
  ) {}

  async load(scene: Scene): Promise<void> {
    const res = await fetch(new URL("manifest.json", this.baseUrl));
    if (!res.ok) throw new Error(`${this.baseUrl}: ${res.status} (run pnpm bundle:models)`);
    const m = (await res.json()) as SharedManifest;
    this.rig = new AnimationRig(m.model.animations);
    this.model = await Model.fromGltfAsync({ url: new URL(m.model.file, this.baseUrl).href, upAxis: Axis.Z, forwardAxis: Axis.X, backFaceCulling: true, environmentMapOptions: ENVIRONMENT_MAP_ONCE });
    lightModel(this.model);
    this.model.show = false;
    scene.primitives.add(this.model);
    await new Promise<void>((resolve) => (this.model!.ready ? resolve() : this.model!.readyEvent.addEventListener(() => resolve())));
    for (const n of this.rig.nodeNames) {
      const node = this.model.getNode(n);
      if (node) this.nodes.set(n, node);
    }
  }

  update(show: boolean, pose: { latDeg: number; lonDeg: number; altM: number; headingDeg: number; rollDeg: number }, get: (p: string) => number | undefined, dt: number): void {
    if (!this.model?.ready) return;
    this.model.show = show;
    if (!show) return;
    modelMatrixEcef({ latGeodRad: pose.latDeg * D2R, lonRad: pose.lonDeg * D2R, geodAltFt: pose.altM / 0.3048, phiRad: pose.rollDeg * D2R, thetaRad: 0, psiRad: pose.headingDeg * D2R, vrpBodyFt: [0, 0, 0] }, this.ecef);
    this.model.modelMatrix = Matrix4.fromArray(this.ecef as unknown as number[], 0, this.model.modelMatrix);
    this.rig!.update((p) => get(p) ?? get(this.propPrefix + p), dt);
    for (const [name, node] of this.nodes) {
      const st = this.rig!.state.get(name)!;
      node.matrix = Matrix4.fromArray(st.matrix as unknown as number[], 0, this.scratch);
      node.show = st.show;
    }
  }
}

export class LaunchView {
  private readonly tug: SharedModelView;
  private readonly winch: SharedModelView;
  private readonly ropes = new PolylineCollection();
  private readonly rope: Polyline;
  private readonly pts = Array.from({ length: 17 }, () => new Cartesian3());

  constructor(
    private readonly scene: Scene,
    modelsUrl: string,
  ) {
    this.tug = new SharedModelView(new URL("dr400/", modelsUrl).href, "/ai/models/dragger");
    this.winch = new SharedModelView(new URL("winch/", modelsUrl).href, "");
    scene.primitives.add(this.ropes);
    this.rope = this.ropes.add({ positions: this.pts, width: 2, material: Material.fromType("Color", { color: Color.multiplyByScalar(Color.fromCssColorString("#f4e9c8"), LOOK.ground, new Color()).withAlpha(1) }), show: false });
  }

  async load(): Promise<void> {
    await Promise.all([this.tug.load(this.scene), this.winch.load(this.scene)]);
  }

  /** `groundM`: ground elevation under the glider (the rope can't sag below it). */
  update(data: Float64Array, layout: SnapshotLayout, dt: number, groundM: number): void {
    const get = (p: string): number | undefined => {
      const i = layout.index.get(p);
      return i === undefined ? undefined : data[i];
    };
    const g = (p: string) => get(p) ?? NaN;
    this.tug.update(
      g("/ai/models/dragger/valid") === 1,
      { latDeg: g("/ai/models/dragger/position/latitude-deg"), lonDeg: g("/ai/models/dragger/position/longitude-deg"), altM: g("/ai/models/dragger/position/altitude-ft") * 0.3048, headingDeg: g("/ai/models/dragger/orientation/true-heading-deg"), rollDeg: g("/ai/models/dragger/orientation/roll-deg") },
      get,
      dt,
    );
    this.winch.update(
      g("/sim/hitches/winch/winch/exist") === 1,
      { latDeg: g("/sim/hitches/winch/winch/latitude-deg"), lonDeg: g("/sim/hitches/winch/winch/longitude-deg"), altM: g("/sim/hitches/winch/winch/altitude-m"), headingDeg: g("/sim/hitches/winch/winch/heading-deg"), rollDeg: 0 },
      get,
      dt,
    );
    const exist = g("/sim/hitches/rope/exist") === 1;
    this.rope.show = exist;
    if (!exist) return;
    // Straight line from hitch to hitch, sagging by its slack (parabola, s = √(3/8 · d · slack)).
    const a = Cartesian3.fromDegrees(g("/sim/hitches/rope/start-lon-deg"), g("/sim/hitches/rope/start-lat-deg"), g("/sim/hitches/rope/start-alt-m"));
    const b = Cartesian3.fromDegrees(g("/sim/hitches/rope/end-lon-deg"), g("/sim/hitches/rope/end-lat-deg"), g("/sim/hitches/rope/end-alt-m"));
    const d = Cartesian3.distance(a, b);
    // A slack rope near the ground lies on it: no sag below the lower end's height.
    const lowEnd = Math.min(g("/sim/hitches/rope/start-alt-m"), g("/sim/hitches/rope/end-alt-m")) - groundM;
    const sag = Math.max(0, Math.min(0.3 * d, lowEnd - 0.05, Math.sqrt(0.375 * d * Math.max(0, g("/sim/hitches/rope/slack-m"))) + 0.002 * d));
    const up = Cartesian3.normalize(Cartesian3.add(a, b, new Cartesian3()), new Cartesian3());
    const n = this.pts.length - 1;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      Cartesian3.lerp(a, b, s, this.pts[i]!);
      Cartesian3.add(this.pts[i]!, Cartesian3.multiplyByScalar(up, -4 * sag * s * (1 - s), new Cartesian3()), this.pts[i]!);
    }
    this.rope.positions = this.pts;
  }
}
