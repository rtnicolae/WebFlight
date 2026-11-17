/**
 * A roof's colour from the aerial photo: the pixels inside its footprint, kept clear of the
 * outline (the eaves, the street and the shadow next to it), without foliage (trees over
 * the roof, a garden where the outline is off), the darkest and brightest fifth dropped
 * (chimneys, skylights, the shaded slope's darkest strip), the rest averaged. A roof mostly
 * hidden under trees has none (the caller picks one).
 * With it the 3D roofs take the colours the photo shows round them, so a town far away looks
 * like the photo with its volume, not a speckle of palette colours on top of it.
 */
export interface Rgba {
  /** Width and height [px]; data: RGBA rows. */
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

const inside = (ring: [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/**
 * Mean colour [0–255] of the image inside a ring given in pixel coordinates, at least
 * `clearPx` from its outline (less when the roof is too small for that). Pixels with alpha 0
 * are missing (no photo). Undefined when no pixel centre falls inside, or the footprint runs
 * off the image.
 */
export function footprintColour(img: Rgba, ring: [number, number][], clearPx: number): [number, number, number] | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  if (x0 < 0 || y0 < 0 || x1 > img.w || y1 > img.h) return undefined;
  // Pixel centres inside, with their distance to the outline.
  const px: [number, number][] = [];
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (img.data[(y * img.w + x) * 4 + 3] === 0 || !inside(ring, cx, cy)) continue; // no photo there
      let d = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segDist(cx, cy, ring[j]![0], ring[j]![1], ring[i]![0], ring[i]![1]));
      px.push([y * img.w + x, d]);
    }
  if (!px.length) return undefined;
  // Clear of the outline if that leaves a few pixels; else the innermost half.
  let keep = px.filter(([, d]) => d >= clearPx);
  if (keep.length < 3) keep = px.sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.ceil(px.length / 2)));
  // Foliage: green the strongest channel by a margin (roofs in this imagery run olive-brown,
  // red above green, so they stay).
  const n0 = keep.length;
  keep = keep.filter(([i]) => !(img.data[i * 4 + 1]! >= img.data[i * 4]! + 6 && img.data[i * 4 + 1]! >= img.data[i * 4 + 2]! + 10));
  if (keep.length < Math.max(1, 0.35 * n0)) return undefined;
  const lum = keep.map(([i]) => [i, 0.3 * img.data[i * 4]! + 0.59 * img.data[i * 4 + 1]! + 0.11 * img.data[i * 4 + 2]!] as [number, number]).sort((a, b) => a[1] - b[1]);
  const cut = lum.length >= 5 ? Math.floor(lum.length / 5) : 0;
  const mid = lum.slice(cut, lum.length - cut);
  const sum = [0, 0, 0];
  for (const [i] of mid) for (let k = 0; k < 3; k++) sum[k]! += img.data[i * 4 + k]!;
  const c: [number, number, number] = [sum[0]! / mid.length, sum[1]! / mid.length, sum[2]! / mid.length];
  return c[1] > c[0] + 4 ? undefined : c; // still green: more garden than roof
}
