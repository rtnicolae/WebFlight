/**
 * The aircraft's visual model: placed from the FDM snapshot (VRP + attitude), animated from
 * FG properties published by fg-host in the same snapshot (defaults from the manifest),
 * with texture (UV) animations and cockpit picking.
 */
import { Axis, Matrix3, Matrix4, Model, type ModelNode, type Scene } from "cesium";
import { modelMatrixEcef, structuralToBodyFt, type BundleManifestCore, type SnapshotLayout } from "@webflight/fdm-core";
import { AnimationRig, type PickEntry } from "./animations.ts";

const D2R = Math.PI / 180;

interface TexReader {
  transform: Matrix3;
}

export class AircraftView {
  readonly rig: AnimationRig;
  /** FG properties the animations need in the snapshot. */
  readonly snapshotProperties: string[];
  private readonly nodes = new Map<string, ModelNode>();
  /** Animated tex node → texture readers of the textured primitives in its subtree. */
  private readonly texReaders = new Map<string, TexReader[]>();
  private readonly parents: Record<string, string>;
  private readonly ecef = new Float64Array(16);
  private readonly scratch = new Matrix4();
  private model: Model | undefined;
  /** Diagnostics: tex nodes whose readers could not be found. */
  readonly texMissing: string[] = [];

  constructor(
    private readonly manifest: BundleManifestCore,
    private readonly bundleUrl: string,
  ) {
    this.rig = new AnimationRig(manifest.model.animations);
    this.parents = manifest.model.parents ?? {};
    const defaults = manifest.model.properties;
    // String-valued properties (e.g. livery names) stay at their defaults; the snapshot is numeric.
    this.snapshotProperties = this.rig.properties.filter((p) => {
      const d = defaults[p];
      return !(typeof d === "string" && !Number.isFinite(Number(d)));
    });
  }

  get gltfModel(): Model | undefined {
    return this.model;
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
    // Texture-animated nodes: collect the base-colour texture readers in their subtrees. The
    // converter gave those primitives their own materials with KHR_texture_transform, which
    // Cesium reads through `textureReader.transform` on every draw (MaterialPipelineStage).
    const children = new Map<string, string[]>();
    for (const [c, p] of Object.entries(this.parents)) (children.get(p) ?? children.set(p, []).get(p)!).push(c);
    for (const [name, st] of this.rig.state) {
      if (!st.uv) continue;
      const readers: TexReader[] = [];
      const visit = (n: string) => {
        const runtime = (this.model!.getNode(n) as unknown as { _runtimeNode?: { runtimePrimitives?: { primitive?: { material?: { metallicRoughness?: { baseColorTexture?: TexReader } } } }[] } })?._runtimeNode;
        for (const rp of runtime?.runtimePrimitives ?? []) {
          const r = rp.primitive?.material?.metallicRoughness?.baseColorTexture;
          // Only readers the converter flagged (non-identity at load); never touch shared identity.
          if (r?.transform && r.transform !== Matrix3.IDENTITY && !Matrix3.equals(r.transform, Matrix3.IDENTITY)) readers.push(r);
        }
        for (const c of children.get(n) ?? []) visit(c);
      };
      visit(name);
      if (readers.length) this.texReaders.set(name, readers);
      else this.texMissing.push(name);
    }
  }

  get loaded(): boolean {
    return !!this.model?.ready;
  }

  /** Pick entries for a picked glTF node: the node's own, or its nearest ancestor's. */
  picksFor(nodeName: string): PickEntry[] {
    for (let n: string | undefined = nodeName; n; n = this.parents[n]) {
      const e = this.rig.picks.get(n);
      if (e?.length) return e;
    }
    return [];
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
        const i = layout.index.get(p);
        if (i !== undefined) return data[i]!;
        const d = defaults[p];
        return d === null || d === undefined ? undefined : d;
      }, dt);
      for (const [name, node] of this.nodes) {
        const st = this.rig.state.get(name)!;
        node.matrix = Matrix4.fromArray(st.matrix as unknown as number[], 0, this.scratch);
        node.show = st.show;
        if (st.uv) {
          const readers = this.texReaders.get(name);
          if (readers) for (const r of readers) r.transform = Matrix3.fromArray(st.uv as unknown as number[]);
        }
      }
    }
    return this.ecef;
  }
}
