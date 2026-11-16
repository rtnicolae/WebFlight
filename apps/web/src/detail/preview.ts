/**
 * Dev preview of detail tiles (detail-preview.html): an n×n block around a point.
 * side=detail | s2 (plain Sentinel-2) | mix (checkerboard of both: shows seams).
 */
import { lonLatToTile } from "@webflight/environment";
import { openFreeMapTiles } from "../osm-source.ts";
import type { DetailRequest } from "./detail-worker.ts";

const S2 = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const p = new URLSearchParams(location.search);
const lat = Number(p.get("lat") ?? 45.68), lon = Number(p.get("lon") ?? 25.5), z = Number(p.get("z") ?? 16), n = Number(p.get("n") ?? 3);
const side = p.get("side") ?? "detail";
const grid = document.getElementById("grid")!;
grid.style.gridTemplateColumns = `repeat(${n}, 256px)`;
const [fx, fy] = lonLatToTile(lon, lat, z);
const x0 = Math.floor(fx) - (n >> 1), y0 = Math.floor(fy) - (n >> 1);
const osmUrl = (await openFreeMapTiles())!;
const w = new Worker(new URL("./detail-worker.ts", import.meta.url), { type: "module" });
let done = 0;
const canvases: HTMLCanvasElement[] = [];
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    grid.appendChild(c);
    canvases.push(c);
  }
w.onmessage = (ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
  const c = canvases[ev.data.id]!;
  if (ev.data.bitmap) {
    // Tiles come pre-flipped for Cesium: flip back for the canvas.
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, -1, 0, 256);
    g.drawImage(ev.data.bitmap, 0, 0);
  }
  else console.error(ev.data.error);
  if (++done === n * n) document.title = "done";
};
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const id = j * n + i, x = x0 + i, y = y0 + j;
    if (side === "s2" || (side === "mix" && (i + j) % 2 === 0)) {
      const d = z - 14, s = 2 ** d;
      void fetch(S2.replace("{z}", "14").replace("{x}", String(x >> d)).replace("{y}", String(y >> d)))
        .then((r) => r.blob())
        .then(createImageBitmap)
        .then((b) => {
          const ctx = canvases[id]!.getContext("2d")!;
          ctx.imageSmoothingQuality = "high";
          const src = 256 / s;
          ctx.drawImage(b, (x - (x >> d) * s) * src, (y - (y >> d) * s) * src, src, src, 0, 0, 256, 256);
          if (++done === n * n) document.title = "done";
        });
    } else w.postMessage({ id, x, y, z, s2Url: S2, osmUrl, texUrl: new URL(`${import.meta.env.BASE_URL}textures/`, location.href).href, sun: { azimuthDeg: 220, elevationDeg: 45 }, ...(p.get("night") ? { look: { ground: 0.16, night: 1 } } : {}) } satisfies DetailRequest);
  }
