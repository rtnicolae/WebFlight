import { describe, expect, it } from "vitest";
import { boundaryLayerReflection, BL_ROUGH, buildWaveField, solveWaves, waveAt, waveLayers, type WaveLayer } from "../src/waves.ts";

/** A 2D ridge (uniform across), terrain about its mean. */
function ridge2d(nx: number, dx: number, f: (x: number) => number): Float64Array {
  const h = new Float64Array(nx);
  for (let i = 0; i < nx; i++) h[i] = f((i - nx / 2) * dx);
  const mean = h.reduce((a, b) => a + b, 0) / nx;
  return h.map((v) => v - mean);
}

describe("mountain waves: linear theory", () => {
  it("matches Queney's exact hydrostatic solution for the Witch of Agnesi (uniform U, N, rigid ground)", () => {
    const nx = 2048, dx = 200, a = 10_000, h0 = 100, U = 10, N = 0.01, l = N / U;
    const h = ridge2d(nx, dx, (x) => (h0 * a * a) / (x * x + a * a));
    const zs = [0, 800, 1600];
    const w = solveWaves(h, nx, 1, dx, [{ z0: 0, z1: Infinity, N, U, V: 0 }], zs, { bl: null });
    for (const [zi, z] of zs.entries()) {
      let err = 0, peak = 0;
      for (let i = nx / 2 - 150; i <= nx / 2 + 150; i++) {
        const x = (i - nx / 2) * dx, d = x * x + a * a;
        const exact = (U * h0 * a * ((x * x - a * a) * Math.sin(l * z) - 2 * a * x * Math.cos(l * z))) / (d * d);
        err = Math.max(err, Math.abs(w[zi]![i]! - exact));
        peak = Math.max(peak, Math.abs(exact));
      }
      expect(err).toBeLessThan(0.08 * peak); // non-hydrostatic, finite domain
    }
  });

  it("reproduces Smith, Jiang & Doyle (2006)'s worked example of boundary-layer reflection", () => {
    // U = 10 m/s, H = 100 m, C_B = C_T = 0.001 /s, λ = 12 km (k = 0.5e-3), N = 0.01 (m = 0.001).
    const { R, q } = boundaryLayerReflection(0.5e-3 * 10, [0.001, 0], { H: 100, CB: 0.001, CT: 0.001 });
    expect(R[0]).toBeCloseTo(1.41, 2); // eq. 7: 1.41 + 0.73i
    expect(R[1]).toBeCloseTo(0.73, 2);
    expect(q[0]).toBeCloseTo(0.644, 2); // eq. 17: 0.644 + 0.406i
    expect(q[1]).toBeCloseTo(0.406, 2);
  });

  // Jiang, Doyle & Smith (2006), section 2: U = 25 m/s, N 0.025 /s below 3 km and 0.01 above, a
  // bell-shaped ridge 200 m high and 2 km wide: a train of trapped lee waves.
  const trapped: WaveLayer[] = [{ z0: 0, z1: 3000, N: 0.025, U: 25, V: 0 }, { z0: 3000, z1: Infinity, N: 0.01, U: 25, V: 0 }];
  const nx = 4096, dx = 200;
  const bell = ridge2d(nx, dx, (x) => 200 / (1 + (x / 2000) ** 2));
  const amp = (w: Float32Array, fromKm: number, toKm: number) => {
    let m = 0;
    for (let i = nx / 2 + (fromKm * 1000) / dx; i < nx / 2 + (toKm * 1000) / dx; i++) m = Math.max(m, Math.abs(w[i]!));
    return m;
  };

  it("lets trapped lee waves fade downstream through the boundary layer, at the rate of the simulations", () => {
    const [w] = solveWaves(bell, nx, 1, dx, trapped, [2300], { bl: BL_ROUGH });
    const near = amp(w!, 20, 40), far = amp(w!, 100, 120);
    expect(near).toBeGreaterThan(0.3); // a lee wave of some m/s… 
    expect(far).toBeLessThan(0.5 * near);
    // Decay coefficient α = ln(near/far)/80 km: Jiang et al.'s simulations gave 0.007–0.04 /km
    // from smooth to very rough ground (Smith et al. 2006, Table 2).
    const alpha = Math.log(near / far) / 80;
    expect(alpha).toBeGreaterThan(0.005);
    expect(alpha).toBeLessThan(0.06);
  });

  it("does not hang on the numerical damping once the boundary layer absorbs the waves", () => {
    const zs = [1500, 2300, 4000];
    const a = solveWaves(bell, nx, 1, dx, trapped, zs, { eps: 1e-8 }), b = solveWaves(bell, nx, 1, dx, trapped, zs, { eps: 1e-6 });
    for (let zi = 0; zi < zs.length; zi++) {
      let d = 0, s = 0;
      for (let i = 0; i < nx; i++) (d += (a[zi]![i]! - b[zi]![i]!) ** 2), (s += a[zi]![i]! ** 2);
      expect(Math.sqrt(d / s)).toBeLessThan(0.02);
    }
  });

  it("makes layers from pressure levels: stability from potential temperature, wind towards", () => {
    const levels = [
      { altM: 800, hPa: 925, tempC: 8, fromDeg: 270, kt: 10 },
      { altM: 1500, hPa: 850, tempC: 4, fromDeg: 270, kt: 20 },
      { altM: 3000, hPa: 700, tempC: -6, fromDeg: 280, kt: 40 },
    ];
    const L = waveLayers(levels, 600, 500);
    // Base to 800 m, 800–1500 in two, 1500–3000 in three, above 3000 m.
    expect(L.map((l) => [Math.round(l.z0), Math.round(l.z1)])).toEqual([[0, 200], [200, 550], [550, 900], [900, 1400], [1400, 1900], [1900, 2400], [2400, Infinity]]);
    expect(L[1]!.N).toBeGreaterThan(0.005); // 5.7 K/km cooling < dry adiabat: stable
    expect(L[1]!.N).toBeLessThan(0.015);
    expect(L[0]!.U).toBeCloseTo((10 * 1852) / 3600, 6); // from the west: towards the east
    expect(Math.abs(L[0]!.V)).toBeLessThan(1e-9);
    // The wind follows the profile: 10 → 20 kt between 800 and 1,500 m, at the layers' middles.
    expect(L[1]!.U).toBeCloseTo((12.5 * 1852) / 3600, 6);
    expect(L[2]!.U).toBeCloseTo((17.5 * 1852) / 3600, 6);
    // A dry-adiabatic layer is neutral.
    const theta = (10 + 273.15) * (1000 / 900) ** 0.286;
    for (const l of waveLayers([{ altM: 1000, hPa: 900, tempC: 10, fromDeg: 0, kt: 10 }, { altM: 2000, hPa: 800, tempC: theta * 0.8 ** 0.286 - 273.15, fromDeg: 0, kt: 10 }], 0)) expect(l.N).toBeLessThan(1e-6);
  });

  it("builds a field round a point and looks it up", () => {
    // A north–south ridge 20 km east of the centre, westerly wind, stable.
    const mLon = 111_320 * Math.cos((45.5 * Math.PI) / 180);
    const f = buildWaveField({
      centerLatDeg: 45.5,
      centerLonDeg: 25.5,
      heightAt: (_la, lo) => 600 + 900 * Math.exp(-((((lo - 25.5) * mLon - 20_000) / 3000) ** 2)),
      levels: [
        { altM: 1500, hPa: 850, tempC: 2, fromDeg: 270, kt: 20 },
        { altM: 3000, hPa: 700, tempC: -6, fromDeg: 270, kt: 40 },
        { altM: 5500, hPa: 500, tempC: -24, fromDeg: 270, kt: 50 },
      ],
      n: 128,
      dx: 800,
    })!;
    expect(f.levels).toBeGreaterThan(20);
    // Near the ground (the lowest level, just above the mean terrain): up the ridge's windward
    // side, down its lee (higher up the waves' phase tilts upwind with height).
    const at = (eastKm: number) => waveAt(f, 45.5, 25.5 + (eastKm * 1000) / mLon, f.z0M)!;
    expect(at(17)).toBeGreaterThan(0.1);
    expect(at(23)).toBeLessThan(-0.1);
    expect(waveAt(f, 45.5 + 0.48, 25.5, 2000)).toBeUndefined(); // outside the inner part
  });
});
