import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertFgModel } from "../src/fgmodel.ts";

const AC = `AC3Db
MATERIAL "m" rgb 1 1 1  amb 0 0 0  emis 0 0 0  spec 0 0 0  shi 0  trans 0
OBJECT world
kids 1
OBJECT poly
name "needle"
texture "t.png"
numvert 3
0 0 0
1 0 0
0 1 0
numsurf 1
SURF 0x00
mat 0
refs 3
0 0 0
1 1 0
2 0 1
kids 0
`;

describe("FG model conversion: params, axes, texture and pick animations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fgmodel2-"));
  fs.mkdirSync(path.join(dir, "Models"));
  fs.writeFileSync(path.join(dir, "Models", "i.ac"), AC);
  fs.writeFileSync(path.join(dir, "Models", "t.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(
    path.join(dir, "Models", "inst.xml"),
    `<?xml version="1.0"?><PropertyList>
      <path>i.ac</path>
      <params><speed type="string">instrumentation/default</speed></params>
      <animation><type>rotate</type><object-name>needle</object-name><property alias="/params/speed"/><axis><x>-1</x></axis></animation>
      <animation><type>textranslate</type><object-name>needle</object-name><property>lcd</property><factor>0.1</factor><step>1</step><bias>0.005</bias><axis><x>1</x></axis></animation>
      <animation><type>pick</type><object-name>needle</object-name><action><button>0</button><binding><command>property-toggle</command><property>sw</property></binding></action></animation>
    </PropertyList>`,
  );
  fs.writeFileSync(
    path.join(dir, "Models", "m.xml"),
    `<?xml version="1.0"?><PropertyList>
      <model><path>inst.xml</path><overlay><params><speed>instrumentation/asi/kt</speed></params></overlay></model>
    </PropertyList>`,
  );
  const m = convertFgModel(dir, path.join(dir, "Models", "m.xml"));

  it("resolves /params aliases with the parent's overlay, and a partial <axis> has zero components", () => {
    const rot = m.animations.find((a) => a.type === "rotate");
    if (rot?.type !== "rotate") throw new Error("no rotate");
    expect(rot.value.property).toBe("/instrumentation/asi/kt");
    expect(rot.axis.map((v) => v + 0)).toEqual([-1, 0, 0]);
  });

  it("emits texture transforms with step/bias and gives those primitives their own transform material", () => {
    const tex = m.animations.find((a) => a.type === "tex");
    expect(tex).toMatchObject({ transforms: [{ kind: "translate", axis: [1, 0], value: { property: "/lcd", factor: 0.1, step: 1, bias: 0.005 } }] });
    expect(m.materials.some((x) => x.texTransform && x.image !== undefined)).toBe(true);
  });

  it("emits pick entries with their action bindings", () => {
    const pick = m.animations.find((a) => a.type === "pick");
    expect(pick).toMatchObject({ kind: "pick", nodes: ["needle"] });
    if (pick?.type !== "pick") throw new Error();
    expect(pick.action?.c?.find((c) => c.n === "binding")?.c?.find((c) => c.n === "command")?.v).toBe("property-toggle");
  });
});
