import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "@webflight/converter";
import { Fdm, loadBundleAircraft, P } from "@webflight/fdm-core";
import { ASK21, ensureAircraft } from "../src/gliders.ts";

describe("ASK21 web bundle", () => {
  let out: string;
  let manifest: ReturnType<typeof buildBundle>;
  beforeAll(async () => {
    const dir = await ensureAircraft(ASK21);
    out = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-"));
    manifest = buildBundle(dir, ASK21.setFile, out);
  }, 300_000);

  it("has the control-surface animations, defaults and input profile", () => {
    const surf = manifest.model.animations.filter((a) => a.type !== "select" && a.value.property?.startsWith("/surface-positions/"));
    const nodes = new Set(surf.flatMap((a) => a.nodes));
    for (const n of ["aileronL", "aileronR", "elevator", "rudder", "speedbrakeL", "speedbrakeR"]) expect(nodes).toContain(n);
    expect(manifest.model.properties["/sim/model/variant"]).toBe(0);
    expect(manifest.input.airbrake).toEqual({ property: "/controls/engines/engine/throttle", invert: true });
    expect(manifest.views.cockpit.eye[0]).toBeLessThan(-2); // forward of the VRP
    expect(manifest.stats.triangles).toBeGreaterThan(50_000);
  });

  it("loads into fdm-core through the same reader the browser worker uses", async () => {
    const dir = path.join(out, "ASK21");
    const { files } = await loadBundleAircraft((rel) => fs.readFile(path.join(dir, rel), "utf8"));
    const fdm = await Fdm.create();
    fdm.load(files);
    fdm.setInitialConditions({ "ic/h-agl-ft": 1000, "ic/vc-kts": 45, "ic/lat-geod-deg": 47, "ic/long-gc-deg": 8 });
    fdm.runIc();
    expect(fdm.get("fcs/speedbrake-pos-norm")).toBe(0);
    fdm.step(120);
    expect(fdm.get(P.hAglFt)).toBeLessThan(1000);
    fdm.destroy();
  }, 30_000);
});
