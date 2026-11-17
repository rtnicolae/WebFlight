/**
 * Tree impostors (MSFS-style): photoreal pictures of CC0 photoscanned tree models (Poly Haven,
 * rendered offline from the side and from above into public/trees/atlas.png) drawn as cards.
 * Per tree: a side card that turns about its vertical axis to face the camera, and a top card
 * at crown height; looking down (from a glider) the side card dithers out and the top card in.
 * The sim's sun lights them. They stand still: a sway (crowns ±0.25 m, nearly in step across a
 * whole forest, and twice as fast at 120 fps since it ran off the frame count) caught the eye
 * far more than wind in real trees does.
 */
import { lookGlsl } from "./lighting.ts";
import {
  ShadowMode,
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  Material,
  MaterialAppearance,
  Primitive,
  PrimitiveType,
  Transforms,
} from "cesium";

interface AtlasTree {
  name: string;
  kind: number;
  heightM: number;
  widthM: number;
  sides: [number, number, number, number][];
  top: [number, number, number, number];
}
export interface TreeAtlas {
  width: number;
  height: number;
  trees: AtlasTree[];
  url: string;
}

export async function loadTreeAtlas(base: string): Promise<TreeAtlas> {
  const spec = (await (await fetch(`${base}trees/atlas.json`)).json()) as Omit<TreeAtlas, "url">;
  return { ...spec, url: `${base}trees/atlas.png` };
}

const VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 corner;   // x across (-0.5..0.5), y up (0..1), z: 0 side card, 1 top card
in vec2 size;     // width, height [m]
in vec4 rect;     // atlas u0, v0, du, dv
in vec3 tint;     // per-tree colour factor
in float batchId;
out vec2 v_st;
out float v_fade;
out float v_y;
out vec3 v_upEC;
out vec3 v_nEC;
out vec3 v_positionEC;
out vec3 v_tint;
void main() {
  v_tint = tint;
  vec4 p = czm_computePosition();
  // Positions may be in the tile's local frame (Cesium keeps the instance's model matrix):
  // work out up/right in world space, then bring the offsets back into model space.
  mat3 m3 = mat3(czm_model);
  vec3 world = (czm_model * vec4(position3DHigh + position3DLow, 1.0)).xyz;
  vec3 up = normalize(world);
  vec3 toCam = normalize(czm_viewerPositionWC - world);
  float elev = dot(toCam, up);
  vec3 offset;
  if (corner.z < 0.5) {
    vec3 right = normalize(cross(up, toCam));
    offset = right * corner.x * size.x + up * corner.y * size.y;
    v_fade = 1.0 - smoothstep(0.86, 0.98, elev);
    // A rounded crown's normal on the flat card: out to the sides, up towards the top, and
    // towards the viewer in the middle, so the tree has a sunlit and a shaded side.
    v_nEC = mat3(czm_view) * normalize(right * corner.x * 1.8 + up * (corner.y - 0.4) * 1.3 + normalize(toCam - up * elev) * 0.7);
  } else {
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    offset = east * corner.x * size.x + north * (corner.y - 0.5) * size.x + up * size.y * 0.62;
    v_fade = smoothstep(0.7, 0.92, elev);
    v_nEC = mat3(czm_view) * normalize(east * corner.x * 1.6 + north * (corner.y - 0.5) * 1.6 + up * 0.8);
  }
  p.xyz += offset * m3; // world → model (m3 is a rotation: its transpose is its inverse)
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz; // for receiving shadows
  v_st = rect.xy + vec2(corner.x + 0.5, corner.y) * rect.zw;
  v_y = corner.z < 0.5 ? corner.y : 1.0;
  v_upEC = mat3(czm_view) * up;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const FS = `
in vec2 v_st;
in float v_fade;
in float v_y;
in vec3 v_upEC;
in vec3 v_nEC;
in vec3 v_positionEC;
in vec3 v_tint;
void main() {
  czm_materialInput mi;
  mi.st = v_st;
  czm_material m = czm_getMaterial(mi);
  float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  if (m.alpha < 0.5 || h > v_fade) discard;
  // Lit like the buildings: sky light plus the sun (or moon) on the side facing it, wrapped a
  // little round the crown (leaves scatter light).
  float sun = max((dot(normalize(v_nEC), czm_lightDirectionEC) + 0.3) / 1.3, 0.0);
  vec3 c = m.diffuse * v_tint * (0.72 * LOOK_AMBIENT + 0.75 * sun * czm_lightColor) * (0.86 + 0.14 * v_y);
  out_FragColor = vec4(c, 1.0);
}`;

let material: Material | undefined;
function atlasMaterial(atlas: TreeAtlas): Material {
  material ??= new Material({
    fabric: {
      type: "TreeAtlas",
      uniforms: { image: atlas.url },
      source: `czm_material czm_getMaterial(czm_materialInput mi) {
        czm_material m = czm_getDefaultMaterial(mi);
        vec4 c = texture(image, mi.st);
        m.diffuse = c.rgb;
        m.alpha = c.a;
        return m;
      }`,
    },
    translucent: false,
  });
  return material;
}

/** One Primitive for a cell's trees (instances: 5 floats each, see treeInstances). */
export function treeImpostors(atlas: TreeAtlas, origin: [number, number, number], inst: Float32Array, shadows = false): Primitive | undefined {
  const n = inst.length / 5;
  if (!n) return undefined;
  const broad = atlas.trees.filter((t) => t.kind === 0), con = atlas.trees.filter((t) => t.kind === 1);
  const pos = new Float64Array(n * 8 * 3), corner = new Float32Array(n * 8 * 3), size = new Float32Array(n * 8 * 2), rect = new Float32Array(n * 8 * 4), tint = new Float32Array(n * 8 * 3);
  const idx = new Uint32Array(n * 12);
  const W = atlas.width, H = atlas.height;
  for (let i = 0; i < n; i++) {
    const [e, nn, z, h, ks] = [inst[i * 5]!, inst[i * 5 + 1]!, inst[i * 5 + 2]!, inst[i * 5 + 3]!, inst[i * 5 + 4]!];
    const kind = Math.floor(ks), f = ks - kind;
    // A species whose natural size suits this tree: one of the three closest in height
    // (a 6 m fir is a young fir, not a shrunken 20 m one).
    const pool = (kind === 1 ? con : broad).slice().sort((a, b) => Math.abs(Math.log(h / a.heightM)) - Math.abs(Math.log(h / b.heightM)));
    const t = pool[Math.floor(f * Math.min(3, pool.length))] ?? atlas.trees[0]!;
    const side = t.sides[Math.floor(((f * 7.31) % 1) * t.sides.length)]!;
    const mirror = (f * 13.7) % 1 < 0.5;
    // Each tree its own proportions and tone: slimmer or broader, lighter or darker, a little
    // towards yellow-green or blue-green (stands of one species are never uniform).
    const w = ((h * t.widthM) / t.heightM) * (0.85 + 0.3 * ((f * 29.3) % 1));
    const br = 0.8 + 0.34 * ((f * 41.7) % 1), hue = ((f * 57.1) % 1) - 0.5;
    const tn = [br * (1 + 0.16 * hue), br, br * (1 - 0.22 * hue)];
    // Cesium samples material textures with v up (images are flipped on upload).
    const r = (c: [number, number, number, number], flip: boolean): [number, number, number, number] => {
      const [x, y, cw, ch] = c;
      const u0 = flip ? (x + cw) / W : x / W, du = flip ? -cw / W : cw / W;
      return [u0, 1 - (y + ch) / H, du, ch / H];
    };
    const sr = r(side, mirror), tr = r(t.top, false);
    const corners: [number, number, number][] = [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0], [-0.5, 0, 1], [0.5, 0, 1], [0.5, 1, 1], [-0.5, 1, 1]];
    for (let k = 0; k < 8; k++) {
      const v = i * 8 + k;
      pos.set([e, nn, z], v * 3);
      corner.set(corners[k]!, v * 3);
      size.set([w, h], v * 2);
      rect.set(k < 4 ? sr : tr, v * 4);
      tint.set(tn, v * 3);
    }
    idx.set([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7].map((q) => q + i * 8), i * 12);
  }
  const geometry = new Geometry({
    attributes: Object.assign(new GeometryAttributes(), {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      corner: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: corner }),
      size: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: size }),
      rect: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, values: rect }),
      tint: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: tint }),
    }),
    indices: idx,
    primitiveType: PrimitiveType.TRIANGLES,
    // The cards grow from their bases in the shader: pad the bounds by the tallest tree.
    boundingSphere: (() => {
      const b = BoundingSphere.fromVertices(Array.from(pos));
      b.radius += 30;
      return b;
    })(),
  });
  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry, modelMatrix: Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin[0], origin[1], origin[2])) }),
    appearance: new MaterialAppearance({
      material: atlasMaterial(atlas),
      vertexShaderSource: VS,
      fragmentShaderSource: lookGlsl(FS),
      translucent: false,
      closed: false,
      renderState: { depthTest: { enabled: true }, cull: { enabled: false } },
    }),
    asynchronous: false,
    compressVertices: false,
    allowPicking: false,
    // In a building's or a hill's shadow, trees are in shadow too.
    shadows: shadows ? ShadowMode.RECEIVE_ONLY : ShadowMode.DISABLED,
  });
}
