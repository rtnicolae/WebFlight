/**
 * Mountain waves: the vertical air motion of stably stratified flow over the real terrain, from
 * the linear theory of mountain waves, with the day's wind and temperature by height.
 *
 *  - Linear, Boussinesq, non-hydrostatic flow over terrain, solved per horizontal wavenumber
 *    with the terrain's Fourier transform (Queney 1948, Scorer 1949, Smith 1979 and 1980): in each
 *    layer of constant stability N and wind (U, V) the vertical velocity is
 *    ŵ = A·e^{imz} + B·e^{−imz}, m² = K²(N²/σ² − 1), σ = kU + lV the intrinsic frequency.
 *  - Layers meet with continuous vertical displacement ŵ/σ and pressure σ·∂ŵ/∂z (Jiang, Doyle &
 *    Smith 2006, section 2a); above the top level, radiation (waves go up and away).
 *  - Where the wind along a wave turns through zero (a critical level, the wind turning with
 *    height) the wave is absorbed, what passes cut by e^{−π√(Ri − ¼)} (Booker & Bretherton 1967,
 *    J. Fluid Mech. 27, 513–539).
 *  - At the ground the boundary layer partly absorbs the waves (Smith, Jiang & Doyle 2006,
 *    "A theory of gravity wave absorption by a boundary layer", J. Atmos. Sci. 63, 774–781): its
 *    lower condition (their eq. 22) ŵ = γ/(im)·∂ŵ/∂z + iσĥ, γ = i(U/U_B)·H·m·R̂ with the boundary
 *    layer's wind response R̂ = (iσ + C_T)/(iσ_B + C_B + C_T) (eq. 6) and U_B/U = C_T/(C_B + C_T)
 *    (eq. 3). Trapped lee waves then fade downstream and shorten, as simulated by Jiang et al.
 *    (2006); with a rigid ground they would ring on for ever and their strength would rest on
 *    whatever numerical damping was chosen. The boundary layer's values are the authors' set for
 *    rough ground (their section 8: H 128 m, C_B = C_T = 0.0035 s⁻¹), which their fit of energy
 *    absorbed against roughness (eq. 28) puts at a roughness length near 1 m: forest and
 *    mountains, the Carpathians'.
 *
 * Numerics only: a 102 km square (256², 400 m) round a point, the terrain's mean removed and
 * its outer 12 % tapered to it (the transform's domain wraps round); a vanishing damping
 * (1e-8 s⁻¹) keeps critical levels (where the wind turns across a wave's crests) finite. The
 * answer is the undamped limit (12 Nov 2026 over the Bucegi: 0.5 % rms change from 1e-8 to 1e-9,
 * 0.1 % to 1e-10) and does not depend on the grid (256² at 400 m vs 512² at 200 m: correlation
 * 0.999). The profile is followed in layers of at most 62.5 m (halving them changed that day's
 * field by 4–12 % from 2.8 to 6.4 km, by up to 20 % below 1.6 km where the wind was light and
 * turned sharply).
 *
 * Linear theory assumes the terrain is low against U/N; over the Carpathians in strong winds it
 * is not, and real flow can be weaker (blocked) or stronger (breaking, rotors, which it lacks).
 */

type C = [number, number];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const csub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const cexp = (a: C): C => {
  const e = Math.exp(a[0]);
  return [e * Math.cos(a[1]), e * Math.sin(a[1])];
};
const csqrt = (a: C): C => {
  const r = Math.hypot(a[0], a[1]);
  return [Math.sqrt((r + a[0]) / 2), (a[1] < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (r - a[0]) / 2))];
};
const I: C = [0, 1];

function fft1(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!, ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const p = i + k, q = p + h;
        const vr = re[q]! * cr - im[q]! * ci, vi = re[q]! * ci + im[q]! * cr;
        re[q] = re[p]! - vr;
        im[q] = im[p]! - vi;
        re[p] = re[p]! + vr;
        im[p] = im[p]! + vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) (re[i] = re[i]! / n), (im[i] = im[i]! / n);
}

/** In-place 2D FFT of an nx × ny grid (row-major, powers of two). */
function fft2(re: Float64Array, im: Float64Array, nx: number, ny: number, inv: boolean): void {
  const r = new Float64Array(nx), i2 = new Float64Array(nx);
  if (nx > 1)
    for (let y = 0; y < ny; y++) {
      r.set(re.subarray(y * nx, y * nx + nx));
      i2.set(im.subarray(y * nx, y * nx + nx));
      fft1(r, i2, inv);
      re.set(r, y * nx);
      im.set(i2, y * nx);
    }
  if (ny > 1) {
    const c = new Float64Array(ny), ci = new Float64Array(ny);
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) (c[y] = re[y * nx + x]!), (ci[y] = im[y * nx + x]!);
      fft1(c, ci, inv);
      for (let y = 0; y < ny; y++) (re[y * nx + x] = c[y]!), (im[y * nx + x] = ci[y]!);
    }
  }
}

/** A layer of constant stability and wind; heights above the base (the mean terrain) [m]. */
export interface WaveLayer {
  z0: number;
  z1: number;
  /** Brunt–Väisälä frequency [1/s]. */
  N: number;
  /** Wind towards east and north [m/s]. */
  U: number;
  V: number;
}

/** A pressure level of the weather. */
export interface SoundingLevel {
  altM: number;
  hPa: number;
  tempC: number;
  fromDeg: number;
  kt: number;
}

/**
 * Layers from the pressure levels above `baseM` [m MSL]: between two levels the wind is linear in
 * height and the potential temperature too (θ = T·(1000/p)^0.286), so N² = (g/θ)·Δθ/Δz is the
 * interval's; the interval is cut into layers no thicker than `maxDzM` with the wind at their
 * middle, so the profile is followed closely (layers of constant wind 1 km apart put steps in
 * the field where the wind jumps). Below the lowest level its wind, above the top level the top
 * one. Unstable or neutral air gets N = 0: no waves, only flow over the hills fading with height.
 */
export function waveLayers(levels: SoundingLevel[], baseM: number, maxDzM = 62.5): WaveLayer[] {
  const L = levels.filter((l) => l.altM > baseM + 50).sort((a, b) => a.altM - b.altM);
  if (!L.length) return [];
  const theta = (l: SoundingLevel) => (l.tempC + 273.15) * (1000 / l.hPa) ** 0.286;
  const uv = (l: SoundingLevel): [number, number] => {
    const to = ((l.fromDeg + 180) * Math.PI) / 180, ms = (l.kt * 1852) / 3600;
    return [ms * Math.sin(to), ms * Math.cos(to)];
  };
  const N = (a: SoundingLevel, b: SoundingLevel) => {
    const th = (theta(a) + theta(b)) / 2, N2 = ((9.81 / th) * (theta(b) - theta(a))) / (b.altM - a.altM);
    return Math.sqrt(Math.max(0, N2));
  };
  const out: WaveLayer[] = [];
  const first = L[0]!, [u0, v0] = uv(first);
  // From the base to the first level: its wind, the stability of the first interval.
  const n0 = L.length > 1 ? N(first, L[1]!) : 0;
  if (first.altM - baseM > 1) out.push({ z0: 0, z1: first.altM - baseM, N: n0, U: u0, V: v0 });
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i]!, b = L[i + 1]!, [ua, va] = uv(a), [ub, vb] = uv(b), nn = N(a, b);
    const parts = Math.max(1, Math.ceil((b.altM - a.altM) / maxDzM));
    for (let k = 0; k < parts; k++) {
      const f = (k + 0.5) / parts;
      out.push({ z0: a.altM + ((b.altM - a.altM) * k) / parts - baseM, z1: a.altM + ((b.altM - a.altM) * (k + 1)) / parts - baseM, N: nn, U: ua + (ub - ua) * f, V: va + (vb - va) * f });
    }
  }
  const top = L[L.length - 1]!, [ut, vt] = uv(top);
  out.push({ z0: top.altM - baseM, z1: Infinity, N: L.length > 1 ? N(L[L.length - 2]!, top) : 0, U: ut, V: vt });
  return out;
}

/** Smith, Jiang & Doyle (2006)'s boundary layer: displacement depth H [m], friction at the ground and at its top [1/s]. */
export interface BoundaryLayer {
  H: number;
  CB: number;
  CT: number;
}

/** Their set for rough ground (section 8): roughness length ~1 m by their eq. 28. */
export const BL_ROUGH: BoundaryLayer = { H: 128, CB: 0.0035, CT: 0.0035 };

/**
 * The boundary layer's wind response R̂ (eq. 6), γ = i(U/U_B)·H·m·R̂ and the reflection
 * coefficient q̂ = (1 + γ)/(1 − γ) (eq. 16), for a disturbance of intrinsic frequency σ = kU
 * [1/s] with vertical wavenumber m (complex [re, im]).
 */
export function boundaryLayerReflection(sigma: number, m: [number, number], bl: BoundaryLayer): { R: [number, number]; gamma: [number, number]; q: [number, number] } {
  const ub = bl.CT / (bl.CB + bl.CT); // U_B/U (eq. 3)
  const R = cdiv([bl.CT, sigma], [bl.CB + bl.CT, sigma * ub]);
  const gamma = cmul(I, cmul([bl.H / ub, 0], cmul(m, R)));
  return { R, gamma, q: cdiv(cadd([1, 0], gamma), csub([1, 0], gamma)) };
}

export interface WaveOptions {
  /** The boundary layer at the ground (default BL_ROUGH); null: a rigid ground (classical theory). */
  bl?: BoundaryLayer | null;
  /** Damping [1/s] for critical levels (default 1e-8: the undamped limit). */
  eps?: number;
}

/**
 * Vertical velocity [m/s] on an nx × ny grid (spacing dx [m]; terrain h [m] about its mean,
 * row-major, row 0 the southernmost) at heights `zs` above the mean terrain [m] (negative ones:
 * at 0).
 */
export function solveWaves(h: Float64Array, nx: number, ny: number, dx: number, layers: WaveLayer[], zs: number[], o: WaveOptions = {}): Float32Array[] {
  const bl = o.bl === undefined ? BL_ROUGH : o.bl, eps = o.eps ?? 1e-8;
  const re = Float64Array.from(h), im = new Float64Array(nx * ny);
  fft2(re, im, nx, ny, false);
  const out = zs.map(() => ({ re: new Float64Array(nx * ny), im: new Float64Array(nx * ny) }));
  const nL = layers.length, d = layers.map((L) => L.z1 - L.z0);
  const layerOf = zs.map((z) => {
    const zz = Math.max(0, z);
    const j = layers.findIndex((L) => zz >= L.z0 && zz < L.z1);
    return { j: j < 0 ? nL - 1 : j, zp: zz - layers[j < 0 ? nL - 1 : j]!.z0 };
  });
  const sig: C[] = new Array(nL), ms: C[] = new Array(nL), q: C[] = new Array(nL), A: C[] = new Array(nL), crit: boolean[] = new Array(nL).fill(false);
  for (let jy = 0; jy < ny; jy++)
    for (let jx = 0; jx < nx; jx++) {
      const k = (2 * Math.PI * (jx <= nx / 2 ? jx : jx - nx)) / (nx * dx), l = ny === 1 ? 0 : (2 * Math.PI * (jy <= ny / 2 ? jy : jy - ny)) / (ny * dx);
      const K2 = k * k + l * l, idx = jy * nx + jx;
      if (K2 === 0) continue;
      for (let j = 0; j < nL; j++) {
        const L = layers[j]!;
        sig[j] = [k * L.U + l * L.V, -eps];
        let m = csqrt(cmul([K2, 0], csub(cdiv([L.N * L.N, 0], cmul(sig[j]!, sig[j]!)), [1, 0])));
        if (m[1] < 0) m = [-m[0], -m[1]];
        ms[j] = m;
      }
      // Critical levels: where the wind along the wave (σ/K) changes sign between layers. Booker &
      // Bretherton (1967): a wave is absorbed there, not reflected, and what passes is cut by
      // e^{−π√(Ri − ¼)}. So each run of layers between critical levels radiates at its top (no wave
      // comes back down from it), and the next run starts from the attenuated wave.
      // (Without this the waves bounce off near-zero-wind layers and the answer hangs on the layering.)
      for (let j = 0; j < nL; j++) crit[j] = j > 0 && Math.sign(sig[j]![0]) !== Math.sign(sig[j - 1]![0]) && sig[j - 1]![0] !== 0;
      // Down from each run's top: in layer j, ŵ = A·(e^{imz'} + q·e^{im(2d − z')}), z' from its bottom.
      for (let j = nL - 1; j >= 0; j--) {
        if (j === nL - 1 || crit[j + 1]) {
          q[j] = [0, 0];
          continue;
        }
        const mu = ms[j + 1]!, rho: C = j + 1 === nL - 1 || crit[j + 2] ? [0, 0] : cmul(q[j + 1]!, cexp(cmul([0, 2 * d[j + 1]!], mu)));
        // ŵ'/ŵ at the bottom of layer j+1, carried across the interface: × (σ_{j+1}/σ_j)².
        const Rup = cdiv(cmul(I, cmul(mu, csub([1, 0], rho))), cadd([1, 0], rho));
        const s = cdiv(sig[j + 1]!, sig[j]!);
        const R = cmul(Rup, cmul(s, s));
        const imj = cmul(I, ms[j]!);
        q[j] = cdiv(csub(imj, R), cadd(imj, R));
      }
      const rhoOf = (j: number): C => (j === nL - 1 || crit[j + 1] ? [0, 0] : cmul(q[j]!, cexp(cmul([0, 2 * d[j]!], ms[j]!))));
      // Up from the ground: ŵ(0) − G·ŵ'(0) = iσ₀ĥ, G = γ/(im) = (U/U_B)·H·R̂ (Smith et al. 2006, eq. 22).
      const m0 = ms[0]!, rho0 = rhoOf(0);
      let G: C = [0, 0];
      if (bl) {
        const ub = bl.CT / (bl.CB + bl.CT), s0 = sig[0]![0];
        G = cmul([bl.H / ub, 0], cdiv([bl.CT, s0], [bl.CB + bl.CT, s0 * ub]));
      }
      const force = cmul([0, sig[0]![0]], [re[idx]!, im[idx]!]);
      A[0] = cdiv(force, csub(cadd([1, 0], rho0), cmul(G, cmul(cmul(I, m0), csub([1, 0], rho0)))));
      for (let j = 0; j < nL - 1; j++) {
        const top = cmul(cmul(A[j]!, cexp(cmul([0, d[j]!], ms[j]!))), cadd([1, 0], crit[j + 1] ? [0, 0] : q[j]!)); // ŵ at the top of layer j
        let wb: C;
        if (crit[j + 1]) {
          // Through the critical level: Ri from the stability and the shear of the wind along the wave.
          const K = Math.sqrt(K2), dz = (d[j]! + (Number.isFinite(d[j + 1]!) ? d[j + 1]! : d[j]!)) / 2;
          const shear = (sig[j + 1]![0] - sig[j]![0]) / K / dz, N2 = (layers[j]!.N ** 2 + layers[j + 1]!.N ** 2) / 2;
          const Ri = shear === 0 ? Infinity : N2 / (shear * shear);
          wb = cmul(top, [Math.exp(-Math.PI * Math.sqrt(Math.max(0, Ri - 0.25))), 0]);
        } else wb = cmul(top, cdiv(sig[j + 1]!, sig[j]!)); // displacement continuous
        A[j + 1] = cdiv(wb, cadd([1, 0], rhoOf(j + 1)));
      }
      for (let zi = 0; zi < zs.length; zi++) {
        const { j, zp } = layerOf[zi]!;
        let w = cmul(A[j]!, cexp(cmul([0, zp], ms[j]!)));
        if (j < nL - 1 && !crit[j + 1]) w = cadd(w, cmul(cmul(A[j]!, q[j]!), cexp(cmul([0, 2 * d[j]! - zp], ms[j]!))));
        out[zi]!.re[idx] = w[0];
        out[zi]!.im[idx] = w[1];
      }
    }
  return out.map((o2) => {
    fft2(o2.re, o2.im, nx, ny, true);
    return Float32Array.from(o2.re);
  });
}

/** A wave field ready to look up: data[level][row][col], rows south to north. */
export interface WaveFieldData {
  centerLatDeg: number;
  centerLonDeg: number;
  n: number;
  dx: number;
  /** Height of level 0 [m MSL] and the spacing of levels [m]. */
  z0M: number;
  dzM: number;
  levels: number;
  data: Float32Array;
}

/** Trilinear lookup in a wave field; undefined outside its untapered inner part. */
export function waveAt(f: WaveFieldData, latDeg: number, lonDeg: number, altM: number): number | undefined {
  const half = (f.n * f.dx) / 2, inner = half * 0.76;
  const ex = (lonDeg - f.centerLonDeg) * 111_320 * Math.cos((f.centerLatDeg * Math.PI) / 180), ny = (latDeg - f.centerLatDeg) * 111_132;
  if (Math.abs(ex) > inner || Math.abs(ny) > inner) return undefined;
  const fx = (ex + half) / f.dx - 0.5, fy = (ny + half) / f.dx - 0.5, fz = Math.max(0, Math.min(f.levels - 1, (altM - f.z0M) / f.dzM));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.min(f.levels - 2, Math.floor(fz));
  const tx = fx - x0, ty = fy - y0, tz = fz - z0, n = f.n, p = n * n;
  const v = (z: number, y: number, x: number) => f.data[z * p + y * n + x]!;
  const plane = (z: number) => (v(z, y0, x0) * (1 - tx) + v(z, y0, x0 + 1) * tx) * (1 - ty) + (v(z, y0 + 1, x0) * (1 - tx) + v(z, y0 + 1, x0 + 1) * tx) * ty;
  return f.levels === 1 ? plane(0) : plane(z0) * (1 - tz) + plane(z0 + 1) * tz;
}

export interface WaveFieldOptions extends WaveOptions {
  centerLatDeg: number;
  centerLonDeg: number;
  /** Terrain height [m] (undefined where unknown: the mean is used). */
  heightAt: (latDeg: number, lonDeg: number) => number | undefined;
  levels: SoundingLevel[];
  /** Grid size and spacing (default 256, 400 m) and the levels' top and spacing (default 7,000 m, 200 m). */
  n?: number;
  dx?: number;
  topM?: number;
  dzM?: number;
}

/** The wave field round a point for the day's levels, or undefined if the levels can't make one. */
export function buildWaveField(o: WaveFieldOptions): WaveFieldData | undefined {
  const n = o.n ?? 256, dx = o.dx ?? 400, half = (n * dx) / 2;
  const mLon = 111_320 * Math.cos((o.centerLatDeg * Math.PI) / 180);
  const h = new Float64Array(n * n);
  let sum = 0, cnt = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = o.heightAt(o.centerLatDeg + ((y + 0.5) * dx - half) / 111_132, o.centerLonDeg + ((x + 0.5) * dx - half) / mLon);
      h[y * n + x] = v ?? NaN;
      if (v !== undefined) (sum += v), cnt++;
    }
  if (!cnt) return undefined;
  const mean = sum / cnt;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const e = Math.min(x, y, n - 1 - x, n - 1 - y) / (0.12 * n), t = e >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * e);
      const v = h[y * n + x]!;
      h[y * n + x] = Number.isFinite(v) ? (v - mean) * t : 0;
    }
  const layers = waveLayers(o.levels, mean);
  if (layers.length < 2) return undefined;
  const dz = o.dzM ?? 200, top = o.topM ?? 7000, z0 = Math.ceil(mean / dz) * dz;
  const zs: number[] = [];
  for (let z = z0; z <= top; z += dz) zs.push(z - mean);
  const w = solveWaves(h, n, n, dx, layers, zs, o);
  const data = new Float32Array(zs.length * n * n);
  w.forEach((a, i) => data.set(a, i * n * n));
  return { centerLatDeg: o.centerLatDeg, centerLonDeg: o.centerLonDeg, n, dx, z0M: z0, dzM: dz, levels: zs.length, data };
}
