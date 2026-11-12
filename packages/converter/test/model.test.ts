import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAc3d } from "../src/ac3d.ts";
import { buildGlb } from "../src/glb.ts";
import { convertFgModel } from "../src/fgmodel.ts";

/** Two quads: a parent at loc (1,0,0) and a kid rotated 90° about y at loc (0,0,2) relative to it. */
const AC = `AC3Db
MATERIAL "white" rgb 1 1 1  amb 0.2 0.2 0.2  emis 0 0 0  spec 0.5 0.5 0.5  shi 64  trans 0
MATERIAL "glass" rgb 0.4 0.4 0.4  amb 0.2 0.2 0.2  emis 0 0 0  spec 0.5 0.5 0.5  shi 64  trans 0.8
OBJECT world
name "root"
kids 3
OBJECT poly
name "wing"
loc 1 0 0
numvert 4
0 0 0
1 0 0
1 0 1
0 0 1
numsurf 1
SURF 0x10
mat 0
refs 4
0 0 0
3 0 1
2 1 1
1 1 0
kids 1
OBJECT poly
name "aileron"
rot 0 0 -1 0 1 0 1 0 0
loc 0 0 2
numvert 3
0 0 0
1 0 0
0 1 0
numsurf 1
SURF 0x20
mat 1
refs 3
0 0 0
1 1 0
2 0 1
kids 0
OBJECT poly
name "engine"
numvert 3
0 0 0
1 0 0
0 1 0
numsurf 1
SURF 0x00
mat 0
refs 3
0 0 0
1 0 0
2 0 0
kids 0
OBJECT poly
name "hinge"
numvert 2
0 0 5
2 0 5
numsurf 1
SURF 0x02
mat 0
refs 2
0 0 0
1 0 0
kids 0
`;

describe("AC3D", () => {
  it("bakes loc/rot down the hierarchy", () => {
    const ac = parseAc3d(AC);
    const wing = ac.root.kids[0]!;
    expect(wing.vertices[1]).toEqual([2, 0, 0]);
    const ail = wing.kids[0]!;
    // rot maps local x (1,0,0) to (0,0,1); then loc (0,0,2), then parent loc (1,0,0).
    expect(ail.vertices[1]).toEqual([1, 0, 3]);
    expect(ac.materials[1]!.trans).toBe(0.8);
  });
});

describe("FG model conversion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fgmodel-"));
  fs.mkdirSync(path.join(dir, "Models"));
  fs.writeFileSync(path.join(dir, "Models", "m.ac"), AC);
  fs.writeFileSync(path.join(dir, "Models", "sub.ac"), AC);
  fs.writeFileSync(
    path.join(dir, "Models", "sub.xml"),
    `<?xml version="1.0"?><PropertyList><path>sub.ac</path></PropertyList>`,
  );
  fs.writeFileSync(
    path.join(dir, "Models", "m.xml"),
    `<?xml version="1.0"?><PropertyList>
      <path>m.ac</path>
      <animation><name>EngineComplete</name><object-name>engine</object-name></animation>
      <animation><name>Inner</name><object-name>engine</object-name></animation>
      <animation>
        <type>select</type><object-name>EngineComplete</object-name>
        <condition><equals><property>sim/model/variant</property><value>1</value></equals></condition>
      </animation>
      <animation>
        <type>rotate</type><object-name>aileron</object-name>
        <property>surface-positions/left-aileron-pos-norm</property><factor>-24</factor>
        <axis><x1-m>0</x1-m><y1-m>0</y1-m><z1-m>0</z1-m><x2-m>2</x2-m><y2-m>0</y2-m><z2-m>0</z2-m></axis>
      </animation>
      <animation>
        <type>translate</type><object-name>wing</object-name>
        <property>gear/gear[0]/compression-norm</property><axis><z>1</z></axis>
      </animation>
      <animation>
        <type>rotate</type><object-name>engine</object-name><property>x</property>
        <axis><object-name>hinge</object-name></axis>
      </animation>
      <model><name>Sub</name><path>sub.xml</path><offsets><x-m>1</x-m><z-m>2</z-m></offsets></model>
      <animation><type>select</type><object-name>Sub</object-name><condition><property>sim/show-sub</property></condition></animation>
    </PropertyList>`,
  );
  const m = convertFgModel(dir, path.join(dir, "Models", "m.xml"));

  it("converts animations into the AC frame with SimGear semantics", () => {
    const rot = m.animations.find((a) => a.type === "rotate" && a.nodes[0] === "aileron")!;
    expect(rot.type).toBe("rotate");
    if (rot.type !== "rotate") throw new Error();
    // Axis from two points: centre at the midpoint, FG (1,0,0) stays (1,0,0) in AC.
    expect(rot.center).toEqual([1, 0, 0]);
    expect(rot.axis.map((v) => v + 0)).toEqual([1, 0, 0]);
    expect(rot.value).toEqual({ property: "/surface-positions/left-aileron-pos-norm", start: 0, factor: -24, offset: 0 });
    const tr = m.animations.find((a) => a.type === "translate")!;
    // FG +z (up) is AC +y.
    if (tr.type !== "translate") throw new Error();
    expect(tr.axis.map((v) => v + 0)).toEqual([0, 1, 0]);
    expect(tr.value.property).toBe("/gear/gear/compression-norm");
    // Axis from a line object (already AC coordinates).
    const hinge = m.animations.find((a) => a.type === "rotate" && a.nodes[0] === "engine")!;
    if (hinge.type !== "rotate") throw new Error();
    expect(hinge.center).toEqual([1, 0, 5]);
  });

  it("nests named groups where their objects were, so outer selects still apply", () => {
    const parentOf = (name: string) => m.nodes.find((n) => n.children.some((c) => m.nodes[c]!.name === name))?.name;
    expect(parentOf("engine")).toBe("Inner");
    expect(parentOf("Inner")).toBe("EngineComplete");
    expect(m.animations.find((a) => a.type === "select" && a.nodes[0] === "EngineComplete")).toMatchObject({
      condition: { op: "eq", a: { prop: "/sim/model/variant" }, b: { value: 1 } },
    });
  });

  it("loads submodels with offsets and lets animations refer to them by name", () => {
    const sel = m.animations.find((a) => a.type === "select" && a.nodes[0]?.startsWith("model:Models/sub.xml"));
    expect(sel).toBeDefined();
    // Submodel geometry is offset by FG (1, 0, 2) = AC (1, 2, 0).
    const wings = m.nodes.filter((n) => n.name.startsWith("wing"));
    const pos = (n: (typeof wings)[number]) => n.primitives![0]!.positions;
    expect(pos(wings[1]!)[0]! - pos(wings[0]!)[0]!).toBeCloseTo(1, 6);
    expect(pos(wings[1]!)[1]! - pos(wings[0]!)[1]!).toBeCloseTo(2, 6);
    expect(m.properties).toContain("/sim/show-sub");
  });

  it("writes a valid GLB with one material per AC material/sidedness", () => {
    const glb = buildGlb(m.nodes, m.roots, m.materials, m.images);
    const dv = new DataView(glb.buffer, glb.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
    expect(json.nodes.length).toBe(m.nodes.length);
    expect(json.materials.some((x: { alphaMode?: string; doubleSided: boolean }) => x.alphaMode === "BLEND" && x.doubleSided)).toBe(true);
    // Line objects produce no triangles.
    expect(json.nodes.find((n: { name: string }) => n.name === "hinge").mesh).toBeUndefined();
  });
});
