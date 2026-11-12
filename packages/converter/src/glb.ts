/** Minimal glTF 2.0 binary (.glb) builder: nodes, meshes, PBR materials, embedded images. */

export interface GlbMaterial {
  name: string;
  baseColor: [number, number, number, number];
  emissive: [number, number, number];
  roughness: number;
  doubleSided: boolean;
  /** Index into images; undefined = untextured. */
  image?: number;
}

export interface GlbPrimitive {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
  material: number;
}

export interface GlbNode {
  name: string;
  children: number[];
  primitives?: GlbPrimitive[];
}

export interface GlbImage {
  mimeType: "image/png" | "image/jpeg";
  data: Uint8Array;
}

const pad4 = (n: number) => (n + 3) & ~3;

export function buildGlb(nodes: readonly GlbNode[], roots: readonly number[], materials: readonly GlbMaterial[], images: readonly GlbImage[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];

  const addView = (bytes: Uint8Array, target?: number): number => {
    const offset = byteLength;
    chunks.push(bytes);
    const padded = pad4(bytes.byteLength);
    if (padded > bytes.byteLength) chunks.push(new Uint8Array(padded - bytes.byteLength));
    byteLength += padded;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const addAccessor = (arr: Float32Array | Uint32Array, type: "SCALAR" | "VEC2" | "VEC3", minMax = false): number => {
    const view = addView(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), arr instanceof Uint32Array ? 34963 : 34962);
    const comps = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
    const acc: Record<string, unknown> = {
      bufferView: view,
      componentType: arr instanceof Uint32Array ? 5125 : 5126,
      count: arr.length / comps,
      type,
    };
    if (minMax) {
      const min = [Infinity, Infinity, Infinity].slice(0, comps);
      const max = [-Infinity, -Infinity, -Infinity].slice(0, comps);
      for (let i = 0; i < arr.length; i++) {
        const c = i % comps;
        min[c] = Math.min(min[c]!, arr[i]!);
        max[c] = Math.max(max[c]!, arr[i]!);
      }
      acc["min"] = min;
      acc["max"] = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const gltfImages = images.map((img) => ({ bufferView: addView(img.data), mimeType: img.mimeType }));
  const meshes: object[] = [];
  const gltfNodes = nodes.map((n) => {
    const node: Record<string, unknown> = { name: n.name };
    if (n.children.length) node["children"] = n.children;
    if (n.primitives?.length) {
      meshes.push({
        name: n.name,
        primitives: n.primitives.map((p) => ({
          attributes: {
            POSITION: addAccessor(p.positions, "VEC3", true),
            NORMAL: addAccessor(p.normals, "VEC3"),
            ...(p.uvs ? { TEXCOORD_0: addAccessor(p.uvs, "VEC2") } : {}),
          },
          indices: addAccessor(p.indices, "SCALAR"),
          material: p.material,
        })),
      });
      node["mesh"] = meshes.length - 1;
    }
    return node;
  });

  const json = {
    asset: { version: "2.0", generator: "webflight converter (AC3D)" },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes: gltfNodes,
    meshes,
    materials: materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColor,
        metallicFactor: 0,
        roughnessFactor: m.roughness,
        ...(m.image !== undefined ? { baseColorTexture: { index: m.image } } : {}),
      },
      emissiveFactor: m.emissive,
      doubleSided: m.doubleSided,
      ...(m.baseColor[3] < 1 ? { alphaMode: "BLEND" } : {}),
    })),
    textures: images.map((_, i) => ({ source: i, sampler: 0 })),
    images: gltfImages,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    buffers: [{ byteLength }],
    accessors,
    bufferViews,
  };
  if (images.length === 0) {
    delete (json as Partial<typeof json>).textures;
    delete (json as Partial<typeof json>).images;
    delete (json as Partial<typeof json>).samplers;
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLen + 8 + byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  let o = 20 + jsonLen;
  dv.setUint32(o, byteLength, true);
  dv.setUint32(o + 4, 0x004e4942, true); // BIN
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
