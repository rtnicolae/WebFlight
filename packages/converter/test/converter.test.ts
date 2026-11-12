import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseListing } from "../src/fgaddon.ts";
import { findAbsolutePropertyRefs } from "../src/jsbsim-files.ts";
import { getProp, propToNumber, readPropertyList } from "../src/proplist.ts";

describe("parseListing", () => {
  it("separates folders and files in an Allura tree page", () => {
    const html = `
      <a class="icon" href="Models" rel="nofollow" title="Models"><i class="fa fa-folder"></i>&nbsp;Models</a>
      <a class="icon" href="ask21-jsb.xml" rel="nofollow" title="ask21-jsb.xml"><i class="fa fa-file-o"></i>&nbsp;ask21-jsb.xml</a>
      <a href="./../" rel="nofollow"><b class="fa fa-folder-open-o"></b></a>`;
    expect(parseListing(html)).toEqual([
      { name: "Models", kind: "dir" },
      { name: "ask21-jsb.xml", kind: "file" },
    ]);
  });
});

describe("PropertyList reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proplist-"));
  fs.writeFileSync(
    path.join(dir, "base.xml"),
    `<?xml version="1.0"?><PropertyList>
      <controls><engines><engine><throttle>0.5</throttle></engine></engines></controls>
      <sim><view><name>a</name></view><view><name>b</name></view></sim>
    </PropertyList>`,
  );
  fs.writeFileSync(
    path.join(dir, "x-set.xml"),
    `<?xml version="1.0"?><PropertyList include="base.xml">
      <!-- overlays index 0 from the include -->
      <controls><engines><engine><throttle>1.0</throttle></engine></engines></controls>
      <sim><flight-model archive="y">jsb</flight-model><view n="5"><name>e</name></view>
        <nasal><x><script><![CDATA[ if (a < b) print("x"); ]]></script></x></nasal></sim>
      <flag type="bool">true</flag>
    </PropertyList>`,
  );
  const tree = readPropertyList(path.join(dir, "x-set.xml"), { aircraftDir: dir, aircraftName: "X" });

  it("applies includes first and overlays the file's own values", () => {
    expect(getProp(tree, "/controls/engines/engine/throttle")).toBe("1.0");
    expect(getProp(tree, "/controls/engines/engine[0]/throttle")).toBe("1.0");
  });
  it("indexes repeated elements and honours n=", () => {
    expect(getProp(tree, "/sim/view[1]/name")).toBe("b");
    expect(getProp(tree, "/sim/view[5]/name")).toBe("e");
  });
  it("reads attributes-bearing leaves and converts bools", () => {
    expect(getProp(tree, "/sim/flight-model")).toBe("jsb");
    expect(propToNumber(getProp(tree, "/flag"))).toBe(1);
  });
});

describe("findAbsolutePropertyRefs", () => {
  it("finds host properties used as element values, ignoring comments and JSBSim-relative names", () => {
    const xml = `<fdm_config>
      <!-- <input>/commented/out</input> -->
      <input>/controls/engines/engine/throttle</input>
      <input>-/systems/x[1]</input>
      <input>fcs/elevator-cmd-norm</input>
      <independentVar lookup="row">/systems/groundhandling/rudder</independentVar>
    </fdm_config>`;
    expect(findAbsolutePropertyRefs(xml)).toEqual([
      "/controls/engines/engine/throttle",
      "/systems/groundhandling/rudder",
      "/systems/x[1]",
    ]);
  });
});
