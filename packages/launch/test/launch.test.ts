import { describe, expect, it } from "vitest";
import { mulberry32 } from "@webflight/environment";
import { AerotowRope, bodyPointEcef, directionInBody, ecef, geodetic, Tug, Winch } from "../src/index.ts";
import { offset } from "../src/geo.ts";

const level = { latDeg: 47, lonDeg: 7, altM: 500, phiRad: 0, thetaRad: 0, psiRad: 0 };
const D2R = Math.PI / 180;

describe("rope geometry", () => {
  it("expresses rope directions in body axes (x nose, y right, z down)", () => {
    const from = ecef(47, 7, 500);
    const ahead = ecef(...offset(47, 7, 0, 100), 500);
    const right = ecef(...offset(47, 7, 90, 100), 500);
    expect(directionInBody(level, from, ahead).dir[0]).toBeCloseTo(1, 3);
    expect(directionInBody(level, from, right).dir[1]).toBeCloseTo(1, 3);
    expect(directionInBody(level, from, ecef(47, 7, 400)).dir[2]).toBeCloseTo(1, 6); // below = +z
    // Heading east: the point ahead (north) is to the left.
    expect(directionInBody({ ...level, psiRad: 90 * D2R }, from, ahead).dir[1]).toBeCloseTo(-1, 3);
    // Pitched up 30°: a point straight ahead on the horizon is below the nose (body z > 0).
    const d = directionInBody({ ...level, thetaRad: 30 * D2R }, from, ahead).dir;
    expect(d[0]).toBeCloseTo(Math.cos(30 * D2R), 3);
    expect(d[2]).toBeCloseTo(Math.sin(30 * D2R), 3);
  });

  it("places body points and moves on the ellipsoid consistently with ECEF distances", () => {
    const p = bodyPointEcef({ ...level, psiRad: 90 * D2R }, [10, 0, 0]);
    const g = geodetic(p);
    expect(g.lonDeg).toBeGreaterThan(7);
    expect(g.altM).toBeCloseTo(500, 3);
    for (const course of [0, 67, 180, 290]) {
      const [lat, lon] = offset(47.18, 7.41, course, 999);
      const d = Math.hypot(...[0, 1, 2].map((i) => ecef(lat, lon, 430)[i]! - ecef(47.18, 7.41, 430)[i]!));
      expect(Math.abs(d - 999)).toBeLessThan(0.1);
    }
  });
});

describe("aerotow rope (hitch.nas)", () => {
  it("is slack below its length, then F = k·stretch/length, and breaks at the weak link", () => {
    const rope = new AerotowRope({ elasticConstant: 9111, lengthM: 60, breakForceN: 5000 });
    const glider = ecef(47, 7, 500);
    expect(rope.connect(glider, ecef(...offset(47, 7, 0, 50), 500))).toBe(true);
    expect(rope.update(level, glider, ecef(...offset(47, 7, 0, 59), 500))?.forceN).toBe(0);
    const f = rope.update(level, glider, ecef(...offset(47, 7, 0, 66), 500))!;
    expect(Math.abs(f.forceN - (9111 * 6) / 60)).toBeLessThan(2);
    expect(f.dirBody[0]).toBeCloseTo(1, 3);
    expect(rope.update(level, glider, ecef(...offset(47, 7, 0, 100), 500))).toBeUndefined();
    expect(rope.broken).toBe(true);
    expect(rope.open).toBe(true);
  });

  it("won't lock when the tug is out of reach", () => {
    const rope = new AerotowRope();
    expect(rope.connect(ecef(47, 7, 500), ecef(...offset(47, 7, 0, 80), 500))).toBe(false);
    expect(rope.open).toBe(true);
  });
});

describe("winch (hitch.nas winch())", () => {
  const setup = (type: 0 | 1) => {
    const w = new Winch({ type, typicalTowSpeedKph: 100, typicalTowForceN: 6000 }, mulberry32(1));
    const hitch = ecef(47, 7, 430.5);
    w.place({ latDeg: 47, lonDeg: 7 }, 0, () => 430, hitch);
    return { w, hitch };
  };
  const input = (hitch: number[]) => ({ att: { ...level, altM: 431 }, hitch: hitch as [number, number, number], hitchAltM: 430.5, hitchGroundM: 430, aglFt: 2, groundspeedKt: 0, windFromDeg: 0, windKt: 0 });

  it("lays out the cable 999 m ahead and locks; no force until clutched", () => {
    const { w, hitch } = setup(0);
    expect(w.open).toBe(false);
    expect(w.distM).toBeCloseTo(999, 6);
    // Only the hanging rope's weight (FG adds weight-per-m · g · height even when slack).
    expect(w.update(0.01, input(hitch))?.forceN ?? 0).toBeCloseTo(0.1 * 9.81 * 0.5, 6);
  });

  it("type 0: the drum accelerates at 8 m/s² to 40 m/s and the rope force is capped at 10 kN / 123 kW", () => {
    const { w, hitch } = setup(0);
    w.run(2, 0, 0);
    let f = 0;
    for (let i = 0; i < 300; i++) f = w.update(0.01, input(hitch))?.forceN ?? 0; // glider held: rope stretches
    expect(w.spoolSpeedMs).toBeLessThanOrEqual(40);
    expect(f).toBeGreaterThan(0);
    expect(w.actualForceN).toBeLessThanOrEqual(10_000);
    expect(w.actualForceN * Math.max(0, w.spoolSpeedMs)).toBeLessThanOrEqual(123_000 + 1);
  });

  it("type 1: the winch driver ramps the force while the glider is held", () => {
    const { w, hitch } = setup(1);
    w.run(2, 0, 0);
    const s = input(hitch);
    w.update(0.01, s);
    const f1 = w.actualForceN;
    for (let i = 0; i < 100; i++) w.update(0.01, { ...s, groundspeedKt: 2 });
    expect(w.actualForceN).toBeGreaterThan(f1 + 500); // +1000 N/s
    expect(w.phase).toBe(2);
  });

  it("rope breakage training: releases above the set height", () => {
    const w = new Winch({ type: 1, typicalTowSpeedKph: 100, typicalTowForceN: 6000, ropeBreakage: 50 }, mulberry32(1));
    const hitch = ecef(47, 7, 430.5);
    w.place({ latDeg: 47, lonDeg: 7 }, 0, () => 430, hitch);
    w.update(0.01, { ...input(hitch), hitchAltM: 470 });
    expect(w.open).toBe(false);
    w.update(0.01, { ...input(hitch), hitchAltM: 490 });
    expect(w.open).toBe(true);
  });
});

describe("tow plane (dragrobot.nas)", () => {
  it("starts 40.8 m ahead on a 60 m rope, tautens slowly, then takes off at 20 m/s", () => {
    const tug = new Tug({ latDeg: 47, lonDeg: 7, altM: 431 }, 0, 60, () => 430, mulberry32(3));
    const d0 = Math.hypot(...[0, 1, 2].map((i) => ecef(tug.latDeg, tug.lonDeg, 430)[i]! - ecef(47, 7, 430)[i]!));
    expect(d0).toBeCloseTo(60 * 0.68, 1);
    tug.start();
    let t = 0;
    while (tug.legType === 0 && t < 60) {
      tug.update(0.05, { windFromDeg: 0, windKt: 0, upMs: 0 });
      t += 0.05;
    }
    expect(tug.legType).toBe(2);
    expect(tug.speedMs).toBeGreaterThan(20);
    expect(tug.altM).toBeCloseTo(430, 6); // still on the ground
    for (let i = 0; i < 400; i++) tug.update(0.05, { windFromDeg: 0, windKt: 0, upMs: 0 });
    expect(tug.altM).toBeGreaterThan(440); // climbing
  });
});
